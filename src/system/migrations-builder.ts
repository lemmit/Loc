import { renderSqlScalarExpr } from "../generator/sql-pg-expr.js";
import type {
  AggregateIR,
  AssociationIR,
  BackfillIntentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  EntityPartIR,
  FieldIR,
  IdValueType,
  ManualIndexIR,
  ProjectionIR,
  RenameIntentIR,
  SavingShape,
  SqlStepIR,
  SubdomainIR,
  SystemIR,
  TableRenameIntentIR,
  TypeIR,
  WorkflowIR,
} from "../ir/types/loom-ir.js";
import type {
  ColumnShape,
  ColumnType,
  FKShape,
  IndexShape,
  MigrationStep,
  MigrationsIR,
  SchemaSnapshot,
  TableShape,
} from "../ir/types/migrations-ir.js";
import { durableEventTypes } from "../ir/util/channels.js";
import { directParentOf } from "../ir/util/containment-parent.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../ir/util/inheritance.js";
import {
  effectiveSavingShape,
  resolveContextSchema,
  resolveDataSourceConfig,
  resolveDataSourceForAggregate,
} from "../ir/util/resolve-datasource.js";
import {
  isValueCollectionType,
  type ValueCollectionIR,
  valueCollectionsFor,
} from "../ir/util/value-collections.js";
import { aggregateIsVersioned } from "../ir/util/versioned-capability.js";
import { plural, snake, upperFirst } from "../util/naming.js";
import type { SnapshotStore } from "./snapshot.js";

// ---------------------------------------------------------------------------
// MigrationsIR builder + diff.
//
// `schemaFromModule` is the single source of truth for "what tables this
// module needs"; both the Phoenix refactor (was inline at
// `elixir/migrations-emit.ts`) and the new TS / .NET emitters
// read from it.  Backends never derive their own table list.
//
// `diffSchema` is a pure function from (prev, next) snapshots to an
// ordered op list.  Idempotent: same snapshot in ⇒ empty steps.
//
// `buildMigrations` wires the two together at system scope, one entry
// per owning module.
// ---------------------------------------------------------------------------

/** Canonical base timestamp — matches the legacy Phoenix initial-migration
 *  scheme so existing fixtures stay byte-stable across the refactor. */
export const BASE_TIMESTAMP = "20260101000000";

export function schemaFromModule(
  module: EnrichedSubdomainIR,
  /** Per-aggregate saving shape (D-DOCUMENT-AXIS).  Selects the table
   *  shape: `relational` (table-per-entity + join tables), `embedded`
   *  (queryable root row + one JSONB column per containment, no part
   *  tables), or `document` (the whole aggregate as one `(id, data,
   *  version)` blob).  Defaults to the aggregate-header value;
   *  `buildMigrations` passes a binding-aware resolver so a
   *  per-projection `dataSource shape:` override is honoured (the schema
   *  stays consistent with the EF/Drizzle/Ecto emitters, which resolve
   *  the same way via `effectiveSavingShape`). */
  shapeOf: (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR) => SavingShape = (agg) =>
    effectiveSavingShape(agg),
  /** Per-aggregate Postgres schema — the owning context's schema, from
   *  `resolveDataSourceConfig` (`buildMigrations` passes a binding-aware
   *  resolver; mirrors `shapeOf`).  Defaults to `() => undefined` so
   *  callers (and the many `schemaFromModule(module)` unit tests) that
   *  have no system to resolve against keep the legacy unqualified
   *  output.  Every table an aggregate produces is stamped with its
   *  schema.  The OWNING CONTEXT is passed in (not looked up by aggregate
   *  name) so two same-named aggregates in different contexts
   *  (`Sales.Order` / `Billing.Order`) each resolve their OWN schema
   *  instead of both collapsing onto the first name-match (audit
   *  finding 16). */
  schemaOf: (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR) => string | undefined = () =>
    undefined,
  /** Manual performance indexes for an aggregate — the `index: [...]` specs
   *  on its (context, state) storage binding (uniqueness-and-indexes.md §3.2).
   *  Each entry names its target entity + columns.  `buildMigrations` passes a
   *  binding-aware resolver; defaults to none so schema-only unit tests keep
   *  their legacy output.  Applied to the spec's explicitly-named entity table
   *  (aggregate root or contained part). */
  manualIndexesOf: (
    agg: EnrichedAggregateIR,
    ctx: EnrichedBoundedContextIR,
  ) => readonly ManualIndexIR[] = () => [],
  /** The owning context's Postgres schema — for context-owned tables that
   *  aren't tied to a single aggregate (a workflow's saga correlation-state /
   *  event-log table), so they land beside the context's aggregate tables
   *  instead of leaking to `public`.  `buildMigrations` passes
   *  `resolveContextSchema`; defaults to `() => undefined` so schema-only unit
   *  tests keep the legacy unqualified output.  Module/cross-context infra
   *  (outbox) is deliberately NOT stamped — it spans every context. */
  contextSchemaOf: (ctx: EnrichedBoundedContextIR) => string | undefined = () => undefined,
): SchemaSnapshot {
  const tables: TableShape[] = [];
  const aggPairs = collectAggregatePairs(module);
  const pool = aggPairs.map((p) => p.agg);
  // Owning context per aggregate INSTANCE (identity, not name) so the
  // shape / schema resolvers target the right binding for same-named
  // aggregates in sibling contexts.
  const ctxByAgg = new Map<EnrichedAggregateIR, EnrichedBoundedContextIR>();
  for (const { agg, ctx } of aggPairs) ctxByAgg.set(agg, ctx);
  const ctxFor = (agg: EnrichedAggregateIR): EnrichedBoundedContextIR => ctxByAgg.get(agg)!;
  // Value-object field list lookup (by VO name), so a value-object field
  // can be flattened into the parent table's columns — the standard DDD
  // destructure, matching the Drizzle / EF ORMs.  The migration builder
  // otherwise only sees a `TypeIR` and used to collapse a VO to one `json`
  // column, which the relational ORMs (flattened) then mismatched.
  const voLookup: VoLookup = new Map(
    module.contexts.flatMap((c) => c.valueObjects.map((v) => [v.name, v.fields] as const)),
  );
  // Produce the table(s) for one aggregate.  Returns an array so the
  // caller can stamp the schema uniformly — every table an aggregate
  // contributes lives in the same (context) schema.
  const tablesForOneAggregate = (agg: EnrichedAggregateIR): TableShape[] => {
    // An abstract base that is NOT a TPH base owns no table — a TPC
    // (`ownTable`) base emits nothing here (each concrete is standalone);
    // mirrors the schema emitter (emit/schema.ts).  The TPH base falls through
    // to `tphTableForAggregate` below.
    if (agg.isAbstract && !isTphBase(agg, pool)) return [];
    // TPH (aggregate-inheritance.md, sharedTable): the hierarchy is one
    // shared table named for the abstract base.  A TPH concrete shares it
    // (emits no table); the base emits the shared table (base columns + every
    // concrete's own columns made nullable + the `kind` discriminator) so the
    // runtime DDL matches the Drizzle schema (emit/schema.ts `emitTphTable`).
    if (isTphConcrete(agg, pool)) {
      // A TPH concrete emits no table of its own, but its contained parts
      // still need their tables — FK'd to the SHARED base table (Pattern 4),
      // mirroring emit/schema.ts.  `tableOwnerName` resolves the concrete to
      // its base; the part's `parentId` holds the shared-table row id.
      const owner = tableOwnerName(agg, pool);
      return agg.parts.map((part) => tableForPart(part, agg, module.name, voLookup, owner));
    }
    if (isTphBase(agg, pool)) {
      return [tphTableForAggregate(agg, pool, module.name, voLookup)];
    }
    // Event-sourced (`persistedAs(eventLog)`): no per-aggregate table — its
    // stream lives in the single per-context `<ctx>_events` log, emitted once in
    // the per-context pass below (event-log-architecture.md).  State is folded
    // from that stream (filtered by `stream_type`) at load time.
    if (agg.persistedAs === "eventLog") {
      return [];
    }
    const shape = shapeOf(agg, ctxFor(agg));
    if (shape === "document") {
      return [documentTableForAggregate(agg, module.name)];
    }
    if (shape === "embedded") {
      return [embeddedTableForAggregate(agg, module.name)];
    }
    const out: TableShape[] = [tableForAggregate(agg, module.name, voLookup)];
    for (const part of agg.parts) {
      out.push(tableForPart(part, agg, module.name, voLookup));
    }
    // Reference-collection fields (`Target id[]`) persist via a join
    // table rather than a column on the owner row — enrichment derives
    // one `AssociationIR` per such field, and the schema picks them up
    // here.  `tableForAggregate` / `tableForPart` skip the column at
    // emission time (see `mapField`).
    for (const assoc of agg.associations) {
      out.push(tableForAssociation(assoc, module.name));
    }
    // Value-object array fields (`charges: Money[]`) persist as an id-less
    // child table (flattened VO columns + parent FK + ordinal).  Relational
    // backends create it; Phoenix skips it (it stores the array inline as a
    // `{:array, :map}` column on the parent).
    for (const vc of valueCollectionsFor(agg)) {
      out.push(valueCollectionTableShape(vc, agg, module.name, voLookup));
    }
    for (const part of agg.parts) {
      for (const vc of valueCollectionsFor(part)) {
        out.push(valueCollectionTableShape(vc, agg, module.name, voLookup, part.name));
      }
    }
    return out;
  };

  for (const agg of pool) {
    const produced = withTenantIndex(agg, tablesForOneAggregate(agg));
    const schema = schemaOf(agg, ctxFor(agg));
    if (schema !== undefined) {
      for (const t of produced) t.schema = schema;
    }
    // Manual performance indexes (`resource index: [...]`): place each index
    // on its EXPLICITLY-named entity's table (an aggregate root or a contained
    // part).  A spec whose entity isn't one of this aggregate's tables belongs
    // to a sibling aggregate — skipped here, applied on its own iteration.
    applyManualIndexes(produced, manualIndexesOf(agg, ctxFor(agg)));
    tables.push(...produced);
  }
  // Persisted workflow-correlation state tables (workflow-and-applier.md A2-S2):
  // one per correlation-bearing workflow, keyed by its correlation field with
  // the saga state fields as columns.  Emitted in the (unqualified) public
  // schema, matching the plain `pgTable(...)` the Drizzle schema emitter uses
  // for these, so the runtime DDL and the ORM mapping line up.
  for (const ctx of module.contexts) {
    const durable = durableEventTypes(ctx).size > 0;
    // The workflow's saga tables are context-owned (a workflow belongs to a
    // context), so they live in that context's schema — beside its aggregate
    // tables — not in `public`, where two contexts each with a `Tracker`
    // workflow would collide on `tracker_events`.
    const ctxSchema = contextSchemaOf(ctx);
    // The single per-context event log (event-log-architecture.md): one
    // `<ctx>_events` table when the context has ANY event-sourced stream — a
    // `persistedAs(eventLog)` aggregate or an `eventSourced` workflow.  Every
    // such stream shares it, discriminated by `stream_type`.
    const hasEventStream =
      ctx.aggregates.some((a) => a.persistedAs === "eventLog") ||
      ctx.workflows.some((w) => w.eventSourced);
    if (hasEventStream) {
      const t = eventLogTableForStream(snake(ctx.name), module.name);
      if (ctxSchema !== undefined) t.schema = ctxSchema;
      tables.push(t);
    }
    for (const wf of ctx.workflows) {
      // An `eventSourced` workflow's stream lives in the shared `<ctx>_events`
      // log emitted above (folded on load, filtered by `stream_type`) — no
      // per-workflow table.  A plain correlation-bearing workflow keeps its
      // mutable state table.
      if (!wf.eventSourced && wf.correlationField) {
        const t = workflowStateTableShape(wf, module.name, voLookup, durable);
        if (ctxSchema !== undefined) t.schema = ctxSchema;
        tables.push(t);
      }
    }
    // Projection read models (projection.md): each folds foreign events into a
    // context-owned state table, keyed by its correlation column — the same
    // shape a plain correlation-bearing workflow persists.
    for (const proj of ctx.projections) {
      const t = projectionTableShape(proj, module.name, voLookup);
      if (ctxSchema !== undefined) t.schema = ctxSchema;
      tables.push(t);
    }
  }
  // Transactional outbox (dispatch-delivery-semantics.md): one shared table
  // when any context's channel asks for durability (`retention: log | work`).
  // The dispatcher records durable events here; the relay drains rows in
  // insert order (the serial id) through the in-process dispatcher.
  if (module.contexts.some((c) => durableEventTypes(c).size > 0)) {
    tables.push(outboxTableShape(module.name));
  }
  // The snapshot stays alphabetical (a stable, diff-friendly record);
  // `diffSchema` reorders the emitted `createTable` steps by FK
  // dependency so the SQL applies cleanly.
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, tables };
}

