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
  AggregateIR,
  BoundedContextIR,
  DataSourceIR,
  DataSourceKind,
  EnrichedAggregateIR,
  IsolationLevel,
  SavingShape,
  SystemIR,
  WorkflowIR,
} from "../types/loom-ir.js";

/** The dataSource kind an aggregate's truth kind reads from.  Identity:
 *  `persistedAs(…)` values are the `kind` names (default `state`). */
export function dataSourceKindForAggregate(agg: EnrichedAggregateIR): DataSourceKind {
  return agg.persistedAs ?? "state";
}

/** True when the aggregate's primary truth is its event stream
 *  (`persistedAs(eventLog)`).  Parallel to {@link dataSourceKindForAggregate}
 *  (the `state` default means anything not `eventLog` is stateful) but takes a
 *  bare `AggregateIR` so backend index gates can call it before enrichment.
 *
 *  The append-only `<agg>_events` `(stream_id, version)` PRIMARY KEY IS that
 *  aggregate's optimistic-concurrency control: two concurrent `save`s that both
 *  read `max(version)=N` and both insert `version=N+1` race, and the loser hits
 *  a Postgres unique-violation (SQLSTATE 23505).  Each backend maps that to
 *  409 Conflict — the event-sourced sibling of the `versioned` capability's
 *  guarded write (`aggregateIsVersioned`), so `hasVersioned || hasEventSourced`
 *  is the widened gate for the shared `ConcurrencyError` + 409 machinery. */
export function aggregateIsEventSourced(agg: AggregateIR): boolean {
  return agg.persistedAs === "eventLog";
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
 *  backend emitter (EF Core ToTable, Drizzle pgSchema, Ecto
 *  schema-prefix) should consume — not the raw `DataSourceIR`.
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
  /** Saving shape of this binding (D-DOCUMENT-AXIS, the `shape:` knob).
   *  When set, overrides the aggregate header's `shape(…)` for this
   *  projection (see {@link effectiveSavingShape}).  Carried verbatim
   *  from the binding here; the header fallback is applied by
   *  {@link effectiveSavingShape}, not folded in, so callers can tell
   *  "binding said X" from "binding silent". */
  shape?: SavingShape;
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
    shape: ds.shape,
  };
}

/** Effective saving shape for an aggregate's primary read model.
 *
 *  Per-projection resolution (D-DOCUMENT-AXIS §8 Q4): the binding's
 *  `shape:` governs *that* projection; the aggregate header's `shape(…)`
 *  is the default; absent everywhere ⇒ `relational`.
 *
 *  Pure; `resolved` may be `undefined` (no binding declared) — the
 *  header still decides, so an aggregate can be `shape(document)`
 *  without an explicit dataSource. */
export function effectiveSavingShape(
  agg: EnrichedAggregateIR,
  resolved?: Pick<ResolvedDataSource, "shape">,
): SavingShape {
  return resolved?.shape ?? agg.savingShape ?? "relational";
}

/** Convenience predicate — true when the effective shape is the opaque
 *  whole-aggregate JSON document (`shape(document)`, Marten-style).
 *  Kept as a thin derivation over {@link effectiveSavingShape} so the
 *  existing document-emit call sites read naturally. */
export function isDocumentShaped(
  agg: EnrichedAggregateIR,
  resolved?: Pick<ResolvedDataSource, "shape">,
): boolean {
  return effectiveSavingShape(agg, resolved) === "document";
}

/** Convenience predicate — true when the effective shape is the queryable
 *  root row whose containments / reference-collections fold into JSONB
 *  columns (`shape(embedded)`).  Thin derivation over
 *  {@link effectiveSavingShape}, mirroring {@link isDocumentShaped}. */
export function isEmbeddedShaped(
  agg: EnrichedAggregateIR,
  resolved?: Pick<ResolvedDataSource, "shape">,
): boolean {
  return effectiveSavingShape(agg, resolved) === "embedded";
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
