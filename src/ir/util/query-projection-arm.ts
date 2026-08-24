// ---------------------------------------------------------------------------
// Which SHAPE a query-time projection reads through — and whether the source
// it reads has the COLUMNS that shape's SQL would have to name.
//
// A query-time projection (`projection X { from … }`, no `on(e)` folds) has
// five emission shapes, and every backend's projection emitter branches on the
// same five.  Two of them read the SOURCE AGGREGATE'S TABLE DIRECTLY — the
// whole-table aggregation (`select total = count()`) and the grouped
// aggregation (`group by …`) — because materialising rows to produce one
// integer is the scaling failure the shape exists to avoid.  The other three
// read through something that already knows how to hydrate a row: the
// aggregate's own repository, the workflow's saga-state store, or a folded
// projection's read-model store.
//
// That split is what the column-less gate keys off, and it is NOT adapter-
// specific.  A direct-table arm names columns on EVERY backend — drizzle's
// `sum(schema.orders.total)`, EF's `g.Sum(o => o.Total)`, JPQL's
// `sum(e.total)`, SQLAlchemy's `func.sum(OrderRow.total)`, Ecto's
// `sum(record.total)`, Dapper's raw `SUM("total")`.  An aggregate whose fields
// are not columns has nothing for any of those to reach:
//
//   * `persistedAs: eventLog` — no state table at all, only `<ctx>_events`;
//   * `shape: document`       — one `(id, data, version)` triple, the declared
//                               fields live inside the `data` jsonb blob;
//   * TPC abstract base       — no table of its own, one per concrete leaf.
//
// The gate was originally written as a Dapper-only boundary (M-T6.25) on the
// premise that "EF Core hides that difference behind its own JSON translation".
// That premise was false: Loom maps a document-shaped aggregate to a hand-
// rolled `<Agg>Document` row type, so EF's `o.Total` is a `CS1061`, drizzle's
// `schema.orders.total` a `TS2339`, and the event-sourced case does not even
// have a `DbSet`/table to name.  All five backends miscompiled silently; the
// gate is therefore universal.
//
// The classifier lives at IR level because BOTH halves need it and they may not
// import each other: `ir/validate` raises the diagnostic, `generator/dotnet`
// picks the emission arm.  Two copies would drift, and the failure mode of
// drift here is exactly the silent miscompile the gate exists to prevent.
//
// A DOCUMENT source keeps its `id` column, so `select n = count()` survives the
// column gate above — and genuinely runs on four of the five backends.  Two
// narrower questions about that surviving case are answered here too, by
// `documentAggregationSource` + `unappliedCapabilityFilters` below:
//
//   * are there CAPABILITY FILTERS the aggregation would have to apply?  Those
//     name `tenant_id` / `is_deleted`, which a `(id, data, version)` table does
//     not have — four backends emit the missing reference and EF Core emits NO
//     filter at all, counting every tenant's rows
//     (`loom.projection-document-source-capability-filtered`);
//   * can this BACKEND reach a document table for an aggregation at all?  Java
//     cannot — its JPQL needs a JPA entity a document aggregate never gets, so
//     the two already-registered per-backend aggregation codes
//     (`loom.projection-whole-table-aggregation-unsupported` /
//     `loom.projection-groupby-unsupported-backend`) refuse it through their
//     `#document` message variants.
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ExprIR,
  ProjectionIR,
  ProjectionQueryIR,
  SystemIR,
} from "../types/loom-ir.js";
import { groupedAggregates, wholeTableAggregates } from "./projection-aggregate.js";
import { effectiveSavingShape, resolveDataSourceConfig } from "./resolve-datasource.js";
import { walkExprDeep } from "./walk.js";

/** The emission shape a query-time projection takes.  The order of the checks
 *  mirrors every backend's `renderHandler`: grouped wins over singleton (a
 *  grouped projection mixes key and aggregate selects), and both win over the
 *  source-kind arms. */
export type QueryProjectionArm =
  /** `group by …` — one row per key combination, aggregated in SQL. */
  | "grouped"
  /** every `select` aggregates, no `group by` — ONE row, no rows materialised. */
  | "singleton"
  /** `from <Workflow>` — reads the persisted saga-state rows. */
  | "workflow"
  /** `from <OtherProjection>` — reads a folded projection's read-model rows. */
  | "projection"
  /** `from <Aggregate>` — reads through the aggregate's repository. */
  | "repository";

export function queryProjectionArm(p: ProjectionIR): QueryProjectionArm {
  if (groupedAggregates(p)) return "grouped";
  if (wholeTableAggregates(p)) return "singleton";
  if (p.query?.sourceKind === "workflow") return "workflow";
  if (p.query?.sourceKind === "projection") return "projection";
  return "repository";
}

/** True for the two arms that SELECT over the source aggregate's own table
 *  rather than going through its repository — the arms whose SQL names
 *  columns. */
export function readsAggregateTableDirectly(arm: QueryProjectionArm): boolean {
  return arm === "grouped" || arm === "singleton";
}

/** Every single-hop member name the direct-table SQL will have to name as a
 *  COLUMN on the source row: the `where` predicate, the `group by` keys, the
 *  aggregated columns (`sum(o.total)`), and — on the grouped arm — the per-row
 *  selects, which validation has already pinned to the grouping columns.
 *
 *  Deliberately name-only and receiver-blind.  Every backend's direct-table
 *  renderer treats a member access in these positions as a bare column
 *  (`<alias>."<snake(member)>"`), so the set of names it can emit is exactly
 *  the set of member names reachable here; narrowing by receiver would make the
 *  gate disagree with the emitter it is protecting. */
