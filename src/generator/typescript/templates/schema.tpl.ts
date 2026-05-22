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
export function renderSchema(ctx: BoundedContextIR): string {
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    const indexed = indexedColumnsFor(agg, ctx);
    tables.push(emitTable(agg.name, agg.fields, undefined, ctx, indexed));
    for (const part of agg.parts) {
      tables.push(emitTable(part.name, part.fields, agg.name, ctx, new Set()));
    }
    // Many-to-many join tables for `Id<T>[]` reference collections.
    for (const assoc of agg.associations ?? []) {
      tables.push(emitJoinTable(assoc));
    }
  }
  const enumLines = ctx.enums.map(
    (e) =>
      `export const ${lowerFirst(e.name)}Enum = pgEnum("${snake(e.name)}", [${e.values.map((v) => `"${v}"`).join(", ")}]);`,
  );
  // `primaryKey` is only needed when the context has at least one
  // reference-collection join table; keeping it out otherwise leaves
  // every existing schema's import line byte-identical.
  const hasJoinTables = ctx.aggregates.some((a) => (a.associations ?? []).length > 0);
  const imports = [
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
    ...(hasJoinTables ? ["primaryKey"] : []),
  ].join(", ");
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

/** A many-to-many join table for an `Id<T>[]` reference collection.
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
      // Collections of references (`Id<T>[]`) are persisted as a
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