/** Persisted workflow-correlation state table (mirrors `tableForAggregate`):
 *  PK is the workflow's single id-shaped correlation field, the remaining
 *  state fields are saga columns mapped the same way an aggregate's fields are.
 *  Saga `X id` references are stored as plain columns without a foreign key —
 *  the workflow row is a standalone routing record, not a child of those
 *  aggregates, so it must not constrain their delete order. */
/** The transactional-outbox table (dispatch-delivery-semantics.md) — one per
 *  module whose contexts carry any durable channel (`retention: log | work`).
 *  Fixed shape; the relay drains undispatched rows ordered by `occurred_at`. */
function outboxTableShape(ownerModule: string): TableShape {
  return {
    name: "__loom_outbox",
    ownerModule,
    columns: [
      { name: "id", type: { kind: "uuid" }, nullable: false, default: "gen_random_uuid()" },
      { name: "occurred_at", type: { kind: "datetime" }, nullable: false, default: "now()" },
      { name: "type", type: { kind: "text" }, nullable: false },
      { name: "payload", type: { kind: "json" }, nullable: false },
      { name: "dispatched_at", type: { kind: "datetime" }, nullable: true },
      { name: "attempts", type: { kind: "int" }, nullable: false, default: "0" },
    ],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
  };
}

function workflowStateTableShape(
  wf: WorkflowIR,
  ownerModule: string,
  voLookup: VoLookup,
  /** Idempotent-consumer marker (dispatch-delivery-semantics.md §3): a
   *  durable channel adds `last_event_id` so handlers can no-op on the
   *  relay's at-least-once redelivery. */
  durable = false,
): TableShape {
  const tableName = plural(snake(wf.name));
  const corr = wf.correlationField as string;
  const columns: ColumnShape[] = [];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr) {
      const vt = f.type.kind === "id" ? f.type.valueType : "guid";
      columns.push({ name: snake(f.name), type: idColumnType(vt), nullable: false });
      continue;
    }
    if (isReferenceCollection(f.type)) {
      columns.push({ name: snake(f.name), type: { kind: "json" }, nullable: !!f.optional });
      continue;
    }
    for (const mapped of columnsForField(f, voLookup, wf.name)) {
      columns.push(mapped.column);
    }
  }
  if (durable) {
    columns.push({ name: "last_event_id", type: { kind: "text" }, nullable: true });
  }
  return {
    name: tableName,
    ownerModule,
    columns,
    primaryKey: [snake(corr)],
    foreignKeys: [],
    indexes: [],
  };
}

/** Projection read-model table (projection.md) — mirrors
 *  `workflowStateTableShape`: PK is the projection's `keyed by` correlation
 *  column, the remaining state fields are read-model columns.  No FK to the
 *  aggregates whose events it folds (a derived row is standalone).  No
 *  idempotent marker in v1 (in-process, at-most-once). */
function projectionTableShape(
  proj: ProjectionIR,
  ownerModule: string,
  voLookup: VoLookup,
): TableShape {
  const tableName = plural(snake(proj.name));
  const corr = proj.correlationField as string;
  const columns: ColumnShape[] = [];
  for (const f of proj.stateFields) {
    if (f.name === corr) {
      const vt = f.type.kind === "id" ? f.type.valueType : "guid";
      columns.push({ name: snake(f.name), type: idColumnType(vt), nullable: false });
      continue;
    }
    // Non-key columns are NULLABLE: a fold upserts only the fields an event
    // carries, so a row is partial until every contributing event arrives
    // (a projection is derived + eventually consistent — the fold must not
    // require all columns on the first event for a key).
    if (isReferenceCollection(f.type)) {
      columns.push({ name: snake(f.name), type: { kind: "json" }, nullable: true });
      continue;
    }
    for (const mapped of columnsForField({ ...f, optional: true }, voLookup, proj.name)) {
      columns.push(mapped.column);
    }
  }
  return {
    name: tableName,
    ownerModule,
    columns,
    primaryKey: [snake(corr)],
    foreignKeys: [],
    indexes: [],
  };
}

/** Order tables so an FK target is always created before the table that
 *  references it — otherwise the inline `REFERENCES` in `CREATE TABLE`
 *  hits a relation that doesn't exist yet and the migration aborts (a
 *  child part like `pipelines` sorts alphabetically before its parent
 *  `projects`).  Deterministic Kahn's sort with an alphabetical
 *  tiebreak; a genuine FK cycle (none today — DDD parts/associations
 *  point "up" to roots, forming a DAG) falls back to alphabetical order
 *  for the stuck nodes.  Only FKs whose target is also in this set
 *  constrain the order; references to already-existing tables (a prior
 *  migration, or another module) are treated as satisfied. */
/** Schema-qualified table key.  Two tables named `orders` in different
 *  Postgres schemas (`sales.orders` / `billing.orders`) are distinct
 *  relations, so the diff must key by (schema, name) — keying by bare name
 *  collapses them and produces the wrong delta (audit finding 16/17). */
function qkey(schema: string | undefined, name: string): string {
  return `${schema ?? ""} ${name}`;
}

function orderTablesByFkDependency(tables: TableShape[]): TableShape[] {
  const present = new Set(tables.map((t) => qkey(t.schema, t.name)));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const self = qkey(t.schema, t.name);
    const s = new Set<string>();
    // FK targets resolve within the referencing table's own schema (see
    // `renderFkConstraint` in sql-pg.ts — the reference is qualified with
    // the table's schema).
    for (const fk of t.foreignKeys) {
      const dep = qkey(t.schema, fk.refTable);
      if (dep !== self && present.has(dep)) s.add(dep);
    }
    deps.set(self, s);
  }
  const remaining = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const emitted = new Set<string>();
  const order: TableShape[] = [];
  while (remaining.length > 0) {
    let idx = remaining.findIndex((t) =>
      [...deps.get(qkey(t.schema, t.name))!].every((d) => emitted.has(d)),
    );
    if (idx === -1) idx = 0; // cycle — best effort, alphabetical
    const [t] = remaining.splice(idx, 1);
    order.push(t);
    emitted.add(qkey(t.schema, t.name));
  }
  return order;
}

/** Embedded-children aggregate (`shape(embedded)`): the root stays a
 *  normal queryable row — `id` plus its scalar / `X id` columns, exactly
 *  like the relational root — but each containment folds into a single
 *  JSONB column (the contained parts serialised inline) and reference
 *  collections fold into a JSONB id-array column.  No part tables, no
 *  join tables.  This is the shape EF owned-types `.ToJson()`, Drizzle
 *  jsonb columns, and Phoenix embedded schemas all map to natively — one
 *  physical layout shared across every backend. */
function embeddedTableForAggregate(agg: AggregateIR, ownerModule: string): TableShape {
  const tableName = plural(snake(agg.name));
  const columns: ColumnShape[] = [
    { name: "id", type: idColumnType(agg.idValueType), nullable: false },
  ];
  const foreignKeys: FKShape[] = [];
  const indexes: IndexShape[] = [];
  for (const f of agg.fields) {
    if (isReferenceCollection(f.type)) {
      columns.push({ name: snake(f.name), type: { kind: "json" }, nullable: !!f.optional });
      continue;
    }
    const mapped = mapField(f);
    columns.push(mapped.column);
    if (mapped.fkRefTable) {
      foreignKeys.push({
        column: mapped.column.name,
        refTable: mapped.fkRefTable,
        onDelete: "restrict",
      });
      indexes.push({
        name: `${tableName}_${mapped.column.name}_idx`,
        table: tableName,
        columns: [mapped.column.name],
        unique: false,
      });
    }
  }
  for (const c of agg.contains) {
    // Nullable: an empty `embeds_many` on Ecto inserts
    // NULL (an empty embed is "no change", so it isn't written), which Ecto then
    // loads back as `[]` — so the column must tolerate NULL.
    columns.push({ name: snake(c.name), type: { kind: "json" }, nullable: true });
  }
  return { name: tableName, ownerModule, columns, primaryKey: ["id"], foreignKeys, indexes };
}

/** Document-shaped aggregate (`shape(document)`): the whole aggregate
 *  tree is one JSON document, so the table is the canonical document
 *  triple — `id` (PK), `data` (the serialised tree, JSONB), and `version`
 *  (the single-value optimistic-concurrency token; invariant §2.2#1 —
 *  the document is written and concurrency-checked as one unit).  No part
 *  or join tables: contained parts live inside `data`, and cross-aggregate
 *  `X id` / `X id[]` references stay references but ride inside `data` as
 *  id strings / arrays. */
function documentTableForAggregate(agg: AggregateIR, ownerModule: string): TableShape {
  const tableName = plural(snake(agg.name));
  return {
    name: tableName,
    ownerModule,
    columns: [
      { name: "id", type: idColumnType(agg.idValueType), nullable: false },
      { name: "data", type: { kind: "json" }, nullable: false },
      { name: "version", type: { kind: "int" }, nullable: false },
    ],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
  };
}

