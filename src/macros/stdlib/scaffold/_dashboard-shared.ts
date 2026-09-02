// ---------------------------------------------------------------------------
// Shared derivation between the two halves of the dashboard scaffold.
//
// `scaffoldDashboard` (a `context` macro) emits the singleton projections; the
// ui-side scaffold renders a `Stat` card per field.  A macro attaches to
// exactly ONE host (`MacroTarget`, define.ts), so the projection and the page
// cannot come from one macro — the same split `scaffoldPaged` /
// `scaffoldPagedApi` already uses, and the same defence: both sides derive the
// name here, so a card can never bind a projection the other half didn't emit.
// ---------------------------------------------------------------------------

import type { Aggregate, BoundedContext, Projection } from "../../../language/generated/ast.js";
import { isBoundedContext, isProjection, isProperty } from "../../../language/generated/ast.js";

/** Whether this aggregate can carry a dashboard at all — the precondition for
 *  every tile, since all of them are direct-table aggregations computed in SQL.
 *
 *  THREE shapes are excluded, and each is a shape some phase-⑦ gate refuses:
 *
 *  - an `abstract` base owns no table (its concretes each have their own) and
 *    an event-sourced aggregate has none either (its truth is the `<ctx>_events`
 *    stream) — both refused by `loom.projection-columnless-source`;
 *  - a `shape: document` aggregate persists as `(id, data, version)`, so the
 *    only tile it could ever carry is the ROW COUNT (`count(*)` over the `id`
 *    column; every per-field sum and the per-day series name keys inside the
 *    jsonb blob, which `loom.projection-columnless-source` refuses).  That lone
 *    tile is NOT worth what it costs:
 *
 *      * the moment the aggregate carries a read-filtering capability
 *        (`tenantOwned`, `softDeletable`, any `filter`) the tile is refused by
 *        `loom.projection-document-source-capability-filtered` — and BEFORE
 *        that gate existed it was a silent cross-tenant leak on EF Core, which
 *        registers no `HasQueryFilter` for a document aggregate;
 *      * on `platform: java` it is refused outright by
 *        `loom.projection-whole-table-aggregation-unsupported` (and its grouped
 *        twin `loom.projection-groupby-unsupported-backend`), because a document
 *        aggregate has no JPA entity for the JPQL to name.
 *
 *    A scaffold whose default output fails `ddd parse` on a supported backend
 *    is worse than one tile short, so the document case is skipped in the macro
 *    rather than gated after it.  A row count over a document aggregate is
 *    still perfectly writable BY HAND on the four backends that emit it — this
 *    only decides what the scaffold claims unasked. */
export function hasDashboardTable(agg: Aggregate): boolean {
  return !agg.isAbstract && agg.persistedAs !== "eventLog" && fieldsAreColumns(agg);
}

/** Whether the aggregate's DECLARED FIELDS are columns.  A `shape: document`
 *  aggregate persists as `(id, data, version)`; its fields live inside the
 *  jsonb blob, so nothing but `id` is nameable in a direct-table aggregation.
 *
 *  Header-visible only: a dataSource binding may override `shape:` at the system
 *  level, which phase ② cannot see.  That residual is caught honestly by the IR
 *  gate rather than miscompiled. */
export function fieldsAreColumns(agg: Aggregate): boolean {
  return agg.shape !== "document";
}

/** The projection name the dashboard scaffold uses for an aggregate.
 *  `Order` → `OrderTotals`. */
export function dashboardProjectionName(aggName: string): string {
  return `${aggName}Totals`;
}

/** The per-day SERIES projection name.  `Order` → `OrderPerDay`. */
export function dashboardSeriesName(aggName: string): string {
  return `${aggName}PerDay`;
}

/** The series row's two fields — the day bucket and that day's row count. */
export const SERIES_DAY = "day";
export const SERIES_COUNT = "rowCount";

/** The `datetime` column the per-day series groups on, or `null` when the
 *  aggregate has none — in which case there is no series and no chart tile.
 *
 *  `createdAt` wins when present (the "created per day" the mission asks for);
 *  otherwise the FIRST non-optional datetime
 *  property stands in, so an aggregate modelling its own timestamp
 *  (`placedAt`, `occurredAt`) still charts.
 *
 *  ORDERING CAVEAT: a `createdAt` contributed by the `auditable` CAPABILITY is
 *  only visible once that capability has expanded, and macro expansion is
 *  source order — so an `aggregate X with auditable` may reach this function
 *  before its stamp exists and fall back to a declared datetime.  The series is
 *  still correct (it groups on a real column); only WHICH column can vary.  A
 *  declared `createdAt` is deterministic.
 *
 *  Optional columns are excluded for
 *  the same reason `summableFields` excludes them: NULL rows would vanish from
 *  the series while still counting in the `rowCount` tile beside it. */
export function seriesDateField(agg: Aggregate): string | null {
  if (!fieldsAreColumns(agg)) return null;
  const datetimes: string[] = [];
  for (const m of agg.members) {
    if (!isProperty(m)) continue;
    const t = m.type;
    if (!t || t.array || t.optional) continue;
    const base = t.base;
    if (base?.$type !== "PrimitiveType" || base.name !== "datetime") continue;
    if (m.name === "createdAt") return m.name;
    datetimes.push(m.name);
  }
  return datetimes[0] ?? null;
}

