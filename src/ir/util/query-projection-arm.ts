// ---------------------------------------------------------------------------
// Which SHAPE a query-time projection reads through — and, for the .NET Dapper
// adapter, whether that shape is expressible as raw Postgres SQL.
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
// That split is what the Dapper gate keys off.  Dapper writes its own SQL, so
// a direct-table arm names COLUMNS — and an aggregate whose fields do not
// exist as columns (a `shape: document` blob, an event-sourced stream with no
// state table at all) has nothing for `sum(total)` to reach.  EF Core hides
// that difference behind its own JSON translation; Dapper cannot, so it is the
// one honest remaining boundary on this adapter (M-T6.25).
//
// The classifier lives at IR level because BOTH halves need it and they may not
// import each other: `ir/validate` raises the diagnostic, `generator/dotnet`
// picks the emission arm.  Two copies would drift, and the failure mode of
// drift here is exactly the silent miscompile the gate exists to prevent.
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  ProjectionIR,
  SystemIR,
} from "../types/loom-ir.js";
import { groupedAggregates, wholeTableAggregates } from "./projection-aggregate.js";
import { effectiveSavingShape, resolveDataSourceConfig } from "./resolve-datasource.js";

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

/** Why the Dapper adapter cannot render this query-time projection as raw SQL,
 *  or `null` when it can.  The string is the `reason` half of
 *  `loom.dapper-unsupported`, so it reads as the tail of "…, which …".
 *
 *  Only the direct-table arms can fail: the repository / saga-state /
 *  read-model arms read a store Dapper itself emitted, whose columns it
 *  therefore knows. */
export function dapperQueryProjectionGap(
  proj: ProjectionIR,
  ctx: BoundedContextIR,
  sys: SystemIR,
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
  if (effectiveSavingShape(agg, resolveDataSourceConfig(agg, ctx, sys)) === "document") {
    return (
      `aggregates over 'shape: document' aggregate '${source}', whose fields live inside one ` +
      `jsonb blob rather than as columns a SQL aggregate can name`
    );
  }
  if (agg.isAbstract && agg.inheritanceUsing === "ownTable") {
    return (
      `aggregates over TPC ('inheritanceUsing: ownTable') abstract base '${source}', which has ` +
      `no table of its own — each concrete is a separate table`
    );
  }
  return null;
}
