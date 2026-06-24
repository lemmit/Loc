import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  EntityPartIR,
  FieldIR,
  IdValueType,
  SavingShape,
  SubdomainIR,
  SystemIR,
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
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../ir/util/inheritance.js";
import { effectiveSavingShape, resolveDataSourceConfig } from "../ir/util/resolve-datasource.js";
import {
  isValueCollectionType,
  type ValueCollectionIR,
  valueCollectionsFor,
} from "../ir/util/value-collections.js";
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
  shapeOf: (agg: EnrichedAggregateIR) => SavingShape = (agg) => effectiveSavingShape(agg),
  /** Per-aggregate Postgres schema — the owning context's schema, from
   *  `resolveDataSourceConfig` (`buildMigrations` passes a binding-aware
   *  resolver; mirrors `shapeOf`).  Defaults to `() => undefined` so
   *  callers (and the many `schemaFromModule(module)` unit tests) that
   *  have no system to resolve against keep the legacy unqualified
   *  output.  Every table an aggregate produces is stamped with its
   *  schema. */
  schemaOf: (agg: EnrichedAggregateIR) => string | undefined = () => undefined,
): SchemaSnapshot {
  const tables: TableShape[] = [];
  const pool = collectAggregates(module);
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
    // Event-sourced (`persistedAs(eventLog)`): an append-only stream table
    // keyed by `(stream_id, version)`, not a state table.  State is folded
    // from the stream at load time (appliers A2).  Mirrors the Drizzle
    // schema's `emitEventLogTable`.
    if (agg.persistedAs === "eventLog") {
      return [eventLogTableForStream(snake(agg.name), module.name)];
    }
    const shape = shapeOf(agg);
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
    const produced = tablesForOneAggregate(agg);
    const schema = schemaOf(agg);
    if (schema !== undefined) {
      for (const t of produced) t.schema = schema;
    }
    tables.push(...produced);
  }
  // Persisted workflow-correlation state tables (workflow-and-applier.md A2-S2):
  // one per correlation-bearing workflow, keyed by its correlation field with
  // the saga state fields as columns.  Emitted in the (unqualified) public
  // schema, matching the plain `pgTable(...)` the Drizzle schema emitter uses
  // for these, so the runtime DDL and the ORM mapping line up.
  for (const ctx of module.contexts) {
    const durable = durableEventTypes(ctx).size > 0;
    for (const wf of ctx.workflows) {
      // An `eventSourced` workflow persists as an append-only `<wf>_events`
      // stream (folded on load), not a mutable correlation-state row — the saga
      // analogue of a `persistedAs(eventLog)` aggregate (workflow-and-applier.md
      // A2-S5b).  A plain correlation-bearing workflow keeps its state table.
      if (wf.eventSourced) {
        tables.push(eventLogTableForStream(snake(wf.name), module.name));
      } else if (wf.correlationField) {
        tables.push(workflowStateTableShape(wf, module.name, voLookup, durable));
      }
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
function orderTablesByFkDependency(tables: TableShape[]): TableShape[] {
  const present = new Set(tables.map((t) => t.name));
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const s = new Set<string>();
    for (const fk of t.foreignKeys) {
      if (fk.refTable !== t.name && present.has(fk.refTable)) s.add(fk.refTable);
    }
    deps.set(t.name, s);
  }
  const remaining = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const emitted = new Set<string>();
  const order: TableShape[] = [];
  while (remaining.length > 0) {
    let idx = remaining.findIndex((t) => [...deps.get(t.name)!].every((d) => emitted.has(d)));
    if (idx === -1) idx = 0; // cycle — best effort, alphabetical
    const [t] = remaining.splice(idx, 1);
    order.push(t);
    emitted.add(t.name);
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

/** One append-only `<name>_events` stream table — the shared event-sourcing
 *  store shape, used by both a `persistedAs(eventLog)` aggregate (`stream_id` =
 *  aggregate id) and an `eventSourced` workflow (`stream_id` = correlation key).
 *  A row is one recorded event keyed by `(stream_id, version)` — `version` is
 *  its gap-free position in the stream.  `type` discriminates the event for the
 *  fold; `data` is the JSON payload; `occurred_at` defaults to insert time.
 *  No state / part / join tables — the read model is folded at load. */
function eventLogTableForStream(snakeName: string, ownerModule: string): TableShape {
  const tableName = `${snakeName}_events`;
  return {
    name: tableName,
    ownerModule,
    columns: [
      { name: "stream_id", type: { kind: "text" }, nullable: false },
      { name: "version", type: { kind: "int" }, nullable: false },
      { name: "type", type: { kind: "text" }, nullable: false },
      { name: "data", type: { kind: "json" }, nullable: false },
      { name: "occurred_at", type: { kind: "datetime" }, nullable: false, default: "now()" },
    ],
    primaryKey: ["stream_id", "version"],
    foreignKeys: [],
    indexes: [],
  };
}

export function diffSchema(prev: SchemaSnapshot | null, next: SchemaSnapshot): MigrationStep[] {
  const steps: MigrationStep[] = [];
  const prevByName = new Map<string, TableShape>();
  if (prev) for (const t of prev.tables) prevByName.set(t.name, t);
  const nextByName = new Map<string, TableShape>();
  for (const t of next.tables) nextByName.set(t.name, t);

  // Drops first — in alphabetical order of the prev side.
  if (prev) {
    const dropTables = [...prev.tables]
      .filter((t) => !nextByName.has(t.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const t of dropTables) steps.push({ op: "dropTable", name: t.name });
  }

  // Creates next — ordered so an FK target is created before the table
  // that references it (a child part otherwise sorts before its parent
  // and the inline `REFERENCES` fails).  FKs to tables already present
  // on the prev side are satisfied by an earlier migration, so only the
  // newly-created set constrains the order.
  const createTables = orderTablesByFkDependency(
    [...next.tables].filter((t) => !prevByName.has(t.name)),
  );
  for (const t of createTables) steps.push({ op: "createTable", table: t });

  // Per-table column / index diffs for tables present on both sides.
  for (const t of next.tables) {
    const prevT = prevByName.get(t.name);
    if (!prevT) continue;
    diffTable(prevT, t, steps);
  }

  return steps;
}

function diffTable(prev: TableShape, next: TableShape, steps: MigrationStep[]): void {
  const prevCols = new Map<string, ColumnShape>();
  for (const c of prev.columns) prevCols.set(c.name, c);
  const nextCols = new Map<string, ColumnShape>();
  for (const c of next.columns) nextCols.set(c.name, c);

  // Drops — iterate prev order so the op stream reads source-faithful.
  for (const c of prev.columns) {
    if (!nextCols.has(c.name)) {
      steps.push({ op: "dropColumn", table: next.name, name: c.name });
    }
  }
  // Adds — iterate next order; attach FK if present.
  for (const c of next.columns) {
    if (!prevCols.has(c.name)) {
      const fk = next.foreignKeys.find((f) => f.column === c.name);
      steps.push(
        fk
          ? { op: "addColumn", table: next.name, column: c, fk }
          : { op: "addColumn", table: next.name, column: c },
      );
    }
  }
  // Type / nullable alters — only for columns present on both sides.
  for (const c of next.columns) {
    const p = prevCols.get(c.name);
    if (!p) continue;
    if (p.nullable !== c.nullable) {
      steps.push({
        op: "alterColumnNullable",
        table: next.name,
        name: c.name,
        type: c.type,
        nullable: c.nullable,
      });
    }
    if (!columnTypeEqual(p.type, c.type)) {
      steps.push({
        op: "alterColumnType",
        table: next.name,
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
      steps.push({ op: "dropIndex", table: next.name, name: i.name });
    }
  }
  for (const i of next.indexes) {
    if (!prevIdx.has(i.name)) steps.push({ op: "addIndex", index: i });
  }
}

export function buildMigrations(sys: EnrichedSystemIR, snapshots: SnapshotStore): MigrationsIR[] {
  const out: MigrationsIR[] = [];
  for (const m of sys.subdomains) {
    if (!m.migrationsOwner) continue;
    // Binding-aware saving-shape resolver: resolve each aggregate's
    // effective shape via its (context, kind) dataSource binding so a
    // per-projection `shape:` override matches what the backend emitters
    // produce.  Falls back to the aggregate header when the aggregate's
    // owning context can't be located within the module.
    const shapeOf = (agg: EnrichedAggregateIR): SavingShape => {
      const ctx = m.contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
      if (!ctx) return effectiveSavingShape(agg);
      return effectiveSavingShape(agg, resolveDataSourceConfig(agg, ctx, sys));
    };
    // Same binding-aware resolution for the Postgres schema each table
    // lands in — the owning context's schema (`snake(ctx.name)` default,
    // or the dataSource `schema:` override).  Matches what the EF /
    // Drizzle table mappings resolve, so the migration DDL creates the
    // exact schema-qualified relations the backends query at runtime.
    const schemaOf = (agg: EnrichedAggregateIR): string | undefined => {
      const ctx = m.contexts.find((c) => c.aggregates.some((a) => a.name === agg.name));
      if (!ctx) return undefined;
      return resolveDataSourceConfig(agg, ctx, sys)?.schema;
    };
    const next = schemaFromModule(m, shapeOf, schemaOf);
    const baseline = snapshots.read(m.name);
    const steps = diffSchema(baseline, next);
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
    const stamped: SchemaSnapshot =
      steps.length === 0
        ? {
            ...next,
            lastVersion: baseline?.lastVersion ?? next.lastVersion,
            migrationHistory: prevHistory.length > 0 ? prevHistory : undefined,
          }
        : {
            ...next,
            lastVersion: version,
            migrationHistory: [...prevHistory, { version, name }],
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

// ---------------------------------------------------------------------------
// schemaFromModule helpers
// ---------------------------------------------------------------------------

function collectAggregates(module: EnrichedSubdomainIR): EnrichedAggregateIR[] {
  const acc: EnrichedAggregateIR[] = [];
  const ctxs = [...module.contexts].sort((a, b) => a.name.localeCompare(b.name));
  for (const ctx of ctxs) {
    const aggs = [...ctx.aggregates].sort((a, b) => a.name.localeCompare(b.name));
    for (const a of aggs) acc.push(a);
  }
  return acc;
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
  const indexes: IndexShape[] = [];

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
  const indexes: IndexShape[] = [];
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
  const parentTable = plural(snake(ownerName));
  const parentFk = `${snake(ownerName)}_id`;
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
      { name: assoc.ownerFk, type: idType, nullable: false },
      { name: assoc.targetFk, type: idType, nullable: false },
      // The wire contract for `Id<T>[]` is a set (composite PK above
      // enforces uniqueness, iteration order is not promised).  Ordinal
      // stays in the schema as a cross-backend column so TS/.NET can
      // write it as a diff-sync byproduct; Phoenix leaves it at the
      // default 0.  Nullable + defaulted so all three backends can
      // INSERT without it.
      { name: "ordinal", type: { kind: "int" }, nullable: true, default: "0" },
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
