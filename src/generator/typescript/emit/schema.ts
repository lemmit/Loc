import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import type { ResolvedDataSource } from "../../../ir/util/resolve-datasource.js";
import { effectiveSavingShape } from "../../../ir/util/resolve-datasource.js";
import { lines as joinLines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { isTphBase, isTphConcrete, ownFieldsOf, tableOwnerName, tphConcretesOf } from "../tph.js";

/** Per-aggregate dataSource lookup the orchestrator passes in.  Lets
 *  the schema emitter ask "what schema / tablePrefix does THIS
 *  aggregate's storage binding say?" without coupling to the
 *  resolver internals.  Returns `undefined` when the system has no
 *  matching dataSource — the table emits as a plain `pgTable(...)`
 *  with no schema qualifier, byte-identical with pre-dataSource emit.
 *  When defined, `.schema` is always populated (defaulted to
 *  `snake(context.name)` when the DSL omits `schema:`). */
export type DataSourceLookup = (agg: AggregateIR) => ResolvedDataSource | undefined;

/** Snake-case a schema name into a valid Drizzle const identifier with
 *  a `Schema` suffix (`sales` → `salesSchema`).  The suffix is what
 *  keeps the pgSchema declaration from colliding with a table const of
 *  the same lemma — e.g. context `Orders` defaults its schema to
 *  `"orders"` and the `Order` aggregate emits a table const `orders`,
 *  so the schema needs to live under a distinct name. */
function schemaConstName(schemaName: string): string {
  const camel = lowerFirst(
    schemaName
      .split(/[^a-zA-Z0-9]/)
      .filter(Boolean)
      .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
      .join(""),
  );
  return `${camel}Schema`;
}

// All-procedural Drizzle schema emission.  Column generation has too
// much per-field branching to express cleanly in any template engine,
// so the entire file is built with the `lines` helper + small per-table
// builders.
//
// Indexes: parts always get an index on their parentId column (joined
// on every aggregate load); aggregate roots get an index on every
// column referenced by a repository find — either by an explicit
// `where this.<col>` clause or by a convention-based parameter
// match.  Without these, common reads degrade to sequential scans
// once the table has more than a few hundred rows.
export function renderSchema(
  ctx: EnrichedBoundedContextIR,
  opts: {
    audit?: boolean;
    provenance?: boolean;
    /** Per-aggregate dataSource lookup — when present, the schema
     *  emitter routes each table through `pgSchema(...)` (when
     *  `schema` is set) and prepends `tablePrefix` to the table
     *  name.  Absent / returns undefined → byte-identical with the
     *  pre-dataSource single-`pgTable(...)` shape.  Join tables and
     *  the audit / provenance tables inherit the schema of the
     *  aggregate they belong to (or stay schemaless when there's no
     *  binding). */
    resolveDataSource?: DataSourceLookup;
  } = {},
): string {
  const lookup = opts.resolveDataSource;
  // Collect every distinct schema name we'll need across the body so
  // we can emit ONE `pgSchema(...)` declaration at the top per
  // schema.  Order: insertion order from the aggregate walk.
  const schemaNames: string[] = [];
  const schemaSeen = new Set<string>();
  const schemaFor = (agg: AggregateIR): string | undefined => {
    const ds = lookup?.(agg);
    if (!ds?.schema) return undefined;
    if (!schemaSeen.has(ds.schema)) {
      schemaSeen.add(ds.schema);
      schemaNames.push(ds.schema);
    }
    return ds.schema;
  };
  const prefixFor = (agg: AggregateIR): string | undefined => lookup?.(agg)?.tablePrefix;
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    const schema = schemaFor(agg);
    const prefix = prefixFor(agg);
    // An abstract base that is NOT a TPH base owns no table.  A TPC
    // (`ownTable`) base is kept in the generation view only so the base-reader
    // pass can emit its polymorphic `find all <Base>` reader — it must not emit
    // a table of its own (each concrete is standalone).  The TPH base falls
    // through to `emitTphTable` below; every other abstract base emits nothing.
    if (agg.isAbstract && !isTphBase(agg, ctx.aggregates)) continue;
    // TPH (aggregate-inheritance.md, sharedTable): the whole hierarchy is one
    // table named for the abstract base.  A TPH concrete shares it, so it
    // emits no table of its own; the abstract base emits the shared table
    // (base columns + every concrete's own columns, made nullable, + the
    // `kind` discriminator).
    if (isTphConcrete(agg, ctx.aggregates)) {
      // …but a TPH concrete's contained parts still need their own tables.
      // Each part FKs the SHARED base table (the concrete has no table of its
      // own), so the parent name resolves through `tableOwnerName` — the part
      // row's `parentId` holds the shared-table row id, which is exactly the
      // concrete's id (Pattern 4, TPT-via-`contains`).  `emitTable` keys the
      // parts otherwise identically to a plain aggregate's.
      const owner = tableOwnerName(agg, ctx.aggregates);
      for (const part of agg.parts) {
        tables.push(emitTable(part.name, part.fields, owner, ctx, new Set(), { schema, prefix }));
      }
      continue;
    }
    if (isTphBase(agg, ctx.aggregates)) {
      tables.push(emitTphTable(agg, ctx, { schema, prefix }));
      continue;
    }
    const shape = effectiveSavingShape(agg, lookup?.(agg));
    // Document (`shape(document)`): the whole aggregate is one opaque
    // jsonb blob (`id, data, version`).  No part/join tables.
    if (shape === "document") {
      tables.push(emitDocumentTable(agg.name, { schema, prefix }));
      continue;
    }
    // Embedded (`shape(embedded)`): queryable root row + one jsonb column
    // per containment.  No part tables, no join tables.
    if (shape === "embedded") {
      tables.push(emitEmbeddedTable(agg, ctx, indexedColumnsFor(agg, ctx), { schema, prefix }));
      continue;
    }
    const indexed = indexedColumnsFor(agg, ctx);
    tables.push(emitTable(agg.name, agg.fields, undefined, ctx, indexed, { schema, prefix }));
    for (const part of agg.parts) {
      tables.push(emitTable(part.name, part.fields, agg.name, ctx, new Set(), { schema, prefix }));
    }
    // Many-to-many join tables for `T id[]` reference collections.
    // Live in the same schema as the owning aggregate so cross-table
    // FKs stay valid.
    for (const assoc of agg.associations) {
      tables.push(emitJoinTable(assoc, { schema, prefix }));
    }
  }
  if (opts.audit) tables.push(AUDIT_TABLE);
  if (opts.provenance) tables.push(PROVENANCE_TABLE);
  const schemaDecls = schemaNames.map(
    (name) => `export const ${schemaConstName(name)} = pgSchema("${name}");`,
  );
  const enumLines = ctx.enums.map(
    (e) =>
      `export const ${lowerFirst(e.name)}Enum = pgEnum("${snake(e.name)}", [${e.values.map((v) => `"${v}"`).join(", ")}]);`,
  );
  // Derive the drizzle-pg-core import list from what the body actually
  // calls — every helper here is invoked as a function (`text(...)`,
  // `pgEnum(...)`, etc.), so a `\b<name>\(` scan is exact and keeps the
  // import line free of dead names per the generated-code Biome gate.
  const body = [...schemaDecls, ...enumLines, "", tables.join("\n\n")].join("\n");
  const candidates = [
    "pgTable",
    "pgSchema",
    "text",
    "integer",
    "bigint",
    "numeric",
    "boolean",
    "timestamp",
    "pgEnum",
    "uuid",
    "index",
    "primaryKey",
    "jsonb",
  ];
  // `(?<!\.)` excludes method calls like `text("id").primaryKey()` so we
  // only import a helper when it's invoked as a top-level function call.
  const imports = candidates.filter((c) => new RegExp(`(?<!\\.)\\b${c}\\(`).test(body)).join(", ");
  return (
    joinLines(
      "// Auto-generated.",
      `import { ${imports} } from "drizzle-orm/pg-core";`,
      "",
      ...(schemaDecls.length > 0 ? [...schemaDecls, ""] : []),
      ...enumLines,
      "",
      tables.join("\n\n"),
    ) + "\n"
  );
}

