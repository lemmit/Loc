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

import { snake } from "../../util/naming.js";
import type {
  BoundedContextIR,
  DataSourceIR,
  DataSourceKind,
  EnrichedAggregateIR,
  IsolationLevel,
  SystemIR,
  WorkflowIR,
} from "../types/loom-ir.js";

/** The dataSource kind an aggregate's truth kind reads from.  Identity:
 *  `persistedAs(…)` values are the `kind` names (default `state`). */
export function dataSourceKindForAggregate(agg: EnrichedAggregateIR): DataSourceKind {
  return agg.persistedAs ?? "state";
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

/** Per-aggregate dataSource config after implicit defaults are folded
 *  in.  Returned by {@link resolveDataSourceConfig}; this is what every
 *  backend emitter (EF Core ToTable, Drizzle pgSchema, AshPostgres
 *  postgres-block) should consume — not the raw `DataSourceIR`.
 *
 *  The defaulting rule that matters:
 *    - `schema:` omitted → defaults to `snake(context.name)`.  A
 *      bounded context lands in its own Postgres schema by default;
 *      explicit `schema: "..."` overrides for legacy-database mapping. */
export interface ResolvedDataSource {
  name: string;
  kind: DataSourceKind;
  /** Effective Postgres schema — never `undefined` when this
   *  configuration is returned at all.  Either the DSL `schema:` value
   *  verbatim, or `snake(context.name)` when DSL omitted it. */
  schema: string;
  tablePrefix?: string;
  /** Saving shape of this binding (D-DOCUMENT-AXIS, the `normalised:`
   *  knob).  `false` ⇒ the projection is one JSON document; omitted ⇒
   *  the aggregate header's `normalised(…)` supplies the default (see
   *  {@link isDocumentShaped}).  Carried verbatim from the binding here;
   *  the header fallback is applied by `isDocumentShaped`, not folded in
   *  here, so callers can tell "binding said true" from "binding silent". */
  normalised?: boolean;
}

/** Resolve the aggregate's dataSource and fold in implicit defaults.
 *  Returns `undefined` when no dataSource matches the (context, kind)
 *  pair — emitters fall back to their pre-dataSource default shape
 *  (no schema qualifier).  When a binding exists, `.schema` is always
 *  populated: either from DSL or defaulted to the snake-cased context
 *  name. */
export function resolveDataSourceConfig(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  sys: SystemIR,
): ResolvedDataSource | undefined {
  const ds = resolveDataSourceForAggregate(agg, ctx, sys);
  if (!ds) return undefined;
  return {
    name: ds.name,
    kind: ds.kind,
    schema: ds.schema ?? snake(ctx.name),
    tablePrefix: ds.tablePrefix,
    normalised: ds.normalised,
  };
}

/** Effective saving shape for an aggregate's primary read model.
 *
 *  Per-projection resolution (D-DOCUMENT-AXIS §8 Q4): the binding's
 *  `normalised:` governs *that* projection; the aggregate header's
 *  `normalised(…)` is the default; absent everywhere ⇒ `true`
 *  (relational).  Returns `true` when the effective shape is one JSON
 *  document — i.e. `normalised(false)`.
 *
 *  Pure; `resolved` may be `undefined` (no binding declared) — the
 *  header still decides, so an aggregate can be `normalised(false)`
 *  without an explicit dataSource. */
export function isDocumentShaped(
  agg: EnrichedAggregateIR,
  resolved?: Pick<ResolvedDataSource, "normalised">,
): boolean {
  const effective = resolved?.normalised ?? agg.normalised ?? true;
  return effective === false;
}

/** Resolve the effective transaction isolation level for a workflow.
 *
 *  The DSL has two surfaces that can set isolation:
 *    1. `workflow.transactional(<level>)` — per-workflow override
 *    2. `dataSource X { for: ctx, kind: state, isolationLevel: <level> }`
 *       — per-context default for any transactional workflow in `ctx`
 *
 *  Resolution:
 *    - Workflow-level wins outright.
 *    - Otherwise, the state-kind dataSource for the workflow's context
 *      provides the default.
 *    - Otherwise, undefined — backend opens a transaction without an
 *      explicit level (connection default applies).
 *
 *  Only meaningful when `wf.transactional` is true; a non-transactional
 *  workflow never opens a transaction, so isolation is moot.  Callers
 *  should gate on `wf.transactional` themselves. */
export function resolveWorkflowIsolation(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  sys: SystemIR,
): IsolationLevel | undefined {
  if (wf.isolation) return wf.isolation;
  const ds = sys.dataSources.find((d) => d.contextName === ctx.name && d.kind === "state");
  return ds?.isolationLevel;
}
