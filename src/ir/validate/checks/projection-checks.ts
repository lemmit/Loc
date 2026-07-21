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
import {
  isMaterializedProjection,
  isQueryTimeProjection,
  isShorthandProjection,
} from "../../types/loom-ir.js";
import type { LoomDiagnostic } from "./diagnostic.js";

export function validateProjections(ctx: BoundedContextIR, diags: LoomDiagnostic[]): void {
  for (const proj of ctx.projections) {
    // Keyed projections name a routing key; a SINGLETON (no `keyed by`) has no
    // key to validate — its `correlationField` is undefined (the singleton
    // discriminant).
    if (proj.correlationField !== undefined) validateKey(ctx, proj, diags);
    validateHandlers(ctx, proj, diags);
    validateQueryComprehension(ctx, proj, diags);
    validateWorkflowSource(ctx, proj, diags);
    validateProjectionSource(ctx, proj, diags);
  }
}

/** Workflow-source query-time projection gates (the projection twin of the
 *  removed workflow-source view; workflow-instance-views.md).  A projection
 *  `from <Workflow>` reads the workflow's persisted instance rows
 *  (`instanceWireShape`) at query time.  Option A: NON-event-sourced (saga-state
 *  table) sources with `where`/`select` only.
 *
 *   - `loom.projection-workflow-source-not-observable` — the workflow has no
 *     readable instance state (no id-shaped correlation field).
 *   - `loom.projection-workflow-source-eventsourced-unsupported` — an
 *     event-sourced workflow source (its instances are a per-request fold, no
 *     state table); the emit path for it is deferred (honest gate).
 *   - `loom.projection-workflow-source-join-unsupported` — a `join` follow over
 *     a workflow source (by-id follows are aggregate-rooted).
 *   - `loom.projection-workflow-source-ignoring-unsupported` — an `ignoring`
 *     bypass over a workflow source (a workflow has no capability query-filters
 *     to bypass). */
function validateWorkflowSource(
  ctx: BoundedContextIR,
  proj: ProjectionIR,
  diags: LoomDiagnostic[],
): void {
  const q = proj.query;
  if (q?.sourceKind !== "workflow" || !q.source) return;
  const at = `${ctx.name}/${proj.name}`;
  const wf = ctx.workflows.find((w) => w.name === q.source);
  if (!wf) return; // an unresolved source is reported elsewhere.
  if (!wf.instanceWireShape) {
    diags.push({
      severity: "error",
      code: "loom.projection-workflow-source-not-observable",
      message:
        `projection '${proj.name}': workflow '${wf.name}' has no observable instance state ` +
        "(it needs a single id-shaped correlation/state field), so it can't be a projection source.",
      source: at,
    });
    return;
  }
  if (wf.eventSourced) {
    diags.push({
      severity: "error",
      code: "loom.projection-workflow-source-eventsourced-unsupported",
      message:
        `projection '${proj.name}': workflow '${wf.name}' is event-sourced, whose instances are a ` +
        "per-request fold of its event stream (no state table). A projection over an event-sourced " +
        "workflow source is not emitted yet — source it from a state-backed (non-event-sourced) " +
        "workflow, or fold the events into a keyed 'projection' instead.",
      source: at,
    });
  }
  if (q.joins.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-workflow-source-join-unsupported",
      message:
        `projection '${proj.name}': a 'join' follow over a workflow source is not supported ` +
        "(by-id joins resolve an aggregate's identity, not a workflow instance). Read the " +
        "workflow's instance fields directly in 'select', or source the projection from an aggregate.",
      source: at,
    });
  }
  if (q.bypassAll || (q.bypassCaps?.length ?? 0) > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-workflow-source-ignoring-unsupported",
      message:
        `projection '${proj.name}': an 'ignoring' capability-filter bypass over a workflow source ` +
        "has no effect — a workflow instance read carries no capability query-filters. Remove the " +
        "'ignoring' clause.",
      source: at,
    });
  }
}

