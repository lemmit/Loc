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
    // Keyed projections name a routing key; a SINGLETON (no `keyed by`) has no
    // key to validate — its `correlationField` is undefined (the singleton
    // discriminant).
    if (proj.correlationField !== undefined) validateKey(ctx, proj, diags);
    validateHandlers(ctx, proj, diags);
    validateQueryComprehension(ctx, proj, diags);
  }
}

/** The query-time comprehension gates (read-path-architecture.md rev.13).  The
 *  generalised `projection` surface (grammar + IR + lowering) lands here ahead
 *  of the per-backend query-time emit, so a query-time / `join` projection is
 *  parsed, lowered, and validated — but HONESTLY REJECTED until a backend ports
 *  the emit (PR-C onward), rather than silently mis-emitted by the folded path.
 *
 *   - `loom.projection-query-and-fold-unsupported` — a `from` source AND
 *     `on(e)` folds together (a seed-then-update read model) is a RESERVED
 *     combo (proposal § "Exotic combos are deferred behind gates").
 *   - `loom.projection-query-time-unsupported` — the HONEST not-yet-emitted
 *     gate: any comprehension clause (`from`/`where`/`join`/`select`) is
 *     surface+IR-complete but has no backend emitter yet.  Lifted per backend
 *     as each ports the query-time projection emitter.  (The `order by` clause, the
 *     groupby / singleton-whole-table-aggregation / paged-sort refinements land
 *     WITH that emit, where they first become reachable.)
 */
function validateQueryComprehension(
  ctx: BoundedContextIR,
  proj: ProjectionIR,
  diags: LoomDiagnostic[],
): void {
  const q = proj.query;
  if (!q) return;
  if (q.source && proj.handlers.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-query-and-fold-unsupported",
      message:
        `projection '${proj.name}' declares both a 'from ${q.source}' query source ` +
        `and 'on(e)' event folds. A query source and event folds together ` +
        `(seed-then-update) is a reserved combination — use EITHER a query-time ` +
        `projection ('from … select …') OR a folded one ('on(e) { … }'), not both.`,
      source: `${ctx.name}/${proj.name}`,
    });
  }
  // The HONEST "not yet emitted on this backend" gate
  // (`loom.projection-query-time-unsupported`) is a SYSTEM-level check
  // (`validateQueryTimeProjectionBackend`), keyed on the target deployable's
  // platform — node emits it (PR-C), the other backends still error — mirroring
  // `validatePagedQueryHandlerBackend`.  It can't live here because a
  // context-level check has no deployable/platform in scope.
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
