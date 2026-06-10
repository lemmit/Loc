import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
} from "../../../ir/types/loom-ir.js";
import { isTphBase, isTphConcrete } from "../../../ir/util/inheritance.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import { columnsForFields, joinRowClassName, type PyColumn, rowClassName } from "../py-columns.js";

// ---------------------------------------------------------------------------
// `app/db/schema.py` — SQLAlchemy 2 typed declarative models.  Table /
// column / index naming mirrors the Drizzle schema exactly (snake_case
// columns, `snake(plural(name))` tables, part FK column
// `<parent>_id` behind the `parent_id` attribute, join tables
// `snake(owner)_snake(field)` with composite PK + ordinal + reverse
// index) so every backend reads/writes the same shared Postgres DDL.
//
// Deferred shapes (guarded out, landing with their slices): TPH/TPC
// inheritance (S13), event-log + document + embedded persistence
// (S14), `<VO>[]` value-collection child tables, workflow state (S15).
// ---------------------------------------------------------------------------

export function renderPySchema(ctx: EnrichedBoundedContextIR): string {
  const models: string[] = [];
  for (const agg of ctx.aggregates) {
    if (agg.isAbstract || isTphBase(agg, ctx.aggregates) || isTphConcrete(agg, ctx.aggregates)) {
      continue; // inheritance lands in S13
    }
    if (agg.persistedAs === "eventLog") continue; // S14
    models.push(renderModel(agg.name, agg, undefined, ctx));
    for (const part of agg.parts) {
      models.push(renderModel(part.name, part, agg.name, ctx));
    }
    for (const assoc of (agg as EnrichedAggregateIR).associations ?? []) {
      models.push(renderJoinModel(assoc));
    }
  }
  const body = models.join("\n\n\n");

  // Import narrowing — every SQLAlchemy helper is invoked by name, so a
  // word-boundary scan is exact (same trick as the other emitters).
  const uses = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(body);
  const saNames = [
    "BigInteger",
    "Boolean",
    "DateTime",
    "Index",
    "Integer",
    "Numeric",
    "PrimaryKeyConstraint",
    "Text",
    "Uuid",
  ].filter(uses);
  const pgNames = ["ARRAY", "JSONB"].filter(uses);

  return lines(
    `"""SQLAlchemy persistence model.  Auto-generated."""`,
    "",
    uses("datetime") ? "from datetime import datetime" : null,
    uses("Decimal") ? "from decimal import Decimal" : null,
    uses("datetime") || uses("Decimal") ? "" : null,
    saNames.length > 0 ? `from sqlalchemy import ${saNames.join(", ")}` : null,
    pgNames.length > 0 ? `from sqlalchemy.dialects.postgresql import ${pgNames.join(", ")}` : null,
    "from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column",
    "",
    "",
    "class Base(DeclarativeBase):",
    "    pass",
    "",
    "",
    body,
    "",
  );
}

interface FieldOwner {
  fields: AggregateIR["fields"];
}

function renderModel(
  name: string,
  owner: FieldOwner,
  parentName: string | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const tableName = snake(plural(name));
  const cols: PyColumn[] = [
    { attr: "id", pyType: "str", saType: "Text", optional: false, primaryKey: true },
    ...(parentName
      ? [
          {
            attr: "parent_id",
            sqlName: `${snake(parentName)}_id`,
            pyType: "str",
            saType: "Text",
            optional: false,
          },
        ]
      : []),
    ...columnsForFields(owner.fields, ctx),
  ];
  const tableArgs = parentName
    ? [`        Index("${tableName}_parent_id_idx", "${snake(parentName)}_id"),`]
    : [];
  return lines(
    `class ${rowClassName(name)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    tableArgs.length > 0 ? ["    __table_args__ = (", ...tableArgs, "    )"] : null,
    "",
    cols.map(renderColumn),
  );
}

function renderColumn(c: PyColumn): string {
  const annotation = c.optional ? `${c.pyType} | None` : c.pyType;
  const args = [
    c.sqlName ? `"${c.sqlName}"` : null,
    c.saType,
    c.primaryKey ? "primary_key=True" : null,
  ].filter((a): a is string => a != null);
  return `    ${c.attr}: Mapped[${annotation}] = mapped_column(${args.join(", ")})`;
}

/** Many-to-many join table for a `T id[]` reference collection — two
 *  FK columns + ordinal, composite PK, reverse-membership index. */
function renderJoinModel(assoc: AssociationIR): string {
  return lines(
    `class ${joinRowClassName(assoc)}(Base):`,
    `    __tablename__ = "${assoc.joinTable}"`,
    "    __table_args__ = (",
    `        PrimaryKeyConstraint("${assoc.ownerFk}", "${assoc.targetFk}"),`,
    `        Index("${assoc.joinTable}_${assoc.targetFk}_idx", "${assoc.targetFk}"),`,
    "    )",
    "",
    `    ${assoc.ownerFk}: Mapped[str] = mapped_column(Text)`,
    `    ${assoc.targetFk}: Mapped[str] = mapped_column(Text)`,
    "    ordinal: Mapped[int] = mapped_column(Integer)",
  );
}
