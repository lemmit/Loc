// -------------------------------------------------------------------------
// Projection checks (projection.md) — the read-model fold contract.
//
// A `projection <Name> keyed by <field>` folds FOREIGN events into a derived,
// queryable read model.  It is the passive read-half of an event-sourced
// workflow, so its handlers carry the same PURE-fold discipline as an
// aggregate/workflow `apply(...)`:
//
//   - `keyed by X` must name a declared, id-shaped state field.
//   - every subscribed event must be routable to the key (carry the key field,
//     or supply an explicit `by <expr>`).
//   - one handler per event type.
//   - fold bodies are pure: assignments / derivations only — no `emit`, no
//     repository / operation calls, no guards.  A handler that must read a repo
//     is a reactor, not a projection.
//
// Grammar makes `keyed by` mandatory, so a missing key is a parse error, not a
// check here.
// -------------------------------------------------------------------------

import type { BoundedContextIR, ProjectionIR, StmtIR } from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

export function validateProjections(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const proj of ctx.projections) {
    validateKey(ctx, proj, diags);
    validateHandlers(ctx, proj, diags);
  }
}

function validateKey(ctx: BoundedContextIR, proj: ProjectionIR, diags: LoomDiagnostic[]): void {
  const keyField = proj.stateFields.find((f) => f.name === proj.correlationField);
  if (!keyField) {
    diags.push({
      severity: "error",
      code: "loom.projection-key-unknown",
      message:
        `projection '${proj.name}' is keyed by '${proj.correlationField}', ` +
        `which is not a declared state field.  Declare it as an id-shaped field, ` +
        `e.g. '${proj.correlationField}: <Aggregate> id'.`,
      source: `${ctx.name}/${proj.name}`,
    });
    return;
  }
  if (keyField.type.kind !== "id") {
    diags.push({
      severity: "error",
      code: "loom.projection-key-not-id",
      message:
        `projection '${proj.name}' is keyed by '${proj.correlationField}', ` +
        `which is not id-shaped.  A projection's routing key must be an 'id' field ` +
        `(the row's primary key), e.g. '${proj.correlationField}: <Aggregate> id'.`,
      source: `${ctx.name}/${proj.name}`,
    });
  }
}

function validateHandlers(
  ctx: BoundedContextIR,
  proj: ProjectionIR,
  diags: LoomDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const h of proj.handlers) {
    if (seen.has(h.event)) {
      diags.push({
        severity: "error",
        code: "loom.projection-duplicate-on",
        message:
          `projection '${proj.name}' declares more than one 'on(${h.param}: ${h.event})' handler. ` +
          `Fold each event type in a single handler.`,
        source: `${ctx.name}/${proj.name}`,
      });
    }
    seen.add(h.event);

    // Routability: with no explicit `by`, the event must carry the key field
    // by name so the runtime can route by `e.<key>`.
    if (!h.correlation) {
      const event = ctx.events.find((e) => e.name === h.event);
      const carriesKey = event?.fields.some((f) => f.name === proj.correlationField);
      if (event && !carriesKey) {
        diags.push({
          severity: "error",
          code: "loom.projection-event-unkeyed",
          message:
            `projection '${proj.name}' folds '${h.event}', but that event has no ` +
            `'${proj.correlationField}' field to route by.  Add the field to the event, ` +
            `or supply an explicit 'by <expr>' that extracts the key from '${h.param}'.`,
          source: `${ctx.name}/${proj.name}`,
        });
      }
    }

    // Fold purity — the projection/reactor boundary (reuses the applier
    // discipline).  A handler that emits or calls out is a reactor, not a
    // projection (a derived read model must be replayable).
    for (const stmt of h.statements) {
      const impurity = foldImpurity(stmt);
      if (impurity) {
        diags.push({
          severity: "error",
          code: "loom.projection-fold-impure",
          message:
            `projection '${proj.name}' fold 'on(${h.param}: ${h.event})' ${impurity}. ` +
            `A projection fold must be a pure, replayable function of the event — ` +
            `assignments and 'let' only.  To read a repository or emit, use a reactor ` +
            `('on(e: Event)' in a workflow) instead.`,
          source: `${ctx.name}/${proj.name}`,
        });
      }
    }
  }
}

/** The impurity phrase for a fold statement, or `undefined` when it is a pure
 *  fold statement (assign / add / remove / let / derivation). */
function foldImpurity(stmt: StmtIR): string | undefined {
  switch (stmt.kind) {
    case "emit":
      return "emits an event";
    case "call":
      return `calls '${(stmt as { name?: string }).name ?? "out"}'`;
    case "precondition":
    case "requires":
      return `contains a '${stmt.kind}' guard`;
    default:
      return undefined;
  }
}