/** The single per-context append-only event log `<ctx>_events`
 *  (event-log-architecture.md) — the shared event-sourcing store, one table per
 *  bounded context, holding every `persistedAs(eventLog)` aggregate stream AND
 *  every `eventSourced` workflow stream in that context.  `stream_type`
 *  discriminates the owner (aggregate/workflow name); `stream_id` is the
 *  aggregate id or workflow correlation key; a row is keyed `(stream_type,
 *  stream_id, version)` with `version` its gap-free per-stream position (the
 *  optimistic-concurrency control).  `seq` is a context-global monotonic cursor
 *  (Marten's `mt_events` scoped to a context) that a projection replay reads in
 *  order — DB-assigned, carried inert until the rebuild reader lands.  `type`
 *  discriminates the event for the fold; `data` is the JSON payload. */
function eventLogTableForStream(snakeCtxName: string, ownerModule: string): TableShape {
  const tableName = `${snakeCtxName}_events`;
  return {
    name: tableName,
    ownerModule,
    columns: [
      { name: "seq", type: { kind: "bigserial" }, nullable: false },
      { name: "stream_type", type: { kind: "text" }, nullable: false },
      { name: "stream_id", type: { kind: "text" }, nullable: false },
      { name: "version", type: { kind: "int" }, nullable: false },
      { name: "type", type: { kind: "text" }, nullable: false },
      { name: "data", type: { kind: "json" }, nullable: false },
      { name: "occurred_at", type: { kind: "datetime" }, nullable: false, default: "now()" },
    ],
    primaryKey: ["stream_type", "stream_id", "version"],
    foreignKeys: [],
    // Unique cursor index — the replay reader scans `WHERE seq > $ckpt ORDER BY
    // seq`; `bigserial` already guarantees uniqueness, the index makes the scan
    // range-friendly.
    indexes: [{ name: `${tableName}_seq_key`, table: tableName, columns: ["seq"], unique: true }],
  };
}

/** Match prev/next tables by schema-qualified key, with a graceful fallback
 *  for OLD snapshots whose tables were written before schema-qualification:
 *  a prev table with no `schema` matches a single same-bare-name next table,
 *  so an existing `.loom` snapshot reads as "same table, now qualified"
 *  instead of drop+recreate.  A corrupt file still errors upstream
 *  (`fsSnapshotStore.read`); this only reconciles a legitimate format bump. */
interface TableMatch {
  pairs: [TableShape, TableShape][];
  dropped: TableShape[];
  created: TableShape[];
}

function matchTables(prev: readonly TableShape[], next: readonly TableShape[]): TableMatch {
  const nextByQ = new Map<string, TableShape>();
  for (const t of next) nextByQ.set(qkey(t.schema, t.name), t);
  const consumed = new Set<TableShape>();
  const pairs: [TableShape, TableShape][] = [];
  const dropped: TableShape[] = [];
  for (const p of prev) {
    let m = nextByQ.get(qkey(p.schema, p.name));
    if (m && consumed.has(m)) m = undefined;
    if (!m && p.schema === undefined) {
      const candidates = next.filter((t) => t.name === p.name && !consumed.has(t));
      if (candidates.length === 1) m = candidates[0];
    }
    if (m) {
      consumed.add(m);
      pairs.push([p, m]);
    } else {
      dropped.push(p);
    }
  }
  const created = next.filter((t) => !consumed.has(t));
  return { pairs, dropped, created };
}

interface DiffBuckets {
  dropIndex: MigrationStep[];
  dropColumn: MigrationStep[];
  rename: MigrationStep[];
  addColumn: MigrationStep[];
  alter: MigrationStep[];
  addIndex: MigrationStep[];
}

export function diffSchema(
  prev: SchemaSnapshot | null,
  next: SchemaSnapshot,
  renames: readonly TableColumnRename[] = [],
  tableRenames: readonly ResolvedTableRename[] = [],
): MigrationStep[] {
  // Table/aggregate renames (M-T2.1): rewrite a COPY of the baseline so a
  // renamed table carries its NEW name BEFORE `matchTables` runs — the renamed
  // relation then pairs with its new self instead of dropping + recreating.
  // Guarded on the old relation existing (and the new name being free) so a
  // ledger block that's already been baked into the snapshot, or a rename of a
  // same-generation add, is a no-op.  The actual `renameTable` DDL is emitted
  // separately (`tableRenameSteps`) and ordered before `createTable` so a new
  // table can inline-reference the renamed one under its new name.
  const tableRenameSteps: MigrationStep[] = [];
  if (prev && tableRenames.length > 0) {
    const prevKeys = new Set(prev.tables.map((t) => qkey(t.schema, t.name)));
    const applied = new Map<string, ResolvedTableRename>(); // old qkey → rename
    for (const tr of tableRenames) {
      const fromKey = qkey(tr.schema, tr.from);
      const toKey = qkey(tr.schema, tr.to);
      // Old relation must exist; new name must be free (no collision); each old
      // relation renamed at most once.
      if (!prevKeys.has(fromKey) || prevKeys.has(toKey) || applied.has(fromKey)) continue;
      applied.set(fromKey, tr);
      tableRenameSteps.push({ op: "renameTable", from: tr.from, to: tr.to, schema: tr.schema });
    }
    if (applied.size > 0) {
      prev = {
        ...prev,
        tables: prev.tables.map((t) => {
          const tr = applied.get(qkey(t.schema, t.name));
          return tr ? { ...t, name: tr.to } : t;
        }),
      };
    }
  }

  // Index the flat rename list by the same schema-qualified key the table
  // match uses, so a rename is looked up against the exact relation it targets.
  const renamesByTable = new Map<string, TableColumnRename[]>();
  for (const r of renames) {
    const key = qkey(r.schema, r.table);
    (renamesByTable.get(key) ?? renamesByTable.set(key, []).get(key)!).push(r);
  }
  const { pairs, dropped, created } = prev
    ? matchTables(prev.tables, next.tables)
    : {
        pairs: [] as [TableShape, TableShape][],
        dropped: [] as TableShape[],
        created: next.tables,
      };

  const buckets: DiffBuckets = {
    dropIndex: [],
    dropColumn: [],
    rename: [],
    addColumn: [],
    alter: [],
    addIndex: [],
  };
  for (const [p, n] of pairs) {
    diffTable(p, n, buckets, renamesByTable.get(qkey(n.schema, n.name)) ?? []);
  }

  // Drops in reverse-topological (child-first) order so a parent table is
  // never dropped while a child still FK-references it (audit finding 18).
  const dropTableSteps = orderTablesByFkDependency(dropped)
    .reverse()
    .map((t): MigrationStep => ({ op: "dropTable", name: t.name, schema: t.schema }));
  // Creates in topological (parent-first) order so an inline `REFERENCES`
  // never hits a relation that doesn't exist yet.
  const createTableSteps = orderTablesByFkDependency(created).map(
    (t): MigrationStep => ({ op: "createTable", table: t }),
  );

  // FK-safe global order:
  //   drop indexes/columns (unblocks table drops) → drop tables (child-first)
  //   → rename tables (so a new table can inline-reference a renamed relation
  //   under its new name; Postgres keeps FK constraints valid across the
  //   rename) → create tables (parent-first) → rename columns (before
  //   adds/alters so a renamed column exists under its new name for a
  //   subsequent type alter) → add columns (targets now exist) → alter columns
  //   → add indexes.
  return [
    ...buckets.dropIndex,
    ...buckets.dropColumn,
    ...dropTableSteps,
    ...tableRenameSteps,
    ...createTableSteps,
    ...buckets.rename,
    ...buckets.addColumn,
    ...buckets.alter,
    ...buckets.addIndex,
  ];
}

function diffTable(
  prev: TableShape,
  next: TableShape,
  buckets: DiffBuckets,
  renames: readonly TableColumnRename[] = [],
): void {
  // ALTER/DROP steps target the table's CURRENT schema (where it now lives).
  const schema = next.schema;
  const prevCols = new Map<string, ColumnShape>();
  for (const c of prev.columns) prevCols.set(c.name, c);
  const nextCols = new Map<string, ColumnShape>();
  for (const c of next.columns) nextCols.set(c.name, c);

  // Explicit renames (M-T2.1) — resolved BEFORE the drop/add passes so a
  // renamed column is a `renameColumn` (+ a follow-on type/nullable alter when
  // it also changed) rather than the data-losing drop+add the one-drop-one-add
  // heuristic can't collapse for two-at-once or rename+type-change.  A baseline
  // column that is a rename source and whose (chain-resolved) target is a
  // genuine new column becomes the rename; both ends are then excluded from the
  // drop/add loops.
  const renamedPrev = new Set<string>();
  const renamedNext = new Set<string>();
  if (renames.length > 0) {
    const edge = new Map<string, string>();
    for (const r of renames) edge.set(r.from, r.to);
    for (const c of prev.columns) {
      if (nextCols.has(c.name) || !edge.has(c.name)) continue; // persisted, or not renamed
      // Follow the rename chain (qty → quantity → amount) to the first hop
      // that is a real column of `next` — the actual target after any
      // intermediate renames the user stacked before regenerating.
      let cur = c.name;
      const seen = new Set<string>([cur]);
      let target: string | undefined;
      while (edge.has(cur)) {
        const nx = edge.get(cur)!;
        if (seen.has(nx)) break; // cycle guard
        seen.add(nx);
        cur = nx;
        if (nextCols.has(cur)) {
          target = cur;
          break;
        }
      }
      // Target must be a genuine ADD (in next, absent from prev, unclaimed).
      if (!target || renamedNext.has(target) || prevCols.has(target)) continue;
      const nextCol = nextCols.get(target)!;
      buckets.rename.push({
        op: "renameColumn",
        table: next.name,
        schema,
        from: c.name,
        to: target,
        type: nextCol.type,
      });
      // A rename that also changed nullability / type carries the follow-on
      // ALTER, keyed to the NEW column name (the rename already ran).
      if (c.nullable !== nextCol.nullable) {
        buckets.rename.push({
          op: "alterColumnNullable",
          table: next.name,
          schema,
          name: target,
          type: nextCol.type,
          nullable: nextCol.nullable,
        });
      }
      if (!columnTypeEqual(c.type, nextCol.type)) {
        buckets.rename.push({
          op: "alterColumnType",
          table: next.name,
          schema,
          name: target,
          from: c.type,
          to: nextCol.type,
        });
      }
      renamedPrev.add(c.name);
      renamedNext.add(target);
    }
  }

  // Drops — iterate prev order so the op stream reads source-faithful.
  for (const c of prev.columns) {
    if (!nextCols.has(c.name) && !renamedPrev.has(c.name)) {
      buckets.dropColumn.push({ op: "dropColumn", table: next.name, schema, name: c.name });
    }
  }
  // Adds — iterate next order; attach FK if present.
  for (const c of next.columns) {
    if (!prevCols.has(c.name) && !renamedNext.has(c.name)) {
      const fk = next.foreignKeys.find((f) => f.column === c.name);
      buckets.addColumn.push(
        fk
          ? { op: "addColumn", table: next.name, schema, column: c, fk }
          : { op: "addColumn", table: next.name, schema, column: c },
      );
    }
  }
  // Type / nullable alters — only for columns present on both sides.
  for (const c of next.columns) {
    const p = prevCols.get(c.name);
    if (!p) continue;
    if (p.nullable !== c.nullable) {
      buckets.alter.push({
        op: "alterColumnNullable",
        table: next.name,
        schema,
        name: c.name,
        type: c.type,
        nullable: c.nullable,
      });
    }
    if (!columnTypeEqual(p.type, c.type)) {
      buckets.alter.push({
        op: "alterColumnType",
        table: next.name,
        schema,
        name: c.name,
        from: p.type,
        to: c.type,
      });
    }
  }

  // Index diff — match by index name (deterministic, see tableForAggregate).
  const prevIdx = new Map<string, IndexShape>();
  for (const i of prev.indexes) prevIdx.set(i.name, i);
  const nextIdx = new Map<string, IndexShape>();
  for (const i of next.indexes) nextIdx.set(i.name, i);
  for (const i of prev.indexes) {
    if (!nextIdx.has(i.name)) {
      buckets.dropIndex.push({ op: "dropIndex", table: next.name, schema, name: i.name });
    }
  }
  for (const i of next.indexes) {
    if (!prevIdx.has(i.name)) buckets.addIndex.push({ op: "addIndex", index: i, schema });
  }
}

