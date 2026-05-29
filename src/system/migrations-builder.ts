import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedSubdomainIR,
  EnrichedSystemIR,
  EntityPartIR,
  FieldIR,
  IdValueType,
  SubdomainIR,
  SystemIR,
  TypeIR,
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
import { effectiveSavingShape, resolveDataSourceConfig } from "../ir/util/resolve-datasource.js";
import type { SavingShape } from "../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../util/naming.js";
import type { SnapshotStore } from "./snapshot.js";

// ---------------------------------------------------------------------------
// MigrationsIR builder + diff.
//
// `schemaFromModule` is the single source of truth for "what tables this
// module needs"; both the Phoenix refactor (was inline at
// `phoenix-live-view/migrations-emit.ts`) and the new TS / .NET emitters
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
   *  stays consistent with the EF/Drizzle/Ash emitters, which resolve
   *  the same way via `effectiveSavingShape`). */
  shapeOf: (agg: EnrichedAggregateIR) => SavingShape = (agg) => effectiveSavingShape(agg),
): SchemaSnapshot {
  const tables: TableShape[] = [];
  for (const agg of collectAggregates(module)) {
    const shape = shapeOf(agg);
    if (shape === "document") {
      tables.push(documentTableForAggregate(agg, module.name));
      continue;
    }
    if (shape === "embedded") {
      tables.push(embeddedTableForAggregate(agg, module.name));
      continue;
    }
    tables.push(tableForAggregate(agg, module.name));
    for (const part of agg.parts) {
      tables.push(tableForPart(part, agg, module.name));
    }
    // Reference-collection fields (`Target id[]`) persist via a join
    // table rather than a column on the owner row — enrichment derives
    // one `AssociationIR` per such field, and the schema picks them up
    // here.  `tableForAggregate` / `tableForPart` skip the column at
    // emission time (see `mapField`).
    for (const assoc of agg.associations) {
      tables.push(tableForAssociation(assoc, module.name));
    }
  }
  tables.sort((a, b) => a.name.localeCompare(b.name));
  return { schemaVersion: 1, tables };
}

/** Embedded-children aggregate (`shape(embedded)`): the root stays a
 *  normal queryable row — `id` plus its scalar / `X id` columns, exactly
 *  like the relational root — but each containment folds into a single
 *  JSONB column (the contained parts serialised inline) and reference
 *  collections fold into a JSONB id-array column.  No part tables, no
 *  join tables.  This is the shape EF owned-types `.ToJson()`, Drizzle
 *  jsonb columns, and Ash embedded resources all map to natively — one
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
    columns.push({ name: snake(c.name), type: { kind: "json" }, nullable: false });
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

  // Creates next — alphabetical order of the next side (snapshot is
  // already sorted, but the builder defends).
  const createTables = [...next.tables]
    .filter((t) => !prevByName.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
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
    const next = schemaFromModule(m, shapeOf);
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

function tableForAggregate(agg: AggregateIR, ownerModule: string): TableShape {
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

  return {
    name: tableName,
    ownerModule,
    columns,
    primaryKey: ["id"],
    foreignKeys,
    indexes,
  };
}

function tableForPart(part: EntityPartIR, parent: AggregateIR, ownerModule: string): TableShape {
  const tableName = plural(snake(part.name));
  const parentTable = plural(snake(parent.name));
  const parentFk = `${snake(parent.name)}_id`;
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

function isReferenceCollection(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "id";
}

interface MappedColumn {
  column: ColumnShape;
  /** Set iff this column references another aggregate's table. */
  fkRefTable?: string;
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
    case "slot":
      throw new Error(
        "mapTypeToColumn: 'slot' type is UI-only and should not reach the migrations builder.",
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
