import type {
  BoundedContextIR,
  FieldIR,
  TypeIR,
} from "../../../ir/loom-ir.js";
import { camel, plural, snake } from "../../../util/naming.js";
import { lines as joinLines } from "../../../util/code-builder.js";

// All-procedural Drizzle schema emission.  Column generation has too
// much per-field branching to express cleanly in any template engine,
// so the entire file is built with the `lines` helper + small per-table
// builders.
export function renderSchema(ctx: BoundedContextIR): string {
  const tables: string[] = [];
  for (const agg of ctx.aggregates) {
    tables.push(emitTable(agg.name, agg.fields, undefined, ctx));
    for (const part of agg.parts) {
      tables.push(emitTable(part.name, part.fields, agg.name, ctx));
    }
  }
  const enumLines = ctx.enums.map(
    (e) =>
      `export const ${camel(e.name)}Enum = pgEnum("${snake(e.name)}", [${e.values.map((v) => `"${v}"`).join(", ")}]);`,
  );
  return (
    joinLines(
      "// Auto-generated.",
      'import { pgTable, text, integer, bigint, numeric, boolean, timestamp, pgEnum, uuid } from "drizzle-orm/pg-core";',
      "",
      ...enumLines,
      "",
      tables.join("\n\n"),
    ) + "\n"
  );
}

function emitTable(
  name: string,
  fields: FieldIR[],
  parentName: string | undefined,
  ctx: BoundedContextIR,
): string {
  const tableName = snake(plural(name));
  const lines: string[] = [];
  lines.push(`export const ${camel(plural(name))} = pgTable("${tableName}", {`);
  lines.push(`  id: text("id").primaryKey(),`);
  if (parentName) {
    lines.push(`  parentId: text("${snake(parentName)}_id").notNull(),`);
  }
  for (const f of fields) {
    lines.push(...drizzleColumnLines(f, ctx).map((s) => `  ${s}`));
  }
  lines.push(`});`);
  return lines.join("\n");
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
        out.push(...drizzleColumnLinesForName(
          `${f.name}_${voField.name}`,
          voField.type,
          optional,
          ctx,
        ));
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
      return [`${fieldName}: ${camel(inner.name)}Enum("${colName}")${not},`];
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === inner.name);
      if (!vo) return [`${fieldName}: text("${colName}")${not},`];
      const out: string[] = [];
      for (const voField of vo.fields) {
        out.push(...drizzleColumnLinesForName(
          `${fieldName}_${voField.name}`,
          voField.type,
          opt,
          ctx,
        ));
      }
      return out;
    }
    case "entity":
      return [`${fieldName}: text("${colName}")${not},`];
    case "array":
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