// ---------------------------------------------------------------------------
// Destructive-change gate (audit finding 19).
// ---------------------------------------------------------------------------

/** Raised when a delta migration contains a destructive change and the
 *  generate run did not pass `--allow-destructive`.  Destructive =
 *  `dropColumn` / `dropTable` (irreversible data loss) or a NOT-NULL
 *  column add without a default on a previously-existing table (fails on any
 *  populated table).  First-run (Initial) migrations never raise this —
 *  nothing pre-exists to destroy. */
export class MigrationDestructiveError extends Error {
  constructor(
    readonly module: string,
    readonly offending: readonly MigrationStep[],
  ) {
    super(
      `migration for module "${module}" contains ${offending.length} destructive change(s):\n` +
        offending.map((s) => `  - ${describeDestructive(s)}`).join("\n") +
        `\nA migration-block backfill step makes a NOT NULL add or flip non-destructive ` +
        `with no flag needed:  migration "…" { <Agg>.<field> = <value> }\n` +
        `Otherwise re-run \`generate system\` with --allow-destructive to apply them. ` +
        `Column/table drops are irreversible; a NOT NULL column add without a default fails ` +
        `on a populated table — under --allow-destructive it is emitted as the safe ` +
        `add-nullable / backfill-TODO / SET NOT NULL sequence instead.`,
    );
    this.name = "MigrationDestructiveError";
  }
}

function describeDestructive(s: MigrationStep): string {
  switch (s.op) {
    case "dropTable":
      return `DROP TABLE ${qualifiedName(s.schema, s.name)}`;
    case "dropColumn":
      return `DROP COLUMN ${qualifiedName(s.schema, s.table)}.${s.name}`;
    case "addColumn":
      return `ADD COLUMN ${qualifiedName(s.schema, s.table)}.${s.column.name} NOT NULL (no default)`;
    case "alterColumnNullable":
      return `SET NOT NULL on ${qualifiedName(s.schema, s.table)}.${s.name} (fails on rows holding NULL)`;
    default:
      return s.op;
  }
}

function qualifiedName(schema: string | undefined, name: string): string {
  return schema ? `${schema}.${name}` : name;
}

/** True for a NOT-NULL column add without a default.  Because `diffTable`
 *  only emits `addColumn` for tables present on BOTH sides (new tables carry
 *  their columns inline via `createTable`), such an add always targets a
 *  previously-existing table — the exact case that fails on populated data. */
function isBlockingNotNullAdd(s: MigrationStep): boolean {
  return s.op === "addColumn" && !s.column.nullable && s.column.default === undefined;
}

/** Classify the raw diff, collapse unambiguous renames, weave declared
 *  backfills (M-T2.3), and enforce the destructive-change policy.  A NOT-NULL
 *  add or a NULL→NOT-NULL flip WITH a matching backfill becomes the safe
 *  add-nullable → UPDATE → SET NOT NULL sequence and does NOT trip the gate;
 *  without one, both are destructive (the flip fails on any row holding NULL
 *  — previously ungated).  Returns the final step list (possibly rewritten
 *  for the `--allow-destructive` NOT-NULL path), or throws
 *  {@link MigrationDestructiveError} when a destructive step remains and the
 *  flag is off.  First-run (baseline null) migrations are returned untouched. */
export function applyDestructivePolicy(
  steps: MigrationStep[],
  baseline: SchemaSnapshot | null,
  opts: { allowDestructive: boolean; module: string; backfills?: readonly ResolvedBackfill[] },
): MigrationStep[] {
  if (baseline === null) return steps; // Initial migration — nothing pre-exists.

  // Prev column-type lookup (for rename type-equality), qualified with a
  // bare-name fallback mirroring `matchTables`.
  const prevByQ = new Map<string, TableShape>();
  const prevByBare = new Map<string, TableShape[]>();
  for (const t of baseline.tables) {
    prevByQ.set(qkey(t.schema, t.name), t);
    const arr = prevByBare.get(t.name) ?? [];
    arr.push(t);
    prevByBare.set(t.name, arr);
  }
  const prevColType = (
    schema: string | undefined,
    table: string,
    col: string,
  ): ColumnType | undefined => {
    let t = prevByQ.get(qkey(schema, table));
    if (!t) {
      const cands = prevByBare.get(table);
      if (cands && cands.length === 1) t = cands[0];
    }
    return t?.columns.find((c) => c.name === col)?.type;
  };

  // Rename detection: a table with EXACTLY one dropColumn + one addColumn of
  // identical type is an unambiguous rename → collapse to a single
  // `renameColumn` (non-destructive).  Anything else stays drop+add and falls
  // under the gate below.
  const dropByTable = new Map<string, MigrationStep[]>();
  const addByTable = new Map<string, MigrationStep[]>();
  for (const s of steps) {
    if (s.op === "dropColumn") {
      const k = qkey(s.schema, s.table);
      (dropByTable.get(k) ?? dropByTable.set(k, []).get(k)!).push(s);
    } else if (s.op === "addColumn") {
      const k = qkey(s.schema, s.table);
      (addByTable.get(k) ?? addByTable.set(k, []).get(k)!).push(s);
    }
  }
  const collapsed = new Set<MigrationStep>();
  const renameFor = new Map<MigrationStep, MigrationStep>(); // addColumn step → renameColumn step
  for (const [k, drops] of dropByTable) {
    const adds = addByTable.get(k) ?? [];
    if (drops.length !== 1 || adds.length !== 1) continue;
    const d = drops[0]!;
    const a = adds[0]!;
    if (d.op !== "dropColumn" || a.op !== "addColumn") continue;
    const dType = prevColType(d.schema, d.table, d.name);
    if (!dType || !columnTypeEqual(dType, a.column.type)) continue;
    collapsed.add(d);
    collapsed.add(a);
    renameFor.set(a, {
      op: "renameColumn",
      table: a.table,
      schema: a.schema,
      from: d.name,
      to: a.column.name,
      type: a.column.type,
    });
  }

  // Rebuild the step list, dropping collapsed drop/add pairs and inserting the
  // renameColumn where its addColumn was.
  const afterRename: MigrationStep[] = [];
  for (const s of steps) {
    if (collapsed.has(s)) {
      const rename = renameFor.get(s);
      if (rename) afterRename.push(rename);
      continue;
    }
    afterRename.push(s);
  }

  // Weave declared backfills (M-T2.3) — applies whether or not anything is
  // destructive.  A matching addColumn gains an UPDATE after it (and, when
  // the add was blocking, the add is split nullable-first with a SET NOT NULL
  // after the UPDATE); a matching NULL→NOT-NULL flip gains the UPDATE before
  // it.  Flips made safe this way are exempted from the gate below.
  const backfillByCol = new Map<string, ResolvedBackfill>();
  for (const b of opts.backfills ?? []) {
    backfillByCol.set(`${qkey(b.schema, b.table)}.${b.column}`, b);
  }
  const backfillFor = (
    schema: string | undefined,
    table: string,
    column: string,
  ): ResolvedBackfill | undefined => backfillByCol.get(`${qkey(schema, table)}.${column}`);
  const safeFlips = new Set<MigrationStep>();
  const woven = afterRename.flatMap((s): MigrationStep[] => {
    if (s.op === "addColumn") {
      const b = backfillFor(s.schema, s.table, s.column.name);
      if (b) {
        const blocking = isBlockingNotNullAdd(s);
        const addCol: ColumnShape = blocking ? { ...s.column, nullable: true } : s.column;
        const add: MigrationStep = s.fk
          ? { op: "addColumn", table: s.table, schema: s.schema, column: addCol, fk: s.fk }
          : { op: "addColumn", table: s.table, schema: s.schema, column: addCol };
        const out: MigrationStep[] = [
          add,
          {
            op: "backfillColumn",
            table: s.table,
            schema: s.schema,
            column: s.column.name,
            valueSql: b.valueSql,
            onlyNull: true,
          },
        ];
        if (blocking) {
          const flip: MigrationStep = {
            op: "alterColumnNullable",
            table: s.table,
            schema: s.schema,
            name: s.column.name,
            type: s.column.type,
            nullable: false,
          };
          safeFlips.add(flip);
          out.push(flip);
        }
        return out;
      }
      return [s];
    }
    if (s.op === "alterColumnNullable" && !s.nullable) {
      const b = backfillFor(s.schema, s.table, s.name);
      if (b) {
        safeFlips.add(s);
        return [
          {
            op: "backfillColumn",
            table: s.table,
            schema: s.schema,
            column: s.name,
            valueSql: b.valueSql,
            onlyNull: true,
          },
          s,
        ];
      }
      return [s];
    }
    return [s];
  });

  // Classify what remains.  A NULL→NOT-NULL flip without a backfill joins
  // the destructive set (it fails at apply time on any row holding NULL) —
  // M-T2.3 closes what was previously an ungated apply-time failure.
  const destructive = woven.filter(
    (s) =>
      s.op === "dropTable" ||
      s.op === "dropColumn" ||
      isBlockingNotNullAdd(s) ||
      (s.op === "alterColumnNullable" && !s.nullable && !safeFlips.has(s)),
  );
  if (destructive.length > 0 && !opts.allowDestructive) {
    throw new MigrationDestructiveError(opts.module, destructive);
  }
  if (destructive.length === 0) return woven;

  // --allow-destructive: rewrite each blocking NOT-NULL add into the safe
  // three-step sequence and prefix each unbackfilled flip with the TODO
  // marker; drops pass through unchanged.
  return woven.flatMap((s): MigrationStep[] => {
    if (s.op === "alterColumnNullable" && !s.nullable && !safeFlips.has(s)) {
      return [
        {
          op: "sqlComment",
          comment: `TODO backfill ${qualifiedName(s.schema, s.table)}.${s.name} before it is set NOT NULL (a migration-block backfill makes this non-destructive: <Agg>.<field> = <value>)`,
        },
        s,
      ];
    }
    if (!isBlockingNotNullAdd(s) || s.op !== "addColumn") return [s];
    const nullableCol: ColumnShape = { ...s.column, nullable: true };
    const add: MigrationStep = s.fk
      ? { op: "addColumn", table: s.table, schema: s.schema, column: nullableCol, fk: s.fk }
      : { op: "addColumn", table: s.table, schema: s.schema, column: nullableCol };
    return [
      add,
      {
        op: "sqlComment",
        comment: `TODO backfill ${qualifiedName(s.schema, s.table)}.${s.column.name} before it is set NOT NULL`,
      },
      {
        op: "alterColumnNullable",
        table: s.table,
        schema: s.schema,
        name: s.column.name,
        type: s.column.type,
        nullable: false,
      },
    ];
  });
}

