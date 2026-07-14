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
      s.kind === "repo-delete" ||
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
      case "repo-delete":
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
    // An extern handler has no DSL body to analyse — its implementation lives in
    // a scaffold-once user file — so the body-mutation gate doesn't apply.
    if (q.extern) continue;
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
    // Extern: no DSL body, so the single-aggregate gate has nothing to count.
    if (c.extern) continue;
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

/** HTTP methods that denote a READ position — a route that only retrieves.
 *  Loom's `HttpMethod` grammar admits GET|POST|PUT|PATCH|DELETE, so GET is the
 *  sole read verb.  A read route may reach the repository's read-only face only;
 *  binding it to a writing handler is the transport-level twin of the
 *  `reading`-tier `loom.domain-service-no-repo-write` gate
 *  (read-path-architecture.md, "The read-only setting" →
 *  `loom.read-context-repo-write`). */
const READ_ROUTE_METHODS = new Set(["GET"]);

/** Whole-model: every `route` target must resolve to a `commandHandler`,
 *  `queryHandler`, or workflow `handle` member in the named context
 *  (`loom.route-handler-unresolved`).  The route's `target.context` is a real
 *  Langium cross-ref (already resolved), but the `handler` segment is a plain
 *  name the linker doesn't chase, so it's checked here.
 *
 *  Also gates `loom.read-context-repo-write` (read-path-architecture.md): a
 *  READ-method route (GET/HEAD) may not target a handler on the WRITE face — a
 *  mutating `commandHandler` or a workflow `handle`.  This generalises the
 *  shipped `reading`-tier read-only setting (`domain-service-no-repo-write`) and
 *  the `queryHandler` read-only gate (`query-handler-saves`) to the remaining
 *  read position — the api read route — so a read structurally cannot save. */
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
          continue;
        }
        // `loom.read-context-repo-write` — a READ-method route may only reach the
        // read-only face (a `queryHandler`).  A mutating `commandHandler` or a
        // workflow `handle` is the WRITE face, so a GET/HEAD bound to one lets a
        // read save — exactly what the `reading`-tier gate forbids in a service
        // body, generalised here to the transport edge.
        if (READ_ROUTE_METHODS.has((route.method ?? "").toUpperCase())) {
          const cmd = (ctx.commandHandlers ?? []).find((h) => h.name === route.target.handler);
          const isWorkflowHandle = ctx.workflows.some((w) =>
            (w.handlers ?? []).some((h) => h.name === route.target.handler),
          );
          const writes = (cmd && !cmd.extern && handlerMutates(cmd)) || isWorkflowHandle;
          if (writes) {
            const targetKind = isWorkflowHandle ? "workflow handle" : "commandHandler";
            diags.push({
              severity: "error",
              code: "loom.read-context-repo-write",
              message:
                `api '${api.name}': route '${label}' is a read (${route.method}) but targets ` +
                `${targetKind} '${route.target.context}.${route.target.handler}', which writes. A read ` +
                `position (an api read route, a queryHandler, or a 'reading' service) may not reach the ` +
                `mutating repository face — bind the read to a queryHandler.`,
              source: `${sys.name}/${api.name}`,
            });
          }
        }
      }
    }
  }
}
