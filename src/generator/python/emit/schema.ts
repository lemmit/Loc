import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import type { ResolvedDataSource } from "../../../ir/util/resolve-datasource.js";
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

export type PyDataSourceLookup = (agg: AggregateIR) => ResolvedDataSource | undefined;

export function renderPySchema(
  ctx: EnrichedBoundedContextIR,
  resolveDataSource?: PyDataSourceLookup,
): string {
  const models: string[] = [];
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs === "eventLog") {
      const ds14 = resolveDataSource?.(agg);
      models.push(renderEventLogModel(agg.name, ds14?.schema, ds14?.tablePrefix));
      continue;
    }
    // dataSource-driven routing — the table lives in the binding's
    // schema (default `snake(context)`), exactly where the shared DDL
    // (sql-pg) creates it.
    const ds = resolveDataSource?.(agg);
    const schema = ds?.schema;
    const prefix = ds?.tablePrefix;
    // TPH base: ONE shared table named for the base — id + kind
    // discriminator + base columns + every concrete's own columns
    // (forced nullable: only rows of that kind populate them).
    if (isTphBase(agg, ctx.aggregates)) {
      models.push(renderTphModel(agg, ctx, schema, prefix));
      continue;
    }
    // TPH concrete: shares the base's table (no model of its own), but
    // its contained parts still need tables — each FKs the SHARED
    // table, so the parent column is `<base>_id`.
    if (isTphConcrete(agg, ctx.aggregates)) {
      const owner = tableOwnerName(agg, ctx.aggregates);
      for (const part of agg.parts) {
        models.push(renderModel(part.name, part, owner, ctx, schema, prefix));
      }
      for (const assoc of (agg as EnrichedAggregateIR).associations ?? []) {
        models.push(renderJoinModel(assoc, schema, prefix));
      }
      continue;
    }
    // TPC base: owns no table (each concrete is standalone).
    if (agg.isAbstract) continue;
    models.push(renderModel(agg.name, agg, undefined, ctx, schema, prefix));
    for (const part of agg.parts) {
      models.push(renderModel(part.name, part, agg.name, ctx, schema, prefix));
    }
    for (const assoc of (agg as EnrichedAggregateIR).associations ?? []) {
      models.push(renderJoinModel(assoc, schema, prefix));
    }
  }
  // Persisted workflow-correlation state (workflow-and-applier.md A2-S2):
  // one row per running instance, keyed by the correlation field.  The
  // shared migration leaves these unqualified (public schema).
  for (const wf of ctx.workflows) {
    if (wf.correlationField) models.push(renderWorkflowStateModel(wf, ctx));
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
  schema?: string,
  prefix?: string,
): string {
  const tableName = `${prefix ?? ""}${snake(plural(name))}`;
  const cols: PyColumn[] = [
    { attr: "id", pyType: "str", saType: "Uuid(as_uuid=False)", optional: false, primaryKey: true },
    ...(parentName
      ? [
          {
            attr: "parent_id",
            sqlName: `${snake(parentName)}_id`,
            pyType: "str",
            saType: "Uuid(as_uuid=False)",
            optional: false,
          },
        ]
      : []),
    ...columnsForFields(owner.fields, ctx),
  ];
  const tableArgs = [
    ...(parentName
      ? [`        Index("${tableName}_parent_id_idx", "${snake(parentName)}_id"),`]
      : []),
    ...(schema ? [`        {"schema": "${schema}"},`] : []),
  ];
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

/** Append-only event stream for a `persistedAs(eventLog)` aggregate —
 *  `(stream_id, version)`-keyed; state rehydrates by folding. */
function renderEventLogModel(name: string, schema?: string, prefix?: string): string {
  const tableName = `${prefix ?? ""}${snake(name)}_events`;
  return lines(
    `class ${name}EventRow(Base):`,
    `    __tablename__ = "${tableName}"`,
    "    __table_args__ = (",
    `        PrimaryKeyConstraint("stream_id", "version"),`,
    ...(schema ? [`        {"schema": "${schema}"},`] : []),
    "    )",
    "",
    // The shared DDL types stream_id TEXT (Drizzle parity), not UUID.
    "    stream_id: Mapped[str] = mapped_column(Text)",
    "    version: Mapped[int] = mapped_column(Integer)",
    "    type: Mapped[str] = mapped_column(Text)",
    "    data: Mapped[object] = mapped_column(JSONB)",
    "    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))",
  );
}

/** Saga-state row for a correlation-bearing workflow — PK is the
 *  id-shaped correlation column (UUID, parity with the shared DDL);
 *  reference-collection state fields fold to JSONB. */
function renderWorkflowStateModel(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): string {
  const tableName = plural(snake(wf.name));
  const corr = wf.correlationField as string;
  const cols: PyColumn[] = [];
  for (const f of wf.stateFields ?? []) {
    if (f.name === corr) {
      cols.push({
        attr: snake(f.name),
        pyType: "str",
        saType: "Uuid(as_uuid=False)",
        optional: false,
        primaryKey: true,
      });
      continue;
    }
    const t = f.type.kind === "optional" ? f.type.inner : f.type;
    if (t.kind === "array" && t.element.kind === "id") {
      cols.push({
        attr: snake(f.name),
        pyType: "object",
        saType: "JSONB",
        optional: !!f.optional,
      });
      continue;
    }
    cols.push(...columnsForFields([f], ctx));
  }
  return lines(
    `class ${wf.name}Row(Base):`,
    `    __tablename__ = "${tableName}"`,
    "",
    cols.map(renderColumn),
  );
}

/** TPH shared-table model — the whole hierarchy in one table named for
 *  the abstract base (aggregate-inheritance.md). */
function renderTphModel(
  base: EnrichedBoundedContextIR["aggregates"][number],
  ctx: EnrichedBoundedContextIR,
  schema?: string,
  prefix?: string,
): string {
  const tableName = `${prefix ?? ""}${snake(plural(base.name))}`;
  const cols: PyColumn[] = [
    { attr: "id", pyType: "str", saType: "Uuid(as_uuid=False)", optional: false, primaryKey: true },
    { attr: "kind", pyType: "str", saType: "Text", optional: false },
    ...columnsForFields(base.fields, ctx),
  ];
  const seen = new Set(base.fields.map((f) => f.name));
  for (const concrete of tphConcretesOf(base, ctx.aggregates)) {
    for (const f of ownFieldsOf(concrete, base)) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      // Force nullable: only rows of this concrete's kind populate it.
      cols.push(...columnsForFields([{ ...f, optional: true }], ctx));
    }
  }
  return lines(
    `class ${rowClassName(base.name)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    schema ? ["    __table_args__ = (", `        {"schema": "${schema}"},`, "    )"] : null,
    "",
    cols.map(renderColumn),
  );
}

/** Many-to-many join table for a `T id[]` reference collection — two
 *  FK columns + ordinal, composite PK, reverse-membership index. */
function renderJoinModel(assoc: AssociationIR, schema?: string, prefix?: string): string {
  const tableName = `${prefix ?? ""}${assoc.joinTable}`;
  return lines(
    `class ${joinRowClassName(assoc)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    "    __table_args__ = (",
    `        PrimaryKeyConstraint("${assoc.ownerFk}", "${assoc.targetFk}"),`,
    `        Index("${assoc.joinTable}_${assoc.targetFk}_idx", "${assoc.targetFk}"),`,
    ...(schema ? [`        {"schema": "${schema}"},`] : []),
    "    )",
    "",
    `    ${assoc.ownerFk}: Mapped[str] = mapped_column(Uuid(as_uuid=False))`,
    `    ${assoc.targetFk}: Mapped[str] = mapped_column(Uuid(as_uuid=False))`,
    "    ordinal: Mapped[int] = mapped_column(Integer)",
  );
}