export interface BuildMigrationsOptions {
  /** When true, destructive deltas (dropColumn / dropTable, and NOT-NULL
   *  column adds without a default on a previously-existing table) are
   *  ALLOWED — a NOT-NULL add is rewritten into the safe
   *  add-nullable / backfill-TODO / SET NOT NULL sequence, and drops pass
   *  through.  When false (the default), any such step raises a
   *  {@link MigrationDestructiveError} naming the offending steps so the
   *  operator makes the call deliberately (the CLI `--allow-destructive`
   *  flag).  First-run (Initial) migrations are always exempt — nothing
   *  pre-exists to destroy. */
  allowDestructive?: boolean;
  /** Schema-evolution rename intents (M-T2.1), lowered from top-level
   *  `migration { rename ... }` blocks.  Each module filters these to its own
   *  contexts and folds them into the diff, so a renamed column produces an
   *  explicit `renameColumn` instead of the data-losing drop+add.  Empty /
   *  omitted for models with no migration block. */
  renameIntents?: readonly RenameIntentIR[];
  /** Table/aggregate rename intents (M-T2.1) — `OldName -> NewAggregate`.  Each
   *  module filters these to its own contexts and folds them into the diff as a
   *  `renameTable` for the aggregate's root table plus the owned-child cascade,
   *  so an aggregate rename is a clean set of renames instead of the data-losing
   *  drop+recreate.  Empty / omitted for models with no table rename. */
  tableRenameIntents?: readonly TableRenameIntentIR[];
  /** Backfill intents (M-T2.3) — `Agg.field = <expr>`.  Each module resolves
   *  its own and weaves them into the policy pass: a NOT-NULL add (or a
   *  NULL→NOT-NULL flip) with a matching backfill becomes the safe
   *  add-nullable → UPDATE → SET NOT NULL sequence WITHOUT tripping the
   *  destructive gate.  Naturally ledger-inert (fires only when the diff
   *  carries the matching structural step). */
  backfillIntents?: readonly BackfillIntentIR[];
  /** Raw `sql "…"` steps (M-T2.3), in declaration order.  Emitted exactly
   *  once — the snapshot's `appliedDataMigrations` records each emitted
   *  `"<block>#<index>"` key — after the generation's structural steps, on
   *  the module the owning block's other intents pin (or the system's single
   *  owner module; ambiguous scope raises {@link MigrationSqlScopeError}). */
  sqlSteps?: readonly SqlStepIR[];
}

/** One resolved column rename (M-T2.1).  `from`/`to` are already snake-cased
 *  column names; `table` + `schema` identify the relation it applies to so
 *  `diffSchema` can index it internally (callers never construct the builder's
 *  opaque schema-qualified key). */
export interface TableColumnRename {
  table: string;
  schema?: string;
  from: string;
  to: string;
}

/** One resolved table rename (M-T2.1) — the bare (unqualified) old + new table
 *  names and the Postgres schema they share.  `diffSchema` applies it against
 *  the baseline (only when the old relation actually exists) so a renamed table
 *  pairs with its new self instead of dropping + recreating. */
export interface ResolvedTableRename {
  from: string;
  to: string;
  schema?: string;
}

/** One resolved backfill (M-T2.3): the physical target column + the
 *  pre-rendered Postgres value expression.  `table` already accounts for a
 *  TPH concrete (the root base's shared table). */
export interface ResolvedBackfill {
  table: string;
  schema?: string;
  column: string;
  valueSql: string;
}

/** Raised when a raw `sql` migration step cannot be pinned to a single
 *  module: its block names no aggregate (so no module affinity) in a
 *  multi-module system, or its other steps span several modules.  Split the
 *  block per module (add a rename/backfill naming one of the module's
 *  aggregates, or keep one block per module) so the statement runs against
 *  the right database. */
export class MigrationSqlScopeError extends Error {
  constructor(
    readonly migration: string,
    readonly modules: readonly string[],
  ) {
    super(
      modules.length > 1
        ? `migration block "${migration}" spans modules ${modules.join(", ")} — its sql steps cannot be pinned to one database. Split the block so each module's steps (and sql) live in their own block.`
        : `migration block "${migration}" has sql steps but no module affinity in a multi-module system — add a step naming one of the module's aggregates, or split per module.`,
    );
    this.name = "MigrationSqlScopeError";
  }
}

export function buildMigrations(
  sys: EnrichedSystemIR,
  snapshots: SnapshotStore,
  options: BuildMigrationsOptions = {},
): MigrationsIR[] {
  const allowDestructive = options.allowDestructive ?? false;
  const out: MigrationsIR[] = [];
  // Raw-sql scope pinning (M-T2.3): a block's sql steps run on the module its
  // OTHER intents pin.  A block naming aggregates across several modules — or
  // none, in a multi-owner system — cannot be pinned and raises
  // MigrationSqlScopeError at the sql-filter below.
  const ctxModule = new Map<string, string>();
  for (const md of sys.subdomains) for (const c of md.contexts) ctxModule.set(c.name, md.name);
  const blockModules = new Map<string, Set<string>>();
  const pin = (block: string, ctxName: string): void => {
    const mod = ctxModule.get(ctxName);
    if (!mod) return;
    (blockModules.get(block) ?? blockModules.set(block, new Set()).get(block)!).add(mod);
  };
  for (const ri of options.renameIntents ?? []) pin(ri.migration, ri.context);
  for (const tr of options.tableRenameIntents ?? []) pin(tr.migration, tr.context);
  for (const bi of options.backfillIntents ?? []) pin(bi.migration, bi.context);
  const ownerModules = sys.subdomains.filter((md) => md.migrationsOwner).map((md) => md.name);
  for (const m of sys.subdomains) {
    if (!m.migrationsOwner) continue;
    // Binding-aware saving-shape resolver: resolve each aggregate's
    // effective shape via its (context, kind) dataSource binding so a
    // per-projection `shape:` override matches what the backend emitters
    // produce.  The owning context is passed in by IDENTITY from
    // `schemaFromModule` (not looked up by aggregate name), so two
    // same-named aggregates in sibling contexts resolve independently.
    const shapeOf = (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): SavingShape =>
      effectiveSavingShape(agg, resolveDataSourceConfig(agg, ctx, sys));
    // Same binding-aware resolution for the Postgres schema each table
    // lands in — the owning context's schema (`snake(ctx.name)` default,
    // or the dataSource `schema:` override).  Matches what the EF /
    // Drizzle table mappings resolve, so the migration DDL creates the
    // exact schema-qualified relations the backends query at runtime.
    const schemaOf = (
      agg: EnrichedAggregateIR,
      ctx: EnrichedBoundedContextIR,
    ): string | undefined => resolveDataSourceConfig(agg, ctx, sys)?.schema;
    // Binding-aware manual-index resolver: the `index: [...]` specs on the
    // aggregate's (context, state) storage binding.
    const manualIndexesOf = (
      agg: EnrichedAggregateIR,
      ctx: EnrichedBoundedContextIR,
    ): readonly ManualIndexIR[] =>
      resolveDataSourceForAggregate(agg, ctx, sys)?.manualIndexes ?? [];
    // Context-owned saga tables land in the context's schema (same resolver
    // the backend schema emitters use), not `public`.
    const contextSchemaOf = (ctx: EnrichedBoundedContextIR): string | undefined =>
      resolveContextSchema(ctx, sys);
    const next = schemaFromModule(m, shapeOf, schemaOf, manualIndexesOf, contextSchemaOf);
    const baseline = snapshots.read(m.name);
    // Resolve this module's rename intents to per-table column renames, keyed
    // by the table's schema-qualified key so the diff can fold them in.  A
    // rename whose aggregate/context isn't in THIS module is skipped here and
    // picked up on its owning module's iteration.
    const renames = resolveRenames(m, options.renameIntents ?? [], schemaOf);
    // Table/aggregate renames (M-T2.1): resolve to a `renameTable` for the root
    // + owned-child cascade, plus the FK-column renames the cascade implies.
    // The column renames join the column-rename list; the table renames feed
    // `diffSchema` so a renamed table pairs with its new self.
    const tableRenamePlan = resolveTableRenames(m, options.tableRenameIntents ?? [], schemaOf);
    const allRenames = [...renames, ...tableRenamePlan.columnRenames];
    // Backfills (M-T2.3): woven into the policy pass so a NOT-NULL add /
    // flip with a declared backfill is the safe sequence, not a gate trip.
    const backfills = resolveBackfills(m, options.backfillIntents ?? [], schemaOf);
    const structuralSteps = applyDestructivePolicy(
      diffSchema(baseline, next, allRenames, tableRenamePlan.tableRenames),
      baseline,
      {
        allowDestructive,
        module: m.name,
        backfills,
      },
    );
    // Raw sql steps + ledgered data fix-ups (M-T2.3): emitted exactly once —
    // the baseline's `appliedDataMigrations` records each emitted key — after
    // the generation's structural steps, in declaration order.
    const applied = new Set(baseline?.appliedDataMigrations ?? []);
    const sqlForModule = (options.sqlSteps ?? []).filter((step) => {
      const mods = blockModules.get(step.migration);
      if (mods && mods.size > 0) {
        if (mods.size > 1) throw new MigrationSqlScopeError(step.migration, [...mods]);
        return mods.has(m.name);
      }
      if (ownerModules.length === 1) return ownerModules[0] === m.name;
      throw new MigrationSqlScopeError(step.migration, []);
    });
    const newData = [
      ...sqlForModule.map((step) => ({ key: `${step.migration}#${step.index}`, sql: step.sql })),
      ...tableRenamePlan.dataFixups,
    ].filter((d) => !applied.has(d.key));
    const steps: MigrationStep[] = [
      ...structuralSteps,
      ...newData.map((d): MigrationStep => ({ op: "sqlExec", sql: d.sql })),
    ];
    const storageName = findPrimaryStorageBinding(sys, m, m.migrationsOwner) ?? "";
    const version =
      baseline === null
        ? BASE_TIMESTAMP
        : String(BigInt(baseline.lastVersion ?? BASE_TIMESTAMP) + 1n);
    const name = baseline === null ? "Initial" : describeMigration(steps);
    // Stamp the next snapshot with the version we're about to emit so
    // the FOLLOWING regen starts from `version + 1`.  Append to
    // migrationHistory when steps are non-empty — the TS emitter
    // rebuilds Drizzle's _journal.json from this list each regen so
    // Drizzle's runtime migrator can see every past migration.
    const prevHistory = baseline?.migrationHistory ?? [];
    // Applied-data ledger (M-T2.3): carry the baseline's keys and record the
    // ones this generation emits, so a `sql` step / TPH fix-up runs exactly
    // once across regens.
    const appliedOut = [...(baseline?.appliedDataMigrations ?? []), ...newData.map((d) => d.key)];
    const appliedField: Partial<SchemaSnapshot> =
      appliedOut.length > 0 ? { appliedDataMigrations: appliedOut } : {};
    const stamped: SchemaSnapshot =
      steps.length === 0
        ? {
            ...next,
            lastVersion: baseline?.lastVersion ?? next.lastVersion,
            migrationHistory: prevHistory.length > 0 ? prevHistory : undefined,
            ...appliedField,
          }
        : {
            ...next,
            lastVersion: version,
            migrationHistory: [...prevHistory, { version, name }],
            ...appliedField,
          };
    out.push({
      module: m.name,
      storageName,
      baseline,
      next: stamped,
      steps,
      version,
      name,
    });
  }
  return out;
}

