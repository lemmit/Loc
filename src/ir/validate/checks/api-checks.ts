// -------------------------------------------------------------------------
// Application- + transport-layer checks (unfoldable-api-derivation.md,
// Layers 3-4).  These gate the explicit `commandHandler` / `queryHandler`
// context members and the `route <METHOD> <PATH> -> <Context>.<Handler>`
// api-body bindings.  All three need the resolved / enriched IR
// (savesAtExit derivation + cross-context handler lookup), so they live at
// the IR-validate altitude rather than the AST-side validators.
// -------------------------------------------------------------------------

import type {
  BoundedContextIR,
  CommandHandlerIR,
  EnrichedLoomModel,
  QueryHandlerIR,
  WorkflowStmtIR,
} from "../../types/loom-ir.js";
import { allContexts } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** Visit every workflow statement in `stmts`, descending into the nested
 *  bodies of `for-each` / `if-let` so a mutation buried in a branch is seen. */
function forEachStmtDeep(stmts: WorkflowStmtIR[], fn: (s: WorkflowStmtIR) => void): void {
  for (const s of stmts) {
    fn(s);
    if (s.kind === "for-each") forEachStmtDeep(s.body, fn);
    else if (s.kind === "if-let") {
      forEachStmtDeep(s.thenBody, fn);
      forEachStmtDeep(s.elseBody ?? [], fn);
    }
  }
}

/** True when a handler body performs any mutation — a save (an aggregate
 *  dirty at exit), an aggregate op-call, a factory create, an emitted event, a
 *  mutating domain-service call, or an own-state assignment. */
function handlerMutates(h: CommandHandlerIR | QueryHandlerIR): boolean {
  if (h.savesAtExit.length > 0) return true;
  let mutates = false;
  forEachStmtDeep(h.statements, (s) => {
    if (
      s.kind === "emit" ||
      s.kind === "factory-let" ||
      s.kind === "op-call" ||
      s.kind === "assign" ||
      s.kind === "domain-service-call"
    ) {
      mutates = true;
    }
  });
  return mutates;
}

/** The distinct set of aggregates a handler body touches — every aggregate it
 *  loads, creates, mutates, or iterates.  A `commandHandler` may touch at most
 *  one (else it must be a `workflow`). */
function aggregatesTouched(h: CommandHandlerIR | QueryHandlerIR): Set<string> {
  const aggs = new Set<string>();
  for (const s of h.savesAtExit) aggs.add(s.aggName);
  forEachStmtDeep(h.statements, (s) => {
    switch (s.kind) {
      case "factory-let":
      case "repo-let":
      case "repo-run":
      case "op-call":
      case "if-let":
        aggs.add(s.aggName);
        break;
      case "for-each":
        aggs.add(s.varAggName);
        break;
    }
  });
  aggs.delete("");
  return aggs;
}

/** Per-context: the layering contracts on the two explicit handler kinds
 *  (unfoldable-api-derivation.md, Layer 3 — "why three handler kinds"):
 *    - `loom.query-handler-saves` — a `queryHandler` must not mutate/save.
 *    - `loom.command-handler-multi-aggregate` — a `commandHandler` may touch
 *      only ONE aggregate; a cross-aggregate orchestration must be a workflow.
 *    - `loom.handler-param-reserved-id` — a handler parameter may not be named
 *      `id`: in Loom's expression scope a bare `id` always means "the current
 *      entity's id", so a body reference to an `id` param silently resolves to
 *      the implicit instead (e.g. `getById(id)` lowers to a `this`-prop read),
 *      emitting code that references an id that isn't in scope. Rename the param
 *      (e.g. `orderId`).
 */
export function validateApplicationHandlers(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  const handlerKinds: [readonly (CommandHandlerIR | QueryHandlerIR)[], string][] = [
    [ctx.commandHandlers ?? [], "commandHandler"],
    [ctx.queryHandlers ?? [], "queryHandler"],
  ];
  for (const [handlers, kind] of handlerKinds) {
    for (const h of handlers) {
      for (const p of h.params) {
        if (p.name === "id") {
          diags.push({
            severity: "error",
            code: "loom.handler-param-reserved-id",
            message:
              `context '${ctx.name}': ${kind} '${h.name}' has a parameter named 'id', which is ` +
              `reserved — a bare 'id' in a handler body resolves to the current entity's implicit id, ` +
              `not the parameter. Rename it (e.g. 'orderId').`,
            source: `${ctx.name}/${h.name}`,
          });
        }
      }
    }
  }
  for (const q of ctx.queryHandlers ?? []) {
    if (handlerMutates(q)) {
      diags.push({
        severity: "error",
        code: "loom.query-handler-saves",
        message:
          `context '${ctx.name}': queryHandler '${q.name}' mutates state (a save, op-call, emit, ` +
          `create, or assignment). A queryHandler must be read-only — use a commandHandler or a ` +
          `workflow for anything that writes.`,
        source: `${ctx.name}/${q.name}`,
      });
    }
  }
  for (const c of ctx.commandHandlers ?? []) {
    const touched = aggregatesTouched(c);
    if (touched.size > 1) {
      diags.push({
        severity: "error",
        code: "loom.command-handler-multi-aggregate",
        message:
          `context '${ctx.name}': commandHandler '${c.name}' touches ${touched.size} aggregates ` +
          `(${[...touched].sort().join(", ")}). A commandHandler orchestrates a single aggregate — ` +
          `a cross-aggregate orchestration must be a workflow.`,
        source: `${ctx.name}/${c.name}`,
      });
    }
  }
}

/** Whole-model: every `route` target must resolve to a `commandHandler`,
 *  `queryHandler`, or workflow `handle` member in the named context
 *  (`loom.route-handler-unresolved`).  The route's `target.context` is a real
 *  Langium cross-ref (already resolved), but the `handler` segment is a plain
 *  name the linker doesn't chase, so it's checked here. */
export function validateRoutes(loom: EnrichedLoomModel, diags: LoomDiagnostic[]): void {
  const ctxByName = new Map<string, BoundedContextIR>();
  for (const c of allContexts(loom)) ctxByName.set(c.name, c);
  for (const sys of loom.systems) {
    for (const api of sys.apis) {
      for (const route of api.routes ?? []) {
        const label = `${route.method} ${route.path}`;
        const ctx = ctxByName.get(route.target.context);
        if (!ctx) {
          diags.push({
            severity: "error",
            code: "loom.route-handler-unresolved",
            message:
              `api '${api.name}': route '${label}' targets context '${route.target.context}', ` +
              `which is not a bounded context in this model.`,
            source: `${sys.name}/${api.name}`,
          });
          continue;
        }
        const handlerNames = new Set<string>([
          ...(ctx.commandHandlers ?? []).map((h) => h.name),
          ...(ctx.queryHandlers ?? []).map((h) => h.name),
          ...ctx.workflows.flatMap((w) => (w.handlers ?? []).map((h) => h.name)),
        ]);
        if (!handlerNames.has(route.target.handler)) {
          diags.push({
            severity: "error",
            code: "loom.route-handler-unresolved",
            message:
              `api '${api.name}': route '${label}' targets '${route.target.context}.${route.target.handler}', ` +
              `but context '${route.target.context}' has no commandHandler, queryHandler, or workflow handle ` +
              `named '${route.target.handler}'.`,
            source: `${sys.name}/${api.name}`,
          });
        }
      }
    }
  }
}
