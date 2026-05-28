// ---------------------------------------------------------------------------
// Per-aggregate DataSource resolution.
//
// Each system declares `dataSource X { for: <ctx>, kind: <state |
// eventLog | snapshot | cache | replica>, use: <storage>, … }`.  The
// emit-time question is: given an aggregate, WHICH dataSource binding
// carries its per-(context, kind) config (schema, tablePrefix, ttl,
// every, retain, isolationLevel, readonly)?
//
// Rule:
//   - `stateBased`  aggregate → matching dataSource with `kind: state`
//   - `eventSourced` aggregate → matching dataSource with `kind: eventLog`
//   - aggregate without an explicit persistenceStrategy defaults to
//     `stateBased`.
//
// Returns `undefined` when no matching dataSource exists — the caller
// emits its existing default-shaped output (no schema, no prefix, …)
// so byte-identical behaviour holds for systems that haven't added
// any dataSource declarations.
// ---------------------------------------------------------------------------

import type {
  BoundedContextIR,
  DataSourceIR,
  DataSourceKind,
  EnrichedAggregateIR,
  SystemIR,
} from "../types/loom-ir.js";

/** The dataSource kind an aggregate's persistence strategy reads from. */
export function dataSourceKindForAggregate(agg: EnrichedAggregateIR): DataSourceKind {
  return agg.persistenceStrategy === "eventSourced" ? "eventLog" : "state";
}

/** Find the dataSource binding for an aggregate within its bounded
 *  context.  Returns `undefined` when:
 *    - the aggregate doesn't belong to the passed context, OR
 *    - no dataSource matches the (context, kind) pair.
 *
 *  Pure — does not consult the registry or any caches; the lookup is
 *  a single linear scan over `sys.dataSources`. */
export function resolveDataSourceForAggregate(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  sys: SystemIR,
): DataSourceIR | undefined {
  // Guard: the aggregate must actually belong to the passed context.
  // The orchestrator threads (agg, ctx) pairs from its own loop, but
  // we keep the guard so callers from elsewhere (validators,
  // upcoming style-adapter rewires) stay correct.
  if (!ctx.aggregates.some((a) => a.name === agg.name)) return undefined;
  const kind = dataSourceKindForAggregate(agg);
  return sys.dataSources.find((d) => d.contextName === ctx.name && d.kind === kind);
}