/** Resolve a model's rename intents to per-table column renames for ONE module
 *  (M-T2.1).  Filters to intents whose aggregate lives in this module, maps the
 *  aggregate to its table (`plural(snake(name))`) and Postgres schema (the same
 *  binding-aware resolver the table build uses), and snake-cases the field
 *  names to column names.  Returned as a flat list — `diffSchema` indexes it
 *  by relation internally. */
function resolveRenames(
  module: EnrichedSubdomainIR,
  intents: readonly RenameIntentIR[],
  schemaOf: (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR) => string | undefined,
): TableColumnRename[] {
  const out: TableColumnRename[] = [];
  if (intents.length === 0) return out;
  const ctxByName = new Map<string, EnrichedBoundedContextIR>();
  for (const ctx of module.contexts) ctxByName.set(ctx.name, ctx);
  for (const ri of intents) {
    const ctx = ctxByName.get(ri.context);
    if (!ctx) continue; // aggregate's context is in another module
    const agg = ctx.aggregates.find((a) => a.name === ri.aggregate);
    if (!agg) continue;
    out.push({
      table: plural(snake(ri.aggregate)),
      schema: schemaOf(agg, ctx),
      from: snake(ri.from),
      to: snake(ri.to),
    });
  }
  return out;
}

/** Resolve a model's backfill intents (M-T2.3) to physical columns + rendered
 *  SQL for ONE module.  Mirrors {@link resolveRenames}: filters to intents
 *  whose aggregate lives in this module, maps to the owning table (the TPH
 *  root's shared table for a TPH concrete) and snake-cased column, and
 *  renders the value expression with sibling scalar fields as column refs.
 *  Intents the phase-⑦ validator rejected (non-scalar target, unrenderable
 *  expression) are silently skipped — they were already reported. */
function resolveBackfills(
  module: EnrichedSubdomainIR,
  intents: readonly BackfillIntentIR[],
  schemaOf: (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR) => string | undefined,
): ResolvedBackfill[] {
  const out: ResolvedBackfill[] = [];
  if (intents.length === 0) return out;
  const ctxByName = new Map<string, EnrichedBoundedContextIR>();
  for (const ctx of module.contexts) ctxByName.set(ctx.name, ctx);
  const isScalar = (t: TypeIR): boolean =>
    t.kind === "primitive" ||
    t.kind === "enum" ||
    t.kind === "id" ||
    (t.kind === "optional" && isScalar(t.inner));
  for (const bi of intents) {
    const ctx = ctxByName.get(bi.context);
    if (!ctx) continue; // aggregate's context is in another module
    const agg = ctx.aggregates.find((a) => a.name === bi.aggregate);
    if (!agg) continue;
    const field = agg.fields.find((f) => f.name === bi.field);
    if (!field || !isScalar(field.type)) continue; // validator reported
    const columnFor = (name: string): string | undefined => {
      const sibling = agg.fields.find((f) => f.name === name);
      return sibling && isScalar(sibling.type) ? snake(name) : undefined;
    };
    let valueSql: string;
    try {
      valueSql = renderSqlScalarExpr(bi.value, { columnFor });
    } catch {
      continue; // outside the SQL subset — validator reported
    }
    out.push({
      table: plural(snake(tableOwnerName(agg, ctx.aggregates))),
      schema: schemaOf(agg, ctx),
      column: snake(bi.field),
      valueSql,
    });
  }
  return out;
}

/** Resolve a module's table/aggregate rename intents (M-T2.1) to a `renameTable`
 *  plan + the FK-column renames the cascade implies.  Filters to intents whose
 *  NEW aggregate lives in this module, then for each:
 *
 *   - the root table  `plural(snake(old))` → `plural(snake(new))`;
 *   - every OWNED child table — value-collection child tables + association
 *     join tables, both named `snake(agg)_<field>` — whose stem swaps
 *     `snake(old)` → `snake(new)`, and their owner FK column `snake(agg)_id`;
 *   - the owner FK column on each contained part's table (`snake(agg)_id`).
 *
 *  Old names are derived by substituting the NEW snake stem back to the OLD one
 *  on the enriched (new) descriptor, so they can't drift from what the schema
 *  emitter produced.  Emission is guarded downstream by baseline existence
 *  (`diffSchema`), so a candidate whose old relation/column never existed
 *  (a same-generation add, or a nested part FK'd to a sibling not the root) is
 *  silently dropped — never a rename against a missing object. */
function resolveTableRenames(
  module: EnrichedSubdomainIR,
  intents: readonly TableRenameIntentIR[],
  schemaOf: (agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR) => string | undefined,
): {
  tableRenames: ResolvedTableRename[];
  columnRenames: TableColumnRename[];
  /** Ledgered data fix-ups (M-T2.3): renaming a TPH CONCRETE changes no DDL
   *  (its rows live on the base's shared table, columns are field-named) but
   *  silently strands the `kind` discriminator data — so the cascade emits a
   *  one-shot UPDATE, keyed for the snapshot's `appliedDataMigrations`
   *  ledger (no structural step exists to be naturally inert against). */
  dataFixups: { key: string; sql: string }[];
} {
  const tableRenames: ResolvedTableRename[] = [];
  const columnRenames: TableColumnRename[] = [];
  const dataFixups: { key: string; sql: string }[] = [];
  if (intents.length === 0) return { tableRenames, columnRenames, dataFixups };
  const ctxByName = new Map<string, EnrichedBoundedContextIR>();
  for (const ctx of module.contexts) ctxByName.set(ctx.name, ctx);
  for (const ri of intents) {
    if (ri.fromAggregate === ri.toAggregate) continue; // no-op (validator flags)
    const ctx = ctxByName.get(ri.context);
    if (!ctx) continue; // new aggregate's context is in another module
    const agg = ctx.aggregates.find((a) => a.name === ri.toAggregate);
    if (!agg) continue;
    const schema = schemaOf(agg, ctx);
    const oldStem = snake(ri.fromAggregate);
    const newStem = snake(ri.toAggregate);
    if (oldStem === newStem) continue; // same table name after snake-casing

    // TPH concrete: no owned table, no cascade — but the shared table's
    // `kind` discriminator rows still say the OLD name.  Emit the one-shot
    // fix-up (M-T2.3 ledgered sqlExec) and skip the structural cascade.
    if (isTphConcrete(agg, ctx.aggregates)) {
      const baseTable = plural(snake(tableOwnerName(agg, ctx.aggregates)));
      const target = schema ? `"${schema}"."${baseTable}"` : `"${baseTable}"`;
      dataFixups.push({
        key: `${ri.migration}#tph:${ri.fromAggregate}->${ri.toAggregate}`,
        sql: `UPDATE ${target} SET "kind" = '${ri.toAggregate}' WHERE "kind" = '${ri.fromAggregate}'`,
      });
      continue;
    }

    // Substitute the NEW snake stem prefix back to the OLD one on a derived
    // child-table / FK-column name (`snake(agg)_<suffix>`).  Undefined when the
    // name doesn't embed the aggregate stem (e.g. a self-referential
    // association's disambiguated `owner_id`), so it isn't cascaded.
    const subStem = (name: string): string | undefined => {
      if (name === newStem) return oldStem;
      if (name.startsWith(`${newStem}_`)) return oldStem + name.slice(newStem.length);
      return undefined;
    };

    // Root table — plural, so computed directly (irregular plurals like
    // `category → categories` don't survive a bare prefix substitution).
    tableRenames.push({ from: plural(oldStem), to: plural(newStem), schema });

    // Value-object collection child tables owned by the ROOT (`field: VO[]`).
    // Part-owned collections are named for the part, not the aggregate, so they
    // are unaffected by the rename — `valueCollectionsFor(agg)` returns only the
    // root's.
    for (const vc of valueCollectionsFor(agg)) {
      const oldTable = subStem(vc.childTable);
      if (oldTable) tableRenames.push({ from: oldTable, to: vc.childTable, schema });
      const oldFk = subStem(vc.parentFk);
      if (oldFk) columnRenames.push({ table: vc.childTable, schema, from: oldFk, to: vc.parentFk });
    }

    // Association join tables (`Target id[]`) — the join table + its owner FK
    // both embed the aggregate stem.
    for (const assoc of agg.associations) {
      const oldTable = subStem(assoc.joinTable);
      if (oldTable) tableRenames.push({ from: oldTable, to: assoc.joinTable, schema });
      const oldFk = subStem(assoc.ownerFk);
      if (oldFk) {
        columnRenames.push({ table: assoc.joinTable, schema, from: oldFk, to: assoc.ownerFk });
      }
    }

    // Contained parts — the part table keeps its own name, but a root-level
    // part's owner FK column is `snake(agg)_id`, which the rename moves.  A
    // nested part FKs its sibling (not the root), so its `snake(agg)_id` column
    // never existed and the baseline guard drops the candidate.
    for (const part of agg.parts) {
      columnRenames.push({
        table: plural(snake(part.name)),
        schema,
        from: `${oldStem}_id`,
        to: `${newStem}_id`,
      });
    }
  }
  return { tableRenames, columnRenames, dataFixups };
}

// ---------------------------------------------------------------------------
// schemaFromModule helpers
// ---------------------------------------------------------------------------

interface AggCtxPair {
  agg: EnrichedAggregateIR;
  ctx: EnrichedBoundedContextIR;
}

/** Every aggregate in the module paired with its OWNING context (identity),
 *  contexts then aggregates in name order (deterministic).  The pairing is
 *  what lets the schema/shape resolvers stay identity-based rather than
 *  name-based (audit finding 16). */