/** A many-to-many join table for an `T id[]` reference collection.
 * Two FK columns + an `ordinal` position so the collection's order
 * survives a round-trip, a composite primary key over (owner, target)
 * (so each pair is unique and the save upsert is idempotent), and an
 * index on the target FK for the reverse membership query. */
function emitJoinTable(
  assoc: AssociationIR,
  options: { schema?: string; prefix?: string } = {},
): string {
  const tableConst = joinTableConstName(assoc);
  const ownerKey = joinColumnName(assoc.ownerFk);
  const targetKey = joinColumnName(assoc.targetFk);
  const lines: string[] = [];
  const baseTable = assoc.joinTable;
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  lines.push(`export const ${tableConst} = ${tableFactory}("${tableName}", {`);
  lines.push(`  ${ownerKey}: text("${assoc.ownerFk}").notNull(),`);
  lines.push(`  ${targetKey}: text("${assoc.targetFk}").notNull(),`);
  lines.push(`  ordinal: integer("ordinal").notNull(),`);
  lines.push(`}, (table) => ({`);
  lines.push(
    `  ${tableConst}Pk: primaryKey({ columns: [table.${ownerKey}, table.${targetKey}] }),`,
  );
  lines.push(
    `  ${tableConst}TargetIdx: index("${assoc.joinTable}_${assoc.targetFk}_idx").on(table.${targetKey}),`,
  );
  lines.push(`}));`);
  return lines.join("\n");
}