/** The per-day series a dashboard chart tile binds for `agg`, or `null`.
 *  The series twin of `dashboardFieldsFor`, answering the same two ways for
 *  the same reason (expansion order is source order, so neither half may
 *  assume the other ran). */
export function dashboardSeriesFor(agg: Aggregate): { projection: string } | null {
  const ctx = agg.$container;
  if (!isBoundedContext(ctx)) return null;
  if (!hasDashboardTable(agg)) return null;
  const name = dashboardSeriesName(agg.name);
  const declared = ctx.members.find((m): m is Projection => isProjection(m) && m.name === name);
  if (declared) {
    // Only a GROUPED projection is a series — a singleton is one row and has
    // nothing to plot along an axis.
    return declared.groupBys.length > 0 && declared.source ? { projection: name } : null;
  }
  if (!contextScaffoldsDashboard(ctx)) return null;
  return seriesDateField(agg) ? { projection: name } : null;
}

/** The KPI fields a dashboard card row shows for `agg`, or `null` when the
 *  aggregate has no dashboard projection to read.
 *
 *  TWO ways to find one, because macro expansion order is source order
 *  (`streamAllContents`, expander.ts) and therefore not something either half
 *  may rely on:
 *
 *    1. A projection ALREADY PRESENT in the context — always true for a
 *       hand-written one (it is authored source), and true for the scaffolded
 *       one whenever the context precedes the ui, which is the normal layout.
 *       Structural, so a hand-written projection lights up the dashboard too.
 *    2. Failing that, the context carrying `with scaffoldDashboard` — the
 *       clause is in the AST regardless of who has expanded yet, which closes
 *       the ordering hole for a ui declared before its context.
 *
 *  Both paths derive the same name, so the card and the projection agree. */
export function dashboardFieldsFor(
  agg: Aggregate,
): { projection: string; fields: string[] } | null {
  const ctx = agg.$container;
  if (!isBoundedContext(ctx)) return null;
  if (!hasDashboardTable(agg)) return null;
  const name = dashboardProjectionName(agg.name);
  const declared = ctx.members.find((m): m is Projection => isProjection(m) && m.name === name);
  if (declared) {
    // Only a SINGLETON query-time projection returns one row, which is what a
    // KPI card binds.  A keyed one returns a list.
    if (declared.key || !declared.source) return null;
    return { projection: name, fields: declared.members.filter(isProperty).map((p) => p.name) };
  }
  if (!contextScaffoldsDashboard(ctx)) return null;
  // The context will emit it; derive the field list the same way the macro
  // does, from the aggregate itself.
  return { projection: name, fields: scaffoldedFieldNames(agg) };
}

/** Whether the context opted into `with scaffoldDashboard`. */
function contextScaffoldsDashboard(ctx: BoundedContext): boolean {
  return (ctx.withClause?.calls ?? []).some((c) => c.name === "scaffoldDashboard");
}

/** The field names `scaffoldDashboard` emits for an aggregate — the row count
 *  plus one sum per summable field.  Kept beside the macro's own derivation so
 *  the two can only drift by an edit that touches this file. */
function scaffoldedFieldNames(agg: Aggregate): string[] {
  return [ROW_COUNT, ...summableFieldNames(agg).map((f) => `${f}Sum`)];
}

/** The row-count field.  Named `rowCount`, not `count`: a field named after the
 *  operator that fills it reads as `select count = count()`, and shadows the
 *  operator name inside the projection's own scope. */
export const ROW_COUNT = "rowCount";

/** The source alias every emitted projection binds — `from <Agg> as o`. */
export const ALIAS = "o";

/** Fields worth summing on a dashboard: the numeric ones.  A `money` total is
 *  the canonical KPI; `int`/`long`/`decimal` are the other honest sums.
 *  Everything else (strings, enums, dates, ids, collections) has no meaningful
 *  whole-table sum, so it contributes no tile rather than a nonsense one. */
export type Summable = "money" | "int" | "long" | "decimal";
const SUMMABLE: ReadonlySet<string> = new Set<Summable>(["money", "int", "long", "decimal"]);

export function summableFields(agg: Aggregate): Array<{ name: string; primitive: Summable }> {
  if (!fieldsAreColumns(agg)) return [];
  const out: Array<{ name: string; primitive: Summable }> = [];
  for (const m of agg.members) {
    if (!isProperty(m)) continue;
    const t = m.type;
    // A `TypeRef` wraps the atom: `array`/`optional` live on the ref, the
    // primitive name on its `base`.  Only a BARE primitive sums.
    //
    // The optional exclusion is deliberate, not an oversight: SQL `SUM` skips
    // NULLs, so a nullable column's tile would silently describe a subset of
    // the rows the `rowCount` beside it reports — two numbers on one card that
    // quietly disagree about which rows they cover.
    if (!t || t.array || t.optional) continue;
    const base = t.base;
    if (base?.$type !== "PrimitiveType") continue;
    if (!SUMMABLE.has(base.name)) continue;
    out.push({ name: m.name, primitive: base.name as Summable });
  }
  return out;
}

function summableFieldNames(agg: Aggregate): string[] {
  return summableFields(agg).map((f) => f.name);
}