function directTableColumnRefs(q: ProjectionQueryIR): string[] {
  const names: string[] = [];
  const collect = (e: ExprIR | undefined): void => {
    walkExprDeep(e, (n) => {
      if (n.kind === "member") names.push(n.member);
    });
  };
  collect(q.filter);
  for (const key of q.groupBy ?? []) collect(key);
  for (const sel of q.selects ?? []) collect(sel.aggregate ? sel.aggregate.arg : sel.expr);
  return names;
}

/** Why NO backend can render this query-time projection's direct-table SQL over
 *  its source, or `null` when every backend can.  The string is the `reason`
 *  half of `loom.projection-columnless-source`, so it reads as the tail of
 *  "…, which …".
 *
 *  Only the direct-table arms can fail: the repository / saga-state /
 *  read-model arms read a store the backend itself emitted and hydrate a row
 *  through it, so the fields never have to BE columns. */
export function columnlessProjectionSource(
  proj: ProjectionIR,
  ctx: BoundedContextIR,
  /** The hosting system, when there is one.  A top-level context has none, and
   *  then the aggregate header's own `shape:` is the effective one — the same
   *  fallback `effectiveSavingShape` applies to an unbound aggregate. */
  sys: SystemIR | undefined,
): string | null {
  if (!readsAggregateTableDirectly(queryProjectionArm(proj))) return null;
  const source = proj.query?.source;
  const agg = ctx.aggregates.find((a) => a.name === source) as EnrichedAggregateIR | undefined;
  if (!agg) return null;
  if (agg.persistedAs === "eventLog") {
    return (
      `aggregates over event-sourced aggregate '${source}', which has no state table to ` +
      `aggregate in SQL (its truth is the event stream)`
    );
  }
  if (agg.isAbstract && agg.inheritanceUsing === "ownTable") {
    return (
      `aggregates over TPC ('inheritanceUsing: ownTable') abstract base '${source}', which has ` +
      `no table of its own — each concrete is a separate table`
    );
  }
  const shape = effectiveSavingShape(agg, sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined);
  if (shape === "document") {
    // A document table is the `(id, data, version)` triple and nothing else
    // (`documentTableForAggregate`, src/system/migrations-builder.ts), so `id`
    // is the ONE member a direct-table arm may name.  `select n = count()`
    // over a document source is therefore fine on every backend and must stay
    // that way — it is the row-count tile `scaffoldDashboard` emits.
    const offending = directTableColumnRefs(proj.query!).filter((n) => n !== "id");
    if (offending.length > 0) {
      return (
        `names '${offending[0]}' on 'shape: document' aggregate '${source}', whose declared ` +
        `fields live inside one jsonb blob rather than as columns a SQL aggregate can name`
      );
    }
  }
  return null;
}

/** The source aggregate a direct-table (aggregating) query-time projection
 *  reads through, when that source is DOCUMENT-shaped — `undefined` for every
 *  other arm/shape combination.
 *
 *  The one place the "is this the direct-table-over-a-jsonb-blob case" question
 *  is answered, so the two gates built on it below cannot disagree with each
 *  other or with `columnlessProjectionSource` above about which arm is in play. */
export function documentAggregationSource(
  proj: ProjectionIR,
  ctx: BoundedContextIR,
  sys: SystemIR | undefined,
): EnrichedAggregateIR | undefined {
  if (!readsAggregateTableDirectly(queryProjectionArm(proj))) return undefined;
  const agg = ctx.aggregates.find((a) => a.name === proj.query?.source) as
    | EnrichedAggregateIR
    | undefined;
  if (!agg) return undefined;
  const shape = effectiveSavingShape(agg, sys ? resolveDataSourceConfig(agg, ctx, sys) : undefined);
  return shape === "document" ? agg : undefined;
}

/** Human labels for the CAPABILITY filters a direct-table aggregation over
 *  `agg` would have to apply, after the projection's own `ignoring` bypass has
 *  dropped the ones it waives — deduplicated, in declaration order.  Empty when
 *  there is nothing left to apply, which is the "not gated" answer.
 *
 *  A predicate with no `contextFilterOrigins` entry is anonymous (a bare
 *  context-level `filter`, or a derived tenancy scope): `ignoring <Cap>` cannot
 *  name it, so it can never be bypassed, and it is labelled by the aggregate it
 *  is declared on rather than dropped — it still has to be applied, and the
 *  author still has to be told which read is unsafe.
 *
 *  Mirrors the triage every backend's aggregation emitter runs
 *  (`aggregationScope` in java's `query-projection-reads.ts`, its four twins
 *  elsewhere), so a projection that genuinely needs NO filter — `ignoring *`,
 *  or an aggregate with no filtering capability at all — is not gated. */
export function unappliedCapabilityFilters(proj: ProjectionIR, agg: EnrichedAggregateIR): string[] {
  const q = proj.query;
  if (q?.bypassAll) return [];
  const bypassed = new Set(q?.bypassCaps ?? []);
  const origins = agg.contextFilterOrigins ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  (agg.contextFilters ?? []).forEach((_pred, i) => {
    const origin = origins[i];
    if (origin !== undefined && bypassed.has(origin)) return;
    const label = origin === undefined ? `a 'filter' on '${agg.name}'` : `'${origin}'`;
    if (seen.has(label)) return;
    seen.add(label);
    out.push(label);
  });
  return out;
}
