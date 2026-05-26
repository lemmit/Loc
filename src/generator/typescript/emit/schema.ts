import type {
  AggregateIR,
  AssociationIR,
  BoundedContextIR,
  ExprIR,
  FieldIR,
  TypeIR,
} from "../../../ir/loom-ir.js";
import { lines as joinLines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";

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
  ctx: BoundedContextIR,
  opts: { audit?: boolean; provenance?: boolean } = {},
): string {
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    const indexed = indexedColumnsFor(agg, ctx);
    tables.push(emitTable(agg.name, agg.fields, undefined, ctx, indexed));
    for (const part of agg.parts) {
      tables.push(emitTable(part.name, part.fields, agg.name, ctx, new Set()));
    }
    // Many-to-many join tables for `T id[]` reference collections.
    for (const assoc of agg.associations!) {
      tables.push(emitJoinTable(assoc));
    }
  }
  if (opts.audit) tables.push(AUDIT_TABLE);
  if (opts.provenance) tables.push(PROVENANCE_TABLE);
  const enumLines = ctx.enums.map(
    (e) =>
      `export const ${lowerFirst(e.name)}Enum = pgEnum("${snake(e.name)}", [${e.values.map((v) => `"${v}"`).join(", ")}]);`,
  );
  // Derive the drizzle-pg-core import list from what the body actually
  // calls — every helper here is invoked as a function (`text(...)`,
  // `pgEnum(...)`, etc.), so a `\b<name>\(` scan is exact and keeps the
  // import line free of dead names per the generated-code Biome gate.
  const body = [...enumLines, "", tables.join("\n\n")].join("\n");
  const candidates = [
    "pgTable",
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
function emitJoinTable(assoc: AssociationIR): string {
  const tableConst = joinTableConstName(assoc);
  const ownerKey = joinColumnName(assoc.ownerFk);
  const targetKey = joinColumnName(assoc.targetFk);
  const lines: string[] = [];
  lines.push(`export const ${tableConst} = pgTable("${assoc.joinTable}", {`);
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

function emitTable(
  name: string,
  fields: FieldIR[],
  parentName: string | undefined,
  ctx: BoundedContextIR,
  indexedColumns: Set<string>,
): string {
  const tableName = snake(plural(name));
  const lines: string[] = [];
  lines.push(`export const ${lowerFirst(plural(name))} = pgTable("${tableName}", {`);
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