/** Drizzle `const` name for a join table — `trainer_party` →
 * `trainerParty`.  Shared with the repository builder so both refer to
 * the same `schema.<const>`. */
export function joinTableConstName(assoc: AssociationIR): string {
  return lowerFirst(camelizeSnake(assoc.joinTable));
}

/** Drizzle column-property key for a join FK — `pokemon_id` →
 * `pokemonId`.  The SQL column name stays snake_case. */
export function joinColumnName(fk: string): string {
  return camelizeSnake(fk);
}

/** `trainer_party` → `trainerParty`; `pokemon_id` → `pokemonId`. */
function camelizeSnake(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

// Audit-log table.  Emitted only when the model declares at least one
// `audited` operation.  One row per successful audited invocation, written
// in the same transaction as the operation's aggregate save (atomic — the
// row and the state change commit or roll back together).  See
// `docs/proposals/audit-and-logging.md`.
const AUDIT_TABLE = `export const auditRecords = pgTable("audit_records", {
  auditId: text("audit_id").primaryKey(),
  operationId: text("operation_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  actor: jsonb("actor"),
  before: jsonb("before").notNull(),
  after: jsonb("after").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
}, (t) => [index("audit_records_target_idx").on(t.targetType, t.targetId)]);`;

// Provenance history table.  Emitted only when the model declares at least
// one written `provenanced` field.  One append-only row per provenanced
// write, inserted in the same transaction as the operation's aggregate
// save (atomic).  The current lineage is *also* stored co-located on the
// aggregate row's `<field>_provenance` jsonb column; this table is the
// full per-write history.
const PROVENANCE_TABLE = `export const provenanceRecords = pgTable("provenance_records", {
  traceId: text("trace_id").primaryKey(),
  snapshotId: text("snapshot_id").notNull(),
  targetType: text("target_type").notNull(),
  field: text("field").notNull(),
  inputs: jsonb("inputs").notNull(),
  computedValue: jsonb("computed_value"),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [index("provenance_records_target_idx").on(t.targetType, t.field)]);`;

/** Field names on the aggregate root that should be indexed so the
 * generated finds don't run sequential scans.  Walks every find: if
 * it has an explicit `where` clause, indexes the column refs;
 * otherwise indexes the column matching each parameter by name
 * (mirrors the convention in `repository-builder.ts:findQueryMethod`). */
function indexedColumnsFor(agg: AggregateIR, ctx: BoundedContextIR): Set<string> {
  const out = new Set<string>();
  const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
  if (!repo) return out;
  for (const find of repo.finds) {
    if (find.filter) {
      collectColumnRefs(find.filter, out);
    } else {
      for (const p of find.params) {
        const matched = agg.fields.find(
          (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
        );
        if (matched) out.add(matched.name);
      }
    }
  }
  return out;
}

/** Walks a queryable `where` IR expression and adds every `this.<col>`
 * (and `this.<vo>.<sub>` flattened-VO column) it references. */
function collectColumnRefs(e: ExprIR, out: Set<string>): void {
  switch (e.kind) {
    case "binary":
      collectColumnRefs(e.left, out);
      collectColumnRefs(e.right, out);
      return;
    case "paren":
      collectColumnRefs(e.inner, out);
      return;
    case "unary":
      collectColumnRefs(e.operand, out);
      return;
    case "ref":
      if (e.refKind === "this-prop" || e.refKind === "this-vo-prop") {
        out.add(e.name);
      }
      return;
    case "member":
      if (e.receiver.kind === "this") {
        out.add(e.member);
      } else if (e.receiver.kind === "member" && e.receiver.receiver.kind === "this") {
        // `this.vo.sub` — Drizzle column is `<vo>_<sub>`.
        out.add(`${e.receiver.member}_${e.member}`);
      }
      return;
    default:
      return;
  }
}

/** Embedded-children persistence table (`shape(embedded)`): the root's
 *  scalar / `X id` fields stay queryable columns (like the relational
 *  root), but each containment folds into a single jsonb column and
 *  reference collections into a jsonb id-array column.  No part tables,
 *  no join tables.  Mirrors the EF owned-`.ToJson()` / Ash embedded
 *  shape and the shared embedded migration table. */
function emitEmbeddedTable(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  indexedColumns: Set<string>,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(agg.name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const lines: string[] = [];
  lines.push(`export const ${lowerFirst(plural(agg.name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: text("id").primaryKey(),`);
  for (const f of agg.fields) {
    if (f.type.kind === "array" && f.type.element.kind === "id") {
      const not = f.optional ? "" : ".notNull()";
      lines.push(`  ${f.name}: jsonb("${snake(f.name)}")${not},`);
      continue;
    }
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  for (const c of agg.contains) {
    lines.push(`  ${c.name}: jsonb("${snake(c.name)}").notNull(),`);
  }
  const indexEntries = [...indexedColumns].map(
    (col) =>
      `    ${lowerFirst(agg.name)}${pascalize(col)}Idx: index("${tableName}_${snake(col)}_idx").on(table.${col}),`,
  );
  if (indexEntries.length === 0) {
    lines.push(`});`);
  } else {
    lines.push(`}, (table) => ({`);
    lines.push(...indexEntries);
    lines.push(`}));`);
  }
  return lines.join("\n");
}

/** Document-shaped persistence table: one jsonb `data` column holding
 *  the whole serialised aggregate read model + a `version` concurrency
 *  counter.  Mirrors the .NET `<Agg>Document` record. */
function emitDocumentTable(
  name: string,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  return [
    `export const ${lowerFirst(plural(name))} = ${tableFactory}("${tableName}", {`,
    `  id: text("id").primaryKey(),`,
    `  data: jsonb("data").notNull(),`,
    `  version: integer("version").notNull(),`,
    `});`,
  ].join("\n");
}

/** TPH shared table (aggregate-inheritance.md, sharedTable): one table for
 *  the whole hierarchy.  Columns are `id`, the `kind` discriminator, the
 *  abstract base's own columns (keeping their declared nullability), then
 *  every concrete subtype's own columns forced nullable (a row is only ever
 *  one `kind`, so the other kinds' columns are null).  Concrete columns are
 *  de-duplicated by name (first declaration wins) — a later validator can
 *  tighten clashing redeclarations.  v1 covers scalar / value-object / enum /
 *  id columns; parts, containments, and reference collections on a TPH
 *  hierarchy are a later slice. */
function emitTphTable(
  base: AggregateIR,
  ctx: BoundedContextIR,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(base.name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  const lines: string[] = [];
  lines.push(`export const ${lowerFirst(plural(base.name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: text("id").primaryKey(),`);
  lines.push(`  kind: text("kind").notNull(),`);
  for (const f of base.fields) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  const seen = new Set(base.fields.map((f) => f.name));
  for (const concrete of tphConcretesOf(base, ctx.aggregates)) {
    for (const f of ownFieldsOf(concrete, base)) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      // Force nullable: only rows of this concrete's `kind` populate it.
      lines.push(...drizzleColumnLines({ ...f, optional: true }, ctx).map((s) => `  ${s}`));
    }
  }
  lines.push(`});`);
  return lines.join("\n");
}

function emitTable(
  name: string,
  fields: FieldIR[],
  parentName: string | undefined,
  ctx: BoundedContextIR,
  indexedColumns: Set<string>,
  options: { schema?: string; prefix?: string } = {},
): string {
  const baseTable = snake(plural(name));
  const tableName = options.prefix ? `${options.prefix}${baseTable}` : baseTable;
  const lines: string[] = [];
  // dataSource-driven schema routing: when the owning aggregate's
  // dataSource declares `schema: "tenant_a"`, the table goes through
  // the schema's `.table(...)` factory instead of the top-level
  // `pgTable(...)` — same shape on the database side, Drizzle
  // qualifies the SQL with the schema name.
  const tableFactory = options.schema ? `${schemaConstName(options.schema)}.table` : "pgTable";
  lines.push(`export const ${lowerFirst(plural(name))} = ${tableFactory}("${tableName}", {`);
  lines.push(`  id: text("id").primaryKey(),`);
  if (parentName) {
    lines.push(`  parentId: text("${snake(parentName)}_id").notNull(),`);
  }
  for (const f of fields) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  // Co-located provenance: a `<field>_provenance` jsonb column holding the
  // current lineage for each provenanced field.  Typed (via `$type`) as
  // the ProvLineage shape so save/hydrate/toWire round-trip without casts.
  for (const f of fields) {
    if (!f.provenanced) continue;
    lines.push(
      `  ${f.name}_provenance: jsonb("${snake(f.name)}_provenance").$type<import("../domain/provenance").ProvLineage>(),`,
    );
  }
  // Index callback — Drizzle's pgTable accepts a second arg
  // `(table) => ({ idxName: index(...).on(table.col) })`.  We emit
  // an entry for parts' `parentId` (joined every read) plus every
  // root column referenced by a find.
  const indexEntries: string[] = [];
  if (parentName) {
    indexEntries.push(
      `    ${lowerFirst(name)}ParentIdIdx: index("${tableName}_parent_id_idx").on(table.parentId),`,
    );
  }
  for (const col of indexedColumns) {
    indexEntries.push(
      `    ${lowerFirst(name)}${pascalize(col)}Idx: index("${tableName}_${snake(col)}_idx").on(table.${col}),`,
    );
  }
  if (indexEntries.length === 0) {
    lines.push(`});`);
  } else {
    lines.push(`}, (table) => ({`);
    lines.push(...indexEntries);
    lines.push(`}));`);
  }
  return lines.join("\n");
}

function pascalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function drizzleColumnLines(f: FieldIR, ctx: BoundedContextIR): string[] {
  const t = f.type;
  const optional = f.optional || t.kind === "optional";
  const innerType = t.kind === "optional" ? t.inner : t;
  // Value-object fields inline as multiple columns named
  // `<prefix>_<vo_field>`; this keeps queries on single columns and avoids
  // an additional join for simple flattenable VOs.
  if (innerType.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === innerType.name);
    if (vo) {
      const out: string[] = [];
      for (const voField of vo.fields) {
        out.push(
          ...drizzleColumnLinesForName(`${f.name}_${voField.name}`, voField.type, optional, ctx),
        );
      }
      return out;
    }
  }
  return drizzleColumnLinesForName(f.name, innerType, optional, ctx);
}

function drizzleColumnLinesForName(
  fieldName: string,
  t: TypeIR,
  optional: boolean,
  ctx: BoundedContextIR,
): string[] {
  const colName = snake(fieldName);
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = optional || t.kind === "optional";
  const not = opt ? "" : ".notNull()";
  switch (inner.kind) {
    case "primitive":
      switch (inner.name) {
        case "int":
          return [`${fieldName}: integer("${colName}")${not},`];
        case "long":
          return [`${fieldName}: bigint("${colName}", { mode: "number" })${not},`];
        case "decimal":
          return [`${fieldName}: numeric("${colName}")${not},`];
        case "money":
          // Bounded NUMERIC(19,4) is the finance default — same shape
          // sqlx + rust_decimal will read cleanly when the Rust
          // backend lands.  Drizzle's numeric() returns a string at
          // runtime so the repository-builder hydrates via
          // `new Decimal(row.col)` without precision loss.
          return [`${fieldName}: numeric("${colName}", { precision: 19, scale: 4 })${not},`];
        case "string":
          return [`${fieldName}: text("${colName}")${not},`];
        case "bool":
          return [`${fieldName}: boolean("${colName}")${not},`];
        case "datetime":
          return [`${fieldName}: timestamp("${colName}", { withTimezone: true })${not},`];
        case "guid":
          return [`${fieldName}: uuid("${colName}")${not},`];
        case "json":
          return [`${fieldName}: jsonb("${colName}")${not},`];
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return [`${fieldName}: text("${colName}")${not},`];
    case "enum":
      return [`${fieldName}: ${lowerFirst(inner.name)}Enum("${colName}")${not},`];
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (!vo) return [`${fieldName}: text("${colName}")${not},`];
      const out: string[] = [];
      for (const voField of vo.fields) {
        out.push(
          ...drizzleColumnLinesForName(`${fieldName}_${voField.name}`, voField.type, opt, ctx),
        );
      }
      return out;
    }
    case "entity":
      return [`${fieldName}: text("${colName}")${not},`];
    case "array":
      // Collections of references (`T id[]`) are persisted as a
      // many-to-many join table (emitted separately in renderSchema),
      // so they contribute no column on the owning table.
      if (inner.element.kind === "id") return [];
      return [`${fieldName}: text("${colName}")${not}, // arrays not supported as inline columns`];
    case "optional":
      return drizzleColumnLinesForName(fieldName, inner.inner, true, ctx);
    case "slot":
      throw new Error(
        "drizzleColumnLinesForName: 'slot' type is UI-only and should not reach the schema emitter.",
      );
    case "genericInstance":
      throw new Error(
        `drizzleColumnLinesForName: generic carrier '${inner.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
  }
}

// Used by the repository builder to learn which columns a value-object
// field expands into.
export function valueObjectColumnNames(
  ownerFieldName: string,
  voName: string,
  ctx: BoundedContextIR,
): { columnName: string; subFieldName: string; type: TypeIR }[] {
  const vo = ctx.valueObjects.find((v) => v.name === voName);
  if (!vo) return [];
  return vo.fields.map((f) => ({
    columnName: `${ownerFieldName}_${f.name}`,
    subFieldName: f.name,
    type: f.type,
  }));
}
