import type {
  AggregateIR,
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ProjectionIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { durableEventTypes } from "../../../ir/util/channels.js";
import { directParentName } from "../../../ir/util/containment-parent.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import type { ResolvedDataSource } from "../../../ir/util/resolve-datasource.js";
import { effectiveSavingShape } from "../../../ir/util/resolve-datasource.js";
import { type ValueCollectionIR, valueCollectionsFor } from "../../../ir/util/value-collections.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake } from "../../../util/naming.js";
import {
  columnsForFields,
  contextEventRowClassName,
  contextEventsTableName,
  isRefCollectionField,
  joinRowClassName,
  type PyColumn,
  rowClassName,
  valueCollectionChildColumns,
  valueCollectionRowClassName,
} from "../py-columns.js";
import { provColumn } from "./provenance.js";

// ---------------------------------------------------------------------------
// `app/db/schema.py` — SQLAlchemy 2 typed declarative models.  Table /
// column / index naming mirrors the Drizzle schema exactly (snake_case
// columns, `snake(plural(name))` tables, part FK column
// `<parent>_id` behind the `parent_id` attribute, join tables
// `snake(owner)_snake(field)` with composite PK + reverse index) so
// every backend reads/writes the same shared Postgres DDL.
//
// Deferred shapes (guarded out, landing with their slices): TPH/TPC
// inheritance (S13), event-log + document + embedded persistence
// (S14), `<VO>[]` value-collection child tables, workflow state (S15).
// ---------------------------------------------------------------------------

export type PyDataSourceLookup = (agg: AggregateIR) => ResolvedDataSource | undefined;

export function renderPySchema(
  ctx: EnrichedBoundedContextIR,
  resolveDataSource?: PyDataSourceLookup,
  /** Per-workflow saga-table schema, resolved from the workflow's OWNING
   *  context (`ctx` here may be a merged union).  Built by the caller via
   *  `resolveContextSchema`; undefined → unqualified, byte-identical. */
  resolveWorkflowSchema?: (wf: WorkflowIR) => string | undefined,
  /** Per-projection read-model-table schema — same owning-context map-back. */
  resolveProjectionSchema?: (proj: ProjectionIR) => string | undefined,
  /** Per-stream OWNING-context name lookup — maps an event-sourced aggregate /
   *  workflow name to the context that declares it.  This `ctx` may be a merged
   *  union (multi-context deployable), so the per-context `<ctx>_events` model
   *  must be named after the stream's OWNING context (matching the repository +
   *  migrations), not the merged `ctx.name`.  Absent → the merged `ctx.name`,
   *  byte-identical for single-context systems. */
  resolveStreamContext?: (streamName: string) => string | undefined,
): string {
  const models: string[] = [];
  for (const agg of ctx.aggregates) {
    // Event-sourced (`persistedAs(eventLog)`): the aggregate's stream lives in
    // the single per-context `<ctx>_events` log emitted once below (shared by
    // every ES aggregate + ES workflow, discriminated by `stream_type`), not a
    // per-aggregate table.
    if (agg.persistedAs === "eventLog") continue;
    // shape(document): the whole aggregate tree is one jsonb blob — the
    // canonical document triple `(id, data, version)`.
    if (effectiveSavingShape(agg as EnrichedAggregateIR, resolveDataSource?.(agg)) === "document") {
      const dds = resolveDataSource?.(agg);
      models.push(renderDocumentModel(agg, dds?.schema, dds?.tablePrefix));
      continue;
    }
    // shape(embedded): the root stays a queryable row, but each
    // containment folds into one JSONB column and reference collections
    // fold into a JSONB id-array column — no part / join tables.
    if (effectiveSavingShape(agg as EnrichedAggregateIR, resolveDataSource?.(agg)) === "embedded") {
      const eds = resolveDataSource?.(agg);
      models.push(renderEmbeddedModel(agg, ctx, eds?.schema, eds?.tablePrefix));
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
        models.push(
          renderModel(
            part.name,
            part,
            directParentName(agg, part.name, owner),
            ctx,
            schema,
            prefix,
          ),
        );
      }
      for (const assoc of (agg as EnrichedAggregateIR).associations ?? []) {
        models.push(renderJoinModel(assoc, schema, prefix));
      }
      // Value-object collections (`<VO>[]`) on a TPH concrete or its parts
      // persist as id-less child tables (the parent FK points at the SHARED
      // base table for the concrete's own VO[] fields).
      for (const vc of valueCollectionsFor(agg)) {
        models.push(renderValueCollectionModel(vc, ctx, schema, prefix));
      }
      for (const part of agg.parts) {
        for (const vc of valueCollectionsFor(part)) {
          models.push(renderValueCollectionModel(vc, ctx, schema, prefix));
        }
      }
      continue;
    }
    // TPC base: owns no table (each concrete is standalone).
    if (agg.isAbstract) continue;
    models.push(renderModel(agg.name, agg, undefined, ctx, schema, prefix));
    for (const part of agg.parts) {
      models.push(
        renderModel(
          part.name,
          part,
          directParentName(agg, part.name, agg.name),
          ctx,
          schema,
          prefix,
        ),
      );
    }
    for (const assoc of (agg as EnrichedAggregateIR).associations ?? []) {
      models.push(renderJoinModel(assoc, schema, prefix));
    }
    // Id-less child tables for `<VO>[]` value-object collections — one row
    // per element keyed by (parent_fk, ordinal), columns flattened from the
    // value object.  Plain relational shape, portable across SQL backends.
    for (const vc of valueCollectionsFor(agg)) {
      models.push(renderValueCollectionModel(vc, ctx, schema, prefix));
    }
    for (const part of agg.parts) {
      for (const vc of valueCollectionsFor(part)) {
        models.push(renderValueCollectionModel(vc, ctx, schema, prefix));
      }
    }
  }
  // The single per-context event log (event-log-architecture.md): ONE
  // `<ctx>_events` table shared by every `persistedAs(eventLog)` aggregate and
  // every `eventSourced` workflow in the context, discriminated by
  // `stream_type`.  Its schema/prefix follows the context's event-sourced
  // streams (aggregate binding first, else the workflow schema resolver) —
  // mirrors the Drizzle call site.
  // Keyed by OWNING context — `ctx` may be a merged union of several contexts
  // (multi-context deployable), so each owning context that has any
  // event-sourced stream gets its own `<owner>_events` model, matching the
  // repository + migrations.  Aggregate binding fixes the schema/prefix first
  // (an owner with both an ES aggregate and an ES workflow shares one log).
  const eventLogs = new Map<string, { schema?: string; prefix?: string }>();
  for (const agg of ctx.aggregates) {
    if (agg.persistedAs !== "eventLog") continue;
    const owner = resolveStreamContext?.(agg.name) ?? ctx.name;
    if (!eventLogs.has(owner)) {
      const ds = resolveDataSource?.(agg);
      eventLogs.set(owner, { schema: ds?.schema, prefix: ds?.tablePrefix });
    }
  }
  for (const wf of ctx.workflows) {
    if (!wf.eventSourced) continue;
    const owner = resolveStreamContext?.(wf.name) ?? ctx.name;
    if (!eventLogs.has(owner)) {
      eventLogs.set(owner, { schema: resolveWorkflowSchema?.(wf) });
    }
  }
  for (const [owner, info] of eventLogs) {
    models.push(renderEventLogModel(owner, info.schema, info.prefix));
  }
  // Persisted workflow-correlation state (workflow-and-applier.md A2-S2):
  // one row per running instance, keyed by the correlation field.  The
  // shared migration leaves these unqualified (public schema).  A durable
  // channel adds the `last_event_id` idempotent-consumer marker.
  const durable = durableEventTypes(ctx).size > 0;
  for (const wf of ctx.workflows) {
    if (!wf.correlationField) continue;
    // An `eventSourced` workflow's stream lives in the shared per-context
    // `<ctx>_events` log emitted above (folded on load, filtered by
    // `stream_type`) — no per-workflow state table.
    if (wf.eventSourced) continue;
    // The saga table lands in the workflow's owning-context schema, matching
    // the migration DDL (unqualified when the context has no binding).
    const wfSchema = resolveWorkflowSchema?.(wf);
    models.push(renderWorkflowStateModel(wf, ctx, durable, wfSchema));
  }
  // Projection read models (projection.md): one context-owned read-model row
  // per projection, keyed by its correlation column, non-key columns nullable
  // (a fold upserts partial rows) — matches the shared nullable DDL.
  for (const proj of ctx.projections) {
    models.push(renderProjectionStateModel(proj, ctx, resolveProjectionSchema?.(proj)));
  }
  // Transactional outbox (dispatch-delivery-semantics.md): the shared
  // `__loom_outbox` table when any channel asks for durability.
  if (durable) models.push(renderOutboxModel());
  const body = models.join("\n\n\n");

  // Import narrowing — every SQLAlchemy helper is invoked by name, so a
  // word-boundary scan is exact (same trick as the other emitters).
  const uses = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(body);
  const saNames = [
    "BigInteger",
    "Boolean",
    "DateTime",
    "Identity",
    "Index",
    "Integer",
    "Numeric",
    "PrimaryKeyConstraint",
    "Text",
    "text",
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
    // Co-located provenance lineage (provenance.md): a `<field>_provenance`
    // jsonb column per provenanced field, holding the current lineage.  The
    // column itself is added by the LATE hand-emitted migration; the model
    // declares it so the save persist / hydrate read type-check.
    ...provenanceColumns(owner.fields),
  ];
  const tableArgs = [
    ...(parentName
      ? // Index name keys off the real FK column (`<parent>_id`), matching the
        // shared migration's `CREATE INDEX <table>_<parent>_id_idx`.
        [`        Index("${tableName}_${snake(parentName)}_id_idx", "${snake(parentName)}_id"),`]
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

/** Co-located `<field>_provenance` jsonb columns for an owner's provenanced
 *  fields (provenance.md).  Nullable — null until the field is first written. */
function provenanceColumns(fields: AggregateIR["fields"]): PyColumn[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => ({
      attr: provColumn(f.name),
      pyType: "object",
      saType: "JSONB",
      optional: true,
    }));
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

/** Document-shaped aggregate (`shape(document)`): the whole tree is one
 *  jsonb blob, so the table is the canonical document triple — `id` (PK),
 *  `data` (the serialised tree, JSONB), `version` (optimistic counter). */
function renderDocumentModel(agg: AggregateIR, schema?: string, prefix?: string): string {
  const tableName = `${prefix ?? ""}${snake(plural(agg.name))}`;
  return lines(
    `class ${agg.name}Row(Base):`,
    `    __tablename__ = "${tableName}"`,
    ...(schema ? [`    __table_args__ = ({"schema": "${schema}"},)`] : []),
    "",
    "    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)",
    "    data: Mapped[object] = mapped_column(JSONB)",
    "    version: Mapped[int] = mapped_column(Integer)",
  );
}

/** Embedded-children aggregate (`shape(embedded)`): the root is a normal
 *  queryable row — `id` plus its flattened scalar / VO / `X id` columns,
 *  exactly like the relational root — but each containment folds into one
 *  JSONB column and reference collections (`X id[]`) fold into a JSONB
 *  id-array column.  No part tables, no join tables (parity with the
 *  shared DDL's `embeddedTableForAggregate`). */
function renderEmbeddedModel(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  schema?: string,
  prefix?: string,
): string {
  const tableName = `${prefix ?? ""}${snake(plural(agg.name))}`;
  const cols: PyColumn[] = [
    { attr: "id", pyType: "str", saType: "Uuid(as_uuid=False)", optional: false, primaryKey: true },
  ];
  for (const f of agg.fields) {
    if (isRefCollectionField(f)) {
      cols.push({ attr: snake(f.name), pyType: "object", saType: "JSONB", optional: !!f.optional });
      continue;
    }
    cols.push(...columnsForFields([f], ctx));
  }
  for (const c of agg.contains) {
    cols.push({ attr: snake(c.name), pyType: "object", saType: "JSONB", optional: false });
  }
  return lines(
    `class ${rowClassName(agg.name)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    schema ? ["    __table_args__ = (", `        {"schema": "${schema}"},`, "    )"] : null,
    "",
    cols.map(renderColumn),
  );
}

/** The single per-context append-only event log `<ctx>_events`
 *  (event-log-architecture.md) — one table per bounded context, shared by
 *  every `persistedAs(eventLog)` aggregate stream AND every `eventSourced`
 *  workflow stream.  A row is one recorded event keyed by
 *  `(stream_type, stream_id, version)`: `stream_type` discriminates the owning
 *  aggregate/workflow (each fold reads only its own rows), `stream_id` is the
 *  aggregate id / workflow correlation key, `version` its gap-free per-stream
 *  position (the optimistic-concurrency control).  `seq` is the context-global
 *  monotonic cursor (`BIGSERIAL`, DB-assigned, carried inert). */
function renderEventLogModel(ctxName: string, schema?: string, prefix?: string): string {
  const tableName = `${prefix ?? ""}${contextEventsTableName(ctxName)}`;
  return lines(
    `class ${contextEventRowClassName(ctxName)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    "    __table_args__ = (",
    `        PrimaryKeyConstraint("stream_type", "stream_id", "version"),`,
    ...(schema ? [`        {"schema": "${schema}"},`] : []),
    "    )",
    "",
    // `seq` — context-global monotonic cursor (bigserial); DB-assigned, so
    // `Identity()` marks it server-generated (inserts omit it).
    "    seq: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)",
    "    stream_type: Mapped[str] = mapped_column(Text)",
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
function renderWorkflowStateModel(
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
  durable = false,
  schema?: string,
): string {
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
  // Idempotent-consumer marker for the at-least-once relay redelivery.
  if (durable) {
    cols.push({ attr: "last_event_id", pyType: "str", saType: "Text", optional: true });
  }
  return lines(
    `class ${wf.name}Row(Base):`,
    `    __tablename__ = "${tableName}"`,
    schema ? `    __table_args__ = ({"schema": "${schema}"},)` : null,
    "",
    cols.map(renderColumn),
  );
}

/** Projection read-model row (mirrors `renderWorkflowStateModel`): PK is the
 *  `keyed by` correlation column; every non-key column is forced NULLABLE so a
 *  fold can upsert a partial row (matches the shared nullable `MigrationsIR`
 *  DDL — a mismatch would break `mypy --strict` / inserts). */
function renderProjectionStateModel(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  schema?: string,
): string {
  const tableName = plural(snake(proj.name));
  const corr = proj.correlationField;
  const cols: PyColumn[] = [];
  for (const f of proj.stateFields) {
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
      cols.push({ attr: snake(f.name), pyType: "object", saType: "JSONB", optional: true });
      continue;
    }
    // Force nullable on every non-key column.
    cols.push(...columnsForFields([f], ctx).map((c) => ({ ...c, optional: true })));
  }
  return lines(
    `class ${proj.name}Row(Base):`,
    `    __tablename__ = "${tableName}"`,
    schema ? `    __table_args__ = ({"schema": "${schema}"},)` : null,
    "",
    cols.map(renderColumn),
  );
}

/** The shared transactional-outbox table (`__loom_outbox`) — fixed shape;
 *  the relay drains undispatched rows ordered by `occurred_at`.  Server
 *  defaults (`gen_random_uuid()` / `now()` / `0`) match the shared DDL so
 *  inserts omitting those columns let Postgres fill them. */
function renderOutboxModel(): string {
  return lines(
    "class LoomOutboxRow(Base):",
    `    __tablename__ = "__loom_outbox"`,
    "",
    "    id: Mapped[str] = mapped_column(",
    `        Uuid(as_uuid=False), primary_key=True, server_default=text("gen_random_uuid()")`,
    "    )",
    "    occurred_at: Mapped[datetime] = mapped_column(",
    `        DateTime(timezone=True), server_default=text("now()")`,
    "    )",
    "    type: Mapped[str] = mapped_column(Text)",
    "    payload: Mapped[object] = mapped_column(JSONB)",
    "    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))",
    `    attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))`,
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

/** Id-less child table for a `<VO>[]` value-object collection — owner FK +
 *  `ordinal` + the value object's flattened columns, composite PK
 *  `(parentFk, ordinal)`, reverse FK index.  A plain relational child table
 *  (no Postgres array / jsonb), so it shares the migration's DDL with every
 *  other SQL backend.  The `parentFk` carried by the descriptor already
 *  names the owner column (the TPH base for a concrete's own VO[] fields). */
function renderValueCollectionModel(
  vc: ValueCollectionIR,
  ctx: EnrichedBoundedContextIR,
  schema?: string,
  prefix?: string,
): string {
  const tableName = `${prefix ?? ""}${vc.childTable}`;
  const cols: PyColumn[] = [
    { attr: vc.parentFk, pyType: "str", saType: "Uuid(as_uuid=False)", optional: false },
    { attr: "ordinal", pyType: "int", saType: "Integer", optional: false },
    ...valueCollectionChildColumns(vc.voName, ctx),
  ];
  return lines(
    `class ${valueCollectionRowClassName(vc.childTable)}(Base):`,
    `    __tablename__ = "${tableName}"`,
    "    __table_args__ = (",
    `        PrimaryKeyConstraint("${vc.parentFk}", "ordinal"),`,
    `        Index("${tableName}_${vc.parentFk}_idx", "${vc.parentFk}"),`,
    ...(schema ? [`        {"schema": "${schema}"},`] : []),
    "    )",
    "",
    cols.map(renderColumn),
  );
}

/** Many-to-many join table for a `T id[]` reference collection — two FK
 *  columns, composite PK, reverse-membership index.  `T id[]` is a set
 *  (membership only, no order): the composite (owner, target) PK is the whole
 *  row, no payload column.  Deterministic read-back order is a read-time
 *  projection (ORDER BY the target FK id), not a stored `ordinal`. */
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
  );
}