function collectAggregatePairs(module: EnrichedSubdomainIR): AggCtxPair[] {
  const acc: AggCtxPair[] = [];
  const ctxs = [...module.contexts].sort((a, b) => a.name.localeCompare(b.name));
  for (const ctx of ctxs) {
    const aggs = [...ctx.aggregates].sort((a, b) => a.name.localeCompare(b.name));
    for (const agg of aggs) acc.push({ agg, ctx });
  }
  return acc;
}

/** Deterministic constraint name for a `unique (...)` index:
 *  `<table>_<col1>_<col2>_uq`.  The name is the join key the backends'
 *  23505 → 409 conflict mapping resolves back to a field, so it must be a
 *  pure function of the table + columns (uniqueness-and-indexes.md §4). */
export function uniqueIndexName(tableName: string, columns: readonly string[]): string {
  return `${tableName}_${columns.join("_")}_uq`;
}

/** Attach each manual `index: [...]` spec to its EXPLICITLY-named entity's
 *  table (uniqueness-and-indexes.md §3.2) — the entity resolves to
 *  `plural(snake(entity))`, matching an aggregate root or a contained-part
 *  table among the ones this aggregate produced.  A spec whose entity isn't in
 *  `tables` is skipped (a sibling aggregate owns it).  Non-unique, named
 *  `<table>_<cols>_idx`; deduped against an existing index of the same name. */
function applyManualIndexes(tables: readonly TableShape[], specs: readonly ManualIndexIR[]): void {
  for (const spec of specs) {
    const target = plural(snake(spec.entity));
    const table = tables.find((t) => t.name === target);
    if (!table) continue;
    const columns = spec.columns.map((c) => snake(c));
    const name = `${table.name}_${columns.join("_")}_idx`;
    if (table.indexes.some((i) => i.name === name)) continue;
    table.indexes.push({ name, table: table.name, columns, unique: false });
  }
}

/** Derived tenant read indexes (docs/tenancy.md): a `tenantOwned` aggregate's
 *  generated reads ALL prefix on `tenant_id = <claim>`, so any of its tables
 *  that physically carries the column gets a non-unique
 *  `<table>_tenant_id_idx` (the FK-index naming convention).  Applied as a
 *  post-pass over the aggregate's produced tables so every persistence shape
 *  is covered exactly when the column exists — relational root, TPH shared
 *  table, embedded root; document/eventLog tables hold the field inside the
 *  blob/stream (no column) and are skipped naturally, as are parts and join
 *  tables (the filter targets the root).  Deduped against a hand-declared
 *  `unique (tenantId, ...)`-style index only by exact single-column shape —
 *  a unique composite still benefits from the plain prefix index.
 *
 *  Multi-tenancy Phase 2 P2.5 adds a SECOND derived index on `data_key`: the
 *  `deep` / `global` read levels prefix-match the materialized path with
 *  `LIKE 'prefix.%'`, so `data_key` gets a non-unique `<table>_data_key_idx`
 *  with the `text_pattern_ops` opclass — the opclass that makes a prefix `LIKE`
 *  index-usable under ANY locale/collation (the default opclass only does so
 *  under the C collation).  Same column-existence gating as `tenant_id` (the
 *  registry, id-keyed and NOT `tenantOwned`, is read by id and gets none). */
function withTenantIndex(agg: AggregateIR, tables: TableShape[]): TableShape[] {
  if (!(agg.capabilities?.includes("tenantOwned") ?? false)) return tables;
  const derive = (column: string, opclasses?: Record<string, string>): void => {
    for (const t of tables) {
      if (!t.columns.some((c) => c.name === column)) continue;
      const already = t.indexes.some((ix) => ix.columns.length === 1 && ix.columns[0] === column);
      if (already) continue;
      t.indexes.push({
        name: `${t.name}_${column}_idx`,
        table: t.name,
        columns: [column],
        unique: false,
        ...(opclasses ? { opclasses } : {}),
      });
    }
  };
  derive("tenant_id");
  derive("data_key", { data_key: "text_pattern_ops" });
  return tables;
}

/** Derive the DB unique index for each `unique (...)` declaration on the
 *  aggregate (uniqueness-and-indexes.md §4.1).  Columns snake-case to their
 *  physical names (validated scalar/id/enum fields — one column each).  A
 *  `softDeletable` aggregate gets a PARTIAL index (`WHERE is_deleted =
 *  false`) so re-creating a row whose predecessor was soft-deleted is
 *  allowed.  Empty when the aggregate declares no `unique` keys. */
function uniqueIndexesFor(agg: AggregateIR, tableName: string): IndexShape[] {
  if (!agg.uniqueKeys || agg.uniqueKeys.length === 0) return [];
  const softDeletable = agg.capabilities?.includes("softDeletable") ?? false;
  return agg.uniqueKeys.map((uk) => {
    const columns = uk.columns.map((c) => snake(c));
    return {
      name: uniqueIndexName(tableName, columns),
      table: tableName,
      columns,
      unique: true,
      ...(softDeletable ? { predicate: "is_deleted = false" } : {}),
    };
  });
}

function tableForAggregate(
  agg: AggregateIR,
  ownerModule: string,
  voLookup: VoLookup = new Map(),
): TableShape {
  const tableName = plural(snake(agg.name));
  const columns: ColumnShape[] = [
    { name: "id", type: idColumnType(agg.idValueType), nullable: false },
  ];
  const foreignKeys: FKShape[] = [];
  const indexes: IndexShape[] = uniqueIndexesFor(agg, tableName);

  for (const f of agg.fields) {
    // Reference collections (`Target id[]`) lower to a separate join
    // table (see `tableForAssociation`); no column on the owner row.
    if (isReferenceCollection(f.type)) continue;
    for (const mapped of columnsForField(f, voLookup, agg.name)) {
      columns.push(mapped.column);
      if (!mapped.fkRefTable) continue;
      foreignKeys.push({
        column: mapped.column.name,
        refTable: mapped.fkRefTable,
        onDelete: "restrict",
      });
      indexes.push({
        name: `${tableName}_${mapped.column.name}_idx`,
        table: tableName,
        columns: [mapped.column.name],
        unique: false,
      });
    }
  }

  // Optimistic concurrency (`with versioned`): the capability contributes a
  // `version: int token` field, which the field loop above already emitted as
  // a `version` column (int, NOT NULL, no default).  Stamp it `DEFAULT 1` so
  // new rows seed at version 1 and — as an ADD COLUMN on an existing table —
  // the change stays non-destructive (a NOT NULL add WITH a default doesn't
  // trip `isBlockingNotNullAdd`).  sql-pg renders it `... NOT NULL DEFAULT 1`;
  // the Ecto emitter reads the same `default` off MigrationsIR.  Gated so
  // non-versioned aggregates are byte-identical.
  if (aggregateIsVersioned(agg)) {
    const versionCol = columns.find((c) => c.name === "version");
    if (versionCol) versionCol.default = "1";
  }

  return {
    name: tableName,
    ownerModule,
    columns,
    primaryKey: ["id"],
    foreignKeys,
    indexes,
  };
}

/** TPH shared table (aggregate-inheritance.md, sharedTable): mirrors the
 *  Drizzle `emitTphTable`.  Columns are `id`, the `kind` discriminator (text,
 *  not null), the abstract base's own columns (declared nullability), then
 *  every concrete subtype's own columns forced nullable, de-duplicated by
 *  column name (first wins).  v1 covers scalar / value-object / enum / id
 *  fields; reference collections lower to join tables as usual. */
function tphTableForAggregate(
  base: AggregateIR,
  pool: readonly AggregateIR[],
  ownerModule: string,
  voLookup: VoLookup = new Map(),
): TableShape {
  const tableName = plural(snake(base.name));
  const kindField: FieldIR = {
    name: "kind",
    type: { kind: "primitive", name: "string" },
    optional: false,
  } as FieldIR;
  const columns: ColumnShape[] = [
    { name: "id", type: idColumnType(base.idValueType), nullable: false },
    mapField(kindField).column,
  ];
  const foreignKeys: FKShape[] = [];
  const indexes: IndexShape[] = uniqueIndexesFor(base, tableName);
  const seen = new Set(columns.map((c) => c.name));

  const pushField = (f: FieldIR, forceNullable: boolean): void => {
    if (isReferenceCollection(f.type)) return;
    for (const mapped of columnsForField(f, voLookup, base.name)) {
      if (seen.has(mapped.column.name)) continue;
      seen.add(mapped.column.name);
      const column = forceNullable ? { ...mapped.column, nullable: true } : mapped.column;
      columns.push(column);
      if (!mapped.fkRefTable) continue;
      foreignKeys.push({ column: column.name, refTable: mapped.fkRefTable, onDelete: "restrict" });
      indexes.push({
        name: `${tableName}_${column.name}_idx`,
        table: tableName,
        columns: [column.name],
        unique: false,
      });
    }
  };

  for (const f of base.fields) pushField(f, false);
  for (const concrete of tphConcretesOf(base, pool)) {
    for (const f of ownFieldsOf(concrete, base)) pushField(f, true);
  }

  return { name: tableName, ownerModule, columns, primaryKey: ["id"], foreignKeys, indexes };
}

function tableForPart(
  part: EntityPartIR,
  parent: AggregateIR,
  ownerModule: string,
  voLookup: VoLookup = new Map(),
  // The aggregate that physically owns the parent table.  For a plain
  // aggregate this is `parent.name`; for a TPH concrete it's the shared base
  // table (the concrete has no table of its own), so the part's FK targets the
  // base.  Defaults to `parent.name` so non-inheritance output is unchanged.
  ownerName: string = parent.name,
): TableShape {
  const tableName = plural(snake(part.name));
  // A NESTED part (declared inside a sibling part — `Shipment contains label`)
  // FKs to that sibling's table, not the aggregate root, so a collection nested
  // below the root keeps its hierarchy instead of flattening every level onto
  // the root (lossy: `labels.order_id` can't say which shipment owns a label).
  // A root-level part resolves to `ownerName` (the root / TPH base), so existing
  // single-level output is byte-identical.
  const dp = directParentOf(parent, part.name);
  const fkOwnerName = dp?.nested ? dp.name : ownerName;
  const parentTable = plural(snake(fkOwnerName));
  const parentFk = `${snake(fkOwnerName)}_id`;
  const columns: ColumnShape[] = [
    { name: "id", type: idColumnType(parent.idValueType), nullable: false },
    { name: parentFk, type: idColumnType(parent.idValueType), nullable: false },
  ];
  const foreignKeys: FKShape[] = [{ column: parentFk, refTable: parentTable, onDelete: "cascade" }];
  const indexes: IndexShape[] = [
    {
      name: `${tableName}_${parentFk}_idx`,
      table: tableName,
      columns: [parentFk],
      unique: false,
    },
  ];

  for (const f of part.fields) {
    if (isReferenceCollection(f.type)) continue;
    for (const mapped of columnsForField(f, voLookup, part.name)) {
      columns.push(mapped.column);
      if (!mapped.fkRefTable) continue;
      foreignKeys.push({
        column: mapped.column.name,
        refTable: mapped.fkRefTable,
        onDelete: "restrict",
      });
      indexes.push({
        name: `${tableName}_${mapped.column.name}_idx`,
        table: tableName,
        columns: [mapped.column.name],
        unique: false,
      });
    }
  }

  return {
    name: tableName,
    ownerModule,
    columns,
    primaryKey: ["id"],
    foreignKeys,
    indexes,
  };
}