/** Projection-source query-time projection gates (the projection twin of the
 *  removed projection-source view; projection.md v1.1).  A projection
 *  `from <OtherProjection>` reads the source projection's persisted `<Proj>Row`
 *  read-model table at query time, with `where`/`select` only.
 *
 *   - `loom.projection-source-not-materialized` — the source projection is
 *     itself query-time (a live read with NO row table), so there is nothing to
 *     read from. Source it from a folded (`on(e)`) projection, or from the
 *     aggregate directly.
 *   - `loom.projection-source-self` — a projection sourcing itself (`from` its
 *     own name) is a cycle.
 *   - `loom.projection-source-join-unsupported` — a `join` follow over a
 *     projection source (by-id follows are aggregate-rooted).
 *   - `loom.projection-source-ignoring-unsupported` — an `ignoring` bypass over
 *     a projection source (a read-model row carries no capability query-filters). */
function validateProjectionSource(
  ctx: BoundedContextIR,
  proj: ProjectionIR,
  diags: LoomDiagnostic[],
): void {
  const q = proj.query;
  if (q?.sourceKind !== "projection" || !q.source) return;
  const at = `${ctx.name}/${proj.name}`;
  if (q.source === proj.name) {
    diags.push({
      severity: "error",
      code: "loom.projection-source-self",
      message: `projection '${proj.name}': a projection cannot source itself ('from ${proj.name}').`,
      source: at,
    });
    return;
  }
  const src = ctx.projections.find((p) => p.name === q.source);
  if (!src) return; // an unresolved source is reported elsewhere.
  if (!isMaterializedProjection(src)) {
    diags.push({
      severity: "error",
      code: "loom.projection-source-not-materialized",
      message:
        `projection '${proj.name}': source projection '${src.name}' is query-time (a live read with ` +
        "no persisted read-model table), so there is nothing to read `from`. Source it from a folded " +
        "('on(e) { … }') projection, or from the underlying aggregate directly.",
      source: at,
    });
    return;
  }
  if (q.joins.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-source-join-unsupported",
      message:
        `projection '${proj.name}': a 'join' follow over a projection source is not supported ` +
        "(by-id joins resolve an aggregate's identity, not a read-model row). Read the source row's " +
        "fields directly in 'select', or source the projection from an aggregate.",
      source: at,
    });
  }
  if (q.bypassAll || (q.bypassCaps?.length ?? 0) > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-source-ignoring-unsupported",
      message:
        `projection '${proj.name}': an 'ignoring' capability-filter bypass over a projection source ` +
        "has no effect — a read-model row read carries no capability query-filters. Remove the " +
        "'ignoring' clause.",
      source: at,
    });
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
  // Row-fill discipline for a query-time projection (read-path-architecture.md
  // rev.13).  A `select` fills the declared row; its absence has two legal /
  // illegal shapes:
  //   - SHORTHAND (no declared fields + no `select`): the row IS the source's
  //     own wire shape — supported for an AGGREGATE source only (the `view X = A
  //     where P` replacement).  A workflow / projection shorthand source is
  //     gated: its wire shape is served by the native instance / read-model read
  //     already, so require an explicit `select`.
  //   - DECLARED FIELDS but no `select`: the fields would never be filled (an
  //     empty row).  Rejected — add a `select` (or drop the fields for shorthand).
  if (isQueryTimeProjection(proj) && (q.selects?.length ?? 0) === 0) {
    if (isShorthandProjection(proj)) {
      if (q.sourceKind === "workflow" || q.sourceKind === "projection") {
        diags.push({
          severity: "error",
          code: "loom.projection-shorthand-nonaggregate",
          message:
            `projection '${proj.name}': the shorthand (select-less) form is supported for an ` +
            `AGGREGATE source only; source '${q.source}' is a ${q.sourceKind}. Add an explicit ` +
            `'select' (its rows are already served directly by the ${q.sourceKind}'s own read).`,
          source: `${ctx.name}/${proj.name}`,
        });
      }
    } else {
      diags.push({
        severity: "error",
        code: "loom.projection-fields-without-select",
        message:
          `projection '${proj.name}' declares row fields but no 'select' to fill them, so every ` +
          `row would be empty. Add a 'select <field> = <expr>, …', or drop the fields for the ` +
          `shorthand form (the row then mirrors the '${q.source}' source's wire shape).`,
        source: `${ctx.name}/${proj.name}`,
      });
    }
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
