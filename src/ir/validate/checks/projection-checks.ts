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

import type { BoundedContextIR, ExprIR, ProjectionIR, StmtIR } from "../../types/loom-ir.js";
import {
  isMaterializedProjection,
  isQueryTimeProjection,
  isShorthandProjection,
} from "../../types/loom-ir.js";
import { groupKeyColumn } from "../../util/projection-aggregate.js";
import { walkExprDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** The whole-table (keyless) aggregation vocabulary a singleton projection's
 *  `select` reaches for (read-path-architecture.md rev. 8).  Spelled bare
 *  (`select orders = count`) it lowers to an unknown ref, since there is no
 *  collection receiver to bind it to — which is exactly how it slips into the
 *  generated source as a free identifier.  Kept as a set so the diagnostic can
 *  say "this is the unimplemented aggregation" rather than "typo". */
const WHOLE_TABLE_AGGREGATIONS: ReadonlySet<string> = new Set([
  "count",
  "sum",
  "avg",
  "min",
  "max",
]);

/** First unresolved NAME anywhere in a `select` expression, or `null` when
 *  every name resolves.  Two shapes, because the aggregation vocabulary lowers
 *  to both: a bare `count` becomes `refKind: "unknown"`, while `sum(o.total)`
 *  becomes `callKind: "free"` — which the CallKind union documents as
 *  *"unresolved free call"*.  Either one is the precise condition that makes an
 *  emitter write an undeclared identifier, since every backend's query-time
 *  projection emitter renders the `select` expr verbatim into its row mapper
 *  with no further name resolution. */
function firstUnresolvedRefName(e: ExprIR): string | null {
  let found: string | null = null;
  walkExprDeep(e, (node) => {
    if (found) return;
    if (node.kind === "ref" && node.refKind === "unknown") found = node.name;
    else if (node.kind === "call" && node.callKind === "free") found = node.name;
  });
  return found;
}

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
  // A `select` expression must RESOLVE.  Every backend's query-time emitter
  // renders each `select` expr straight into the per-row projection mapper, so
  // an unresolved name reaches the generated source as a FREE IDENTIFIER —
  // `{ orders: count }` — which is a hard compile error on the typed backends
  // and `undefined` on the untyped ones, from a model that otherwise validates
  // clean.
  //
  // A recognised WHOLE-TABLE AGGREGATION is exempt here: lowering normalises it
  // into `select.aggregate` (a disciplined shape a ported emitter consumes), so
  // it is a real feature rather than a bad name.  Whether the HOSTING backend
  // has ported that emit is a deployable-level fact, so it is gated in
  // `validateWholeTableAggregationBackend` (system-checks.ts) instead — this
  // check has no platform in scope.  What is left here is the genuine typo.
  // MIXING an aggregation with a per-row `select` is a GROUP BY — one row per
  // distinct value of the per-row column, not one row for the table.  That is
  // the GROUPED read model (M-T4.2): declare it with an explicit `group by`
  // clause (validated in `validateGroupBy` below); the mix WITHOUT the clause
  // stays an error, now with the fix in the message.
  const selects = q.selects ?? [];
  const aggregating = selects.filter((s) => s.aggregate);
  const grouped = (q.groupBy?.length ?? 0) > 0;
  if (!grouped && aggregating.length > 0 && aggregating.length < selects.length) {
    const perRow = selects.filter((s) => !s.aggregate).map((s) => s.field);
    diags.push({
      severity: "error",
      code: "loom.projection-groupby-missing",
      message:
        `projection '${proj.name}' mixes aggregation ` +
        `(${aggregating.map((s) => s.field).join(", ")}) with per-row select(s) ` +
        `(${perRow.join(", ")}). That is a GROUP BY — one row per distinct ` +
        `${perRow.join("/")} — so declare the grouping: add ` +
        `'group by ${perRow.map((f) => `<source>.${f}`).join(", ")}' before the ` +
        `'select'. Or aggregate ALL fields (a single-row total), or select all ` +
        `of them per-row.`,
      source: `${ctx.name}/${proj.name}`,
    });
  }
  if (grouped) validateGroupBy(ctx, proj, diags);
  for (const s of selects) {
    if (s.aggregate) continue;
    const unresolved = firstUnresolvedRefName(s.expr);
    if (!unresolved) continue;
    const hint = WHOLE_TABLE_AGGREGATIONS.has(unresolved)
      ? ` (a whole-table '${unresolved}' needs the aggregated column — write ` +
        `'${unresolved}(<alias>.<field>)', or bare 'count' to count rows)`
      : "";
    diags.push({
      severity: "error",
      code: "loom.projection-select-unresolved",
      message:
        `projection '${proj.name}': 'select ${s.field} = …' references '${unresolved}', which ` +
        `resolves to nothing — not a field of the '${q.source}' source, not a 'join' alias, ` +
        `not a parameter${hint}. It would be emitted as an undeclared identifier.`,
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

/** The GROUPED read model's shape gates (M-T4.2).  A `group by` projection
 *  returns MANY rows — one per distinct value of the grouping columns — with
 *  the aggregate `select`s computed per group in SQL.  These checks pin the
 *  disciplined shape `groupedAggregates` (projection-aggregate.ts) hands every
 *  backend, so an emitter never guesses:
 *
 *   - `loom.projection-groupby-source-unsupported` — grouping needs a plain
 *     AGGREGATE `from` source (the table the SQL groups over); no source,
 *     a workflow / projection source, or event folds are all rejected.
 *   - `loom.projection-groupby-keyed-unsupported` — a grouped projection's
 *     rows are the groups, not id-keyed entities; `keyed by` doesn't apply.
 *   - `loom.projection-groupby-join-unsupported` — a `join` is an app-level
 *     bulk load AFTER the query, so its columns can't participate in a SQL
 *     GROUP BY.
 *   - `loom.projection-groupby-no-aggregate` — a `group by` whose selects
 *     aggregate nothing is just DISTINCT; not the grouped read model.
 *   - `loom.projection-groupby-key-not-columnar` — every grouping column must
 *     be a bare source column (`o.status`) so it pushes down to SQL; computed
 *     keys (`o.placedAt.date`) are a later refinement.
 *   - `loom.projection-groupby-select-not-grouped` — a per-row `select` must
 *     name one of the grouping columns; anything else has no single value per
 *     group (the same rule SQL enforces). */
function validateGroupBy(ctx: BoundedContextIR, proj: ProjectionIR, diags: LoomDiagnostic[]): void {
  const q = proj.query;
  if (!q?.groupBy || q.groupBy.length === 0) return;
  const at = `${ctx.name}/${proj.name}`;

  if (!q.source || q.sourceKind === "workflow" || q.sourceKind === "projection") {
    const why = q.source
      ? `its 'from ${q.source}' source is a ${q.sourceKind}`
      : "it has no 'from' source";
    diags.push({
      severity: "error",
      code: "loom.projection-groupby-source-unsupported",
      message:
        `projection '${proj.name}' declares 'group by', but ${why}. A grouped ` +
        `projection reads (and groups) an AGGREGATE source's table in SQL — ` +
        `add 'from <Aggregate>'.`,
      source: at,
    });
    return;
  }
  if (proj.handlers.length > 0) {
    // `from` + folds is already `loom.projection-query-and-fold-unsupported`;
    // nothing more to say here.
    return;
  }
  if (proj.correlationField !== undefined) {
    diags.push({
      severity: "error",
      code: "loom.projection-groupby-keyed-unsupported",
      message:
        `projection '${proj.name}' declares both 'keyed by ${proj.correlationField}' and ` +
        `'group by'. A grouped projection's rows ARE the groups (one per distinct ` +
        `key combination), not id-keyed entities — drop the 'keyed by'.`,
      source: at,
    });
  }
  if (q.joins.length > 0) {
    diags.push({
      severity: "error",
      code: "loom.projection-groupby-join-unsupported",
      message:
        `projection '${proj.name}': 'join' and 'group by' don't compose — a join is a ` +
        `by-id bulk load AFTER the query, so its columns can't participate in the SQL ` +
        `GROUP BY. Group by source columns only, or drop the 'group by'.`,
      source: at,
    });
  }
  const selects = q.selects ?? [];
  if (!selects.some((s) => s.aggregate)) {
    diags.push({
      severity: "error",
      code: "loom.projection-groupby-no-aggregate",
      message:
        `projection '${proj.name}' declares 'group by' but no aggregate 'select' ` +
        `(count/sum/avg/min/max) to compute per group — that is just DISTINCT. Add an ` +
        `aggregate select (e.g. 'orders = count()'), or drop the 'group by' for the ` +
        `per-row read.`,
      source: at,
    });
  }
  // Grouping columns must be bare source columns, so every backend can render
  // them into the SQL GROUP BY (and the deterministic ORDER BY) directly.
  const keyColumns = new Set<string>();
  for (const g of q.groupBy) {
    const col = groupKeyColumn(g);
    if (col === null) {
      diags.push({
        severity: "error",
        code: "loom.projection-groupby-key-not-columnar",
        message:
          `projection '${proj.name}': a 'group by' column must be a plain field of the ` +
          `'${q.source}' source (e.g. '<alias>.<field>') so it can be grouped in SQL — ` +
          `a computed grouping key is not supported yet.`,
        source: at,
      });
    } else {
      keyColumns.add(col);
    }
  }
  // Each per-row select must project one of the grouping columns — one value
  // per group.  (An aggregate select is per-group by construction.)
  for (const s of selects) {
    if (s.aggregate) continue;
    const col = groupKeyColumn(s.expr);
    if (col === null || !keyColumns.has(col)) {
      diags.push({
        severity: "error",
        code: "loom.projection-groupby-select-not-grouped",
        message:
          `projection '${proj.name}': 'select ${s.field} = …' is per-row but not one of the ` +
          `'group by' columns, so it has no single value per group. Select a grouping ` +
          `column directly, aggregate it (sum/min/max/…), or add it to the 'group by'.`,
        source: at,
      });
    }
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