function tableForAssociation(assoc: AssociationIR, ownerModule: string): TableShape {
  const ownerTable = plural(snake(assoc.ownerAgg));
  const targetTable = plural(snake(assoc.targetAgg));
  const idType = idColumnType(assoc.valueType);
  return {
    name: assoc.joinTable,
    ownerModule,
    columns: [
      // `Id<T>[]` is contractually a set (membership only, no order): the
      // composite PK below IS the whole row, so the join table carries no
      // payload column.  Deterministic read-back order is a read-time
      // projection (every backend ORDERs BY the target FK id), not a stored
      // `ordinal`.  (The value-collection child table keeps its ordinal —
      // there it is part of the PK; see `valueCollectionTableShape`.)
      { name: assoc.ownerFk, type: idType, nullable: false },
      { name: assoc.targetFk, type: idType, nullable: false },
    ],
    primaryKey: [assoc.ownerFk, assoc.targetFk],
    foreignKeys: [
      { column: assoc.ownerFk, refTable: ownerTable, onDelete: "cascade" },
      { column: assoc.targetFk, refTable: targetTable, onDelete: "cascade" },
    ],
    indexes: [
      {
        name: `${assoc.joinTable}_${assoc.targetFk}_idx`,
        table: assoc.joinTable,
        columns: [assoc.targetFk],
        unique: false,
      },
    ],
  };
}

/** Flatten a value object's fields into bare child-table columns (no field
 *  prefix at the top level, `<vf>_<sub>` for a nested VO), matching the
 *  Drizzle value-collection child table the schema emitter lays down. */
function valueObjectChildColumns(
  prefix: string,
  voFields: readonly FieldIR[],
  voLookup: VoLookup,
): ColumnShape[] {
  return voFields.flatMap((vf): ColumnShape[] => {
    const name = prefix ? `${prefix}_${snake(vf.name)}` : snake(vf.name);
    const base = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    const optional = vf.optional || vf.type.kind === "optional";
    if (base.kind === "valueobject") {
      return valueObjectChildColumns(name, voLookup.get(base.name) ?? [], voLookup);
    }
    return [{ name, type: mapTypeToColumn(base).type, nullable: optional }];
  });
}

/** The id-less child table for a value-object array field: owner FK +
 *  `ordinal` + the value object's flattened columns, keyed by
 *  `(parentFk, ordinal)`.  Tagged `valueCollection` so Phoenix skips it
 *  (it stores the array inline as a `{:array, :map}` column). */
function valueCollectionTableShape(
  vc: ValueCollectionIR,
  parentAgg: AggregateIR,
  ownerModule: string,
  voLookup: VoLookup,
  partName?: string,
): TableShape {
  const ownerTable = partName ? plural(snake(partName)) : plural(snake(parentAgg.name));
  const idType = idColumnType(parentAgg.idValueType);
  return {
    name: vc.childTable,
    ownerModule,
    columns: [
      { name: vc.parentFk, type: idType, nullable: false },
      { name: "ordinal", type: { kind: "int" }, nullable: false },
      ...valueObjectChildColumns("", voLookup.get(vc.voName) ?? [], voLookup),
    ],
    primaryKey: [vc.parentFk, "ordinal"],
    foreignKeys: [{ column: vc.parentFk, refTable: ownerTable, onDelete: "cascade" }],
    indexes: [
      {
        name: `${vc.childTable}_${vc.parentFk}_idx`,
        table: vc.childTable,
        columns: [vc.parentFk],
        unique: false,
      },
    ],
    valueCollection: true,
  };
}

function isReferenceCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

interface MappedColumn {
  column: ColumnShape;
  /** Set iff this column references another aggregate's table. */
  fkRefTable?: string;
}

/** VO name → its field list, so a value-object field can be flattened into
 *  the parent table's columns rather than collapsed to one `json` column. */
type VoLookup = ReadonlyMap<string, readonly FieldIR[]>;

/** The migration column(s) a field contributes.  A value-object field
 *  destructures into one column per (recursively-flattened) VO field — the
 *  standard DDD shape the Drizzle / EF ORMs already query — each tagged with
 *  the originating field's `voGroup` so Phoenix can regroup them into a
 *  single `:map`.  Every other field is one column (`mapField`). */
function columnsForField(f: FieldIR, voLookup: VoLookup, ownerName: string): MappedColumn[] {
  const optional = f.optional || f.type.kind === "optional";
  const base = f.type.kind === "optional" ? f.type.inner : f.type;
  if (base.kind === "valueobject") {
    const voFields = voLookup.get(base.name);
    if (voFields) {
      return flattenValueObject(snake(f.name), voFields, optional, snake(f.name), voLookup);
    }
  }
  // Value-object *array* (`charges: Money[]`): a parent stand-in column
  // tagged with the id-less child table the elements live in.  Relational
  // backends skip the column (the child table holds the rows); Phoenix
  // renders the `array(json)` column as `{:array, :map}`.
  if (isValueCollectionType(f.type)) {
    return [
      {
        column: {
          name: snake(f.name),
          type: { kind: "array", inner: { kind: "json" } },
          nullable: optional,
          valueArrayChildTable: `${snake(ownerName)}_${snake(f.name)}`,
        },
      },
    ];
  }
  return [mapField(f)];
}

function flattenValueObject(
  prefix: string,
  voFields: readonly FieldIR[],
  optional: boolean,
  group: string,
  voLookup: VoLookup,
): MappedColumn[] {
  return voFields.flatMap((vf): MappedColumn[] => {
    const name = `${prefix}_${snake(vf.name)}`;
    const vfOptional = optional || vf.optional || vf.type.kind === "optional";
    const vfBase = vf.type.kind === "optional" ? vf.type.inner : vf.type;
    if (vfBase.kind === "valueobject") {
      const inner = voLookup.get(vfBase.name);
      if (inner) return flattenValueObject(name, inner, vfOptional, group, voLookup);
    }
    const { type, fkRefTable } = mapTypeToColumn(vfBase);
    return [{ column: { name, type, nullable: vfOptional, voGroup: group }, fkRefTable }];
  });
}

function mapField(f: FieldIR): MappedColumn {
  const { type, fkRefTable } = mapTypeToColumn(f.type);
  return {
    column: { name: snake(f.name), type, nullable: f.optional },
    fkRefTable,
  };
}

function mapTypeToColumn(t: TypeIR): {
  type: ColumnType;
  fkRefTable?: string;
} {
  switch (t.kind) {
    case "primitive":
      return { type: primitiveColumnType(t.name) };
    case "id":
      return {
        type: idColumnType(t.valueType),
        fkRefTable: plural(snake(t.targetName)),
      };
    case "enum":
      return { type: { kind: "text" } };
    case "valueobject":
    case "entity":
      return { type: { kind: "json" } };
    case "array": {
      const inner = mapTypeToColumn(t.element);
      return { type: { kind: "array", inner: inner.type } };
    }
    case "optional":
      return mapTypeToColumn(t.inner);
    case "action":
    case "slot":
      throw new Error(
        "mapTypeToColumn: 'slot' type is UI-only and should not reach the migrations builder.",
      );
    case "genericInstance":
      throw new Error(
        `mapTypeToColumn: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `mapTypeToColumn: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}

function primitiveColumnType(name: string): ColumnType {
  switch (name) {
    case "int":
      return { kind: "int" };
    case "long":
      return { kind: "bigint" };
    case "decimal":
      return { kind: "decimal" };
    case "money":
      // `money` is a precise decimal — same column family as `decimal`
      // (Drizzle numeric(19,4), Postgres NUMERIC).  sql-pg already renders
      // money/decimal literals identically; mirror that here so a system
      // with a money-primitive field derives migrations instead of throwing.
      return { kind: "decimal" };
    case "string":
      return { kind: "text" };
    case "bool":
      return { kind: "bool" };
    case "datetime":
      return { kind: "datetime" };
    case "guid":
      return { kind: "uuid" };
    case "json":
      return { kind: "json" };
    default:
      throw new Error(`migrations-builder: unknown primitive type '${name}'`);
  }
}

function idColumnType(t: IdValueType): ColumnType {
  switch (t) {
    case "guid":
      return { kind: "uuid" };
    case "int":
      return { kind: "int" };
    case "long":
      return { kind: "bigint" };
    case "string":
      return { kind: "text" };
  }
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

function columnTypeEqual(a: ColumnType, b: ColumnType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "array" && b.kind === "array") {
    return columnTypeEqual(a.inner, b.inner);
  }
  return true;
}

function findPrimaryStorageBinding(
  sys: SystemIR,
  m: SubdomainIR,
  ownerName: string,
): string | null {
  // D-STORAGE-SPLIT: the primary storage for a subdomain is the
  // physical storage referenced by the owner deployable's `state`
  // dataSource for any context in the subdomain.  Returns the
  // first such storage name in declaration order.
  const d = sys.deployables.find((x) => x.name === ownerName);
  if (!d) return null;
  const contextNames = new Set(m.contexts.map((c) => c.name));
  for (const dsName of d.dataSourceNames) {
    const ds = sys.dataSources.find((x) => x.name === dsName);
    if (!ds || ds.kind !== "state") continue;
    if (contextNames.has(ds.contextName)) return ds.storageName;
  }
  return null;
}

function describeMigration(steps: MigrationStep[]): string {
  if (steps.length === 1) {
    const s = steps[0]!;
    switch (s.op) {
      case "createTable":
        return `Create${tableToPascal(s.table.name)}`;
      case "dropTable":
        return `Drop${tableToPascal(s.name)}`;
      case "renameTable":
        return `Rename${tableToPascal(s.from)}To${tableToPascal(s.to)}`;
      case "addColumn":
        return `Add${columnToPascal(s.column.name)}To${tableToPascal(s.table)}`;
      case "dropColumn":
        return `Remove${columnToPascal(s.name)}From${tableToPascal(s.table)}`;
      case "alterColumnNullable":
      case "alterColumnType":
        return `Alter${columnToPascal(s.name)}On${tableToPascal(s.table)}`;
      case "addIndex":
        return `AddIndex${columnToPascal(s.index.name)}`;
      case "dropIndex":
        return `DropIndex${columnToPascal(s.name)}`;
      case "backfillColumn":
        return `Backfill${columnToPascal(s.column)}On${tableToPascal(s.table)}`;
      case "sqlExec":
        return "DataMigration";
    }
  }
  return "Migrate";
}

function tableToPascal(name: string): string {
  return name.split("_").map(upperFirst).join("");
}

function columnToPascal(name: string): string {
  return tableToPascal(name);
}
