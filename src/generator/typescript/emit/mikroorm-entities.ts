// -------------------------------------------------------------------------
// MikroORM `@Entity` row-class emission — the schema layer every shape
// (relational / document / embedded / event-sourced) rides: column
// derivation from `TypeIR`, part/join/record row entities, and the
// timer-runs / outbox / audit / provenance / workflow / projection
// system-table entities `renderMikroEntities` assembles per module.  Split
// out of mikroorm.ts by packet 2.6 (wave-2) — mechanical move, no logic
// change.
// -------------------------------------------------------------------------

import type {
  AssociationIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  FieldIR,
  ProjectionIR,
  TypeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { isMaterializedProjection } from "../../../ir/types/loom-ir.js";
import { durableEventTypes } from "../../../ir/util/channels.js";
import {
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import { isValueCollectionType } from "../../../ir/util/value-collections.js";
import { lines } from "../../../util/code-builder.js";
import { plural, snake, upperFirst } from "../../../util/naming.js";
import { joinColumnName, joinTableConstName } from "../emit.js";
import { isRefCollection } from "../repository-associations-builder.js";
import { docFieldType } from "../repository-document-builder.js";

/** Postgres table for an aggregate — lowercase plural (e.g. `orders`). */

const tableOf = (aggName: string): string => plural(snake(aggName));

/** Row-entity class name for an aggregate (the MikroORM persistence model). */

export const rowClassOf = (aggName: string): string => `${aggName}Row`;

/** Row-entity class name for the shared per-context event-log stream row
 *  (`<Ctx>EventRow`) — one table for every `persistedAs: eventLog` aggregate in
 *  the context, discriminated by `streamType`. */
/** The MikroORM entity class for a context's shared `<ctx>_events` stream —
 *  exported so the ES-workflow fold helpers (workflow-eventsourced-builder.ts)
 *  can name it in their EntityManager branch. */

export const eventRowClassOf = (ctxName: string): string => `${upperFirst(ctxName)}EventRow`;

/** Pivot Row-entity class for an `Id[]` reference-collection association
 *  (`trainer_party` join table → `TrainerPartyRow`).  A plain composite-PK
 *  pivot, mirroring the drizzle many-to-many join table. */

export const joinRowClassOf = (assoc: AssociationIR): string =>
  `${upperFirst(joinTableConstName(assoc))}Row`;

// ---------------------------------------------------------------------------
// Column model — one entry per persisted column, matching the drizzle schema's
// property/column names (id, scalars, VO-flattened `field_sub`, id-ref) so the
// reused hydrate/save builders line up.
// ---------------------------------------------------------------------------

interface MikroColumn {
  prop: string; // property/column name (snake; == drizzle column)
  mikroType: string; // MikroORM EntitySchema `type`
  tsType: string; // Row class field TS type
  nullable: boolean;
  primary: boolean;
  /** Explicit columnType for precise numerics (money/decimal). */
  columnType?: string;
}

function unwrapOptional(t: TypeIR): { type: TypeIR; nullable: boolean } {
  return t.kind === "optional" ? { type: t.inner, nullable: true } : { type: t, nullable: false };
}

/** MikroORM type + Row TS type for a primitive. */

function primTypes(name: string): { mikro: string; ts: string; columnType?: string } {
  switch (name) {
    case "int":
      return { mikro: "integer", ts: "number" };
    case "long":
      return { mikro: "bigint", ts: "number" };
    case "decimal":
      // Unbounded `numeric` — matches the drizzle backend's `numeric(col)`
      // (no precision/scale).  MikroORM's bare `type: "decimal"` DEFAULTS to
      // `numeric(10,0)` (scale 0), which rounds every fractional value to an
      // integer on store (9.99 → 10); pin `columnType: "numeric"` so the DDL
      // is scale-free and fractional decimals survive the round-trip.
      return { mikro: "decimal", ts: "string", columnType: "numeric" };
    case "money":
      return { mikro: "decimal", ts: "string", columnType: "numeric(19,4)" };
    case "bool":
      return { mikro: "boolean", ts: "boolean" };
    case "datetime":
      return { mikro: "datetime", ts: "Date" };
    case "guid":
      return { mikro: "uuid", ts: "string" };
    case "json":
      return { mikro: "json", ts: "unknown" };
    default:
      return { mikro: "string", ts: "string" };
  }
}

/** Expand a single field into its column(s). VO fields flatten into one column
 *  per sub-field (`total_amount`, `total_currency`); everything else is a
 *  single column. Throws on a kind the validator should have gated.
 *
 *  Property names are the FIELD names (and `field_sub` for VO sub-fields), NOT
 *  snaked — they must match what the reused `hydrateRootExpr` / `projectionObject`
 *  reference (which use the field name / `${field}_${sub}`).  MikroORM's default
 *  underscore naming strategy still maps `customerId` → the `customer_id` column. */

function fieldColumns(f: FieldIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const { type, nullable } = unwrapOptional(f.type);
  return columnsForType(f.name, type, nullable, ctx);
}

function columnsForType(
  prop: string,
  type: TypeIR,
  nullable: boolean,
  ctx: EnrichedBoundedContextIR,
): MikroColumn[] {
  switch (type.kind) {
    case "primitive": {
      const { mikro, ts, columnType } = primTypes(type.name);
      return [{ prop, mikroType: mikro, tsType: ts, nullable, primary: false, columnType }];
    }
    case "enum":
      return [{ prop, mikroType: "string", tsType: "string", nullable, primary: false }];
    case "id":
      return [{ prop, mikroType: "string", tsType: "string", nullable, primary: false }];
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === type.name);
      if (!vo) return [{ prop, mikroType: "string", tsType: "string", nullable, primary: false }];
      return vo.fields.flatMap((sub) => {
        const { type: st, nullable: sn } = unwrapOptional(sub.type);
        return columnsForType(`${prop}_${sub.name}`, st, nullable || sn, ctx);
      });
    }
    default:
      throw new Error(
        `mikroorm: unsupported field kind '${type.kind}' on '${prop}' (validator gap)`,
      );
  }
}

/** Co-located provenance sidecar columns (provenance.md): a `<field>_provenance`
 *  jsonb column holding the current lineage for each provenanced field.  Typed
 *  `ProvLineage | null` on the Row so the shared save-projection / hydrate seams
 *  (`provColumnEntries` / `hydrateRootExpr`) line up without a cast — mirrors the
 *  drizzle `$type<ProvLineage>()` column. */

function provColumnsOf(fields: readonly FieldIR[]): MikroColumn[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => ({
      prop: `${f.name}_provenance`,
      mikroType: "json",
      tsType: `import("../domain/provenance").ProvLineage`,
      nullable: true,
      primary: false,
      columnType: "jsonb",
    }));
}

/** One jsonb column carrying a value-object collection field (`Money[]`) stored
 *  INLINE on the owner row.  Unlike the drizzle backend (id-less child table),
 *  the MikroORM adapter folds a root VO array onto a single serialised jsonb
 *  column — the mirror of the part-collection `collectionFieldColumn` path.  The
 *  Row TS type is the DOC shape of the array (`{ amount: number; currency:
 *  string }[]`); an optional `<VO>[]?` adds `| null`. */

function valueCollectionColumn(f: FieldIR, ctx: EnrichedBoundedContextIR): MikroColumn {
  const inner = f.type.kind === "optional" ? f.type.inner : f.type;
  return {
    prop: f.name,
    mikroType: "json",
    tsType: docFieldType(inner, ctx),
    nullable: f.type.kind === "optional" || (f.optional ?? false),
    primary: false,
    columnType: "jsonb",
  };
}

function columnsOf(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const id: MikroColumn = {
    prop: "id",
    mikroType: "string",
    tsType: "string",
    nullable: false,
    primary: true,
  };
  // `Id[]` reference collections persist as pivot tables (join-Row entities),
  // not columns on the aggregate row — skip them here.  Value-object collections
  // (`<VO>[]`) fold onto one inline jsonb column each (see valueCollectionColumn).
  const scalarFields = agg.fields.filter(
    (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type),
  );
  const valueCollFields = agg.fields.filter((f) => isValueCollectionType(f.type));
  return [
    id,
    ...scalarFields.flatMap((f) => fieldColumns(f, ctx)),
    ...valueCollFields.map((f) => valueCollectionColumn(f, ctx)),
    ...provColumnsOf(agg.fields),
  ];
}

/** TPH shared-table columns (aggregate-inheritance.md, sharedTable): one Row
 *  for the whole hierarchy — `id`, the `kind` discriminator, the abstract
 *  base's own columns (declared nullability kept), then every concrete's own
 *  columns forced nullable (only rows of that `kind` populate them).  Mirrors
 *  the drizzle `emitTphTable` column set so the shared save/hydrate seams line
 *  up.  De-duped by property name (first declaration wins). */

function tphSharedColumns(
  base: EnrichedAggregateIR,
  aggs: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
): MikroColumn[] {
  const cols: MikroColumn[] = [
    { prop: "id", mikroType: "string", tsType: "string", nullable: false, primary: true },
    { prop: "kind", mikroType: "string", tsType: "string", nullable: false, primary: false },
  ];
  const seen = new Set(cols.map((c) => c.prop));
  const push = (c: MikroColumn): void => {
    if (seen.has(c.prop)) return;
    seen.add(c.prop);
    cols.push(c);
  };
  for (const f of base.fields) {
    if (isRefCollection(f.type)) continue;
    for (const c of fieldColumns(f, ctx)) push(c);
  }
  for (const concrete of tphConcretesOf(base, aggs)) {
    for (const f of ownFieldsOf(concrete, base)) {
      if (isRefCollection(f.type)) continue;
      // Force nullable: only rows of this concrete's `kind` populate it.
      for (const c of fieldColumns(f, ctx)) push({ ...c, nullable: true });
    }
  }
  return cols;
}

/** Render one pivot Row entity class + EntitySchema for an association. */

function renderJoinRowEntity(assoc: AssociationIR): { block: string; schemaName: string } {
  const cls = joinRowClassOf(assoc);
  const schemaName = `${cls}Schema`;
  const ownerProp = joinColumnName(assoc.ownerFk);
  const targetProp = joinColumnName(assoc.targetFk);
  return {
    schemaName,
    block: lines(
      `export class ${cls} {`,
      `  ${ownerProp}!: string;`,
      `  ${targetProp}!: string;`,
      `}`,
      "",
      `export const ${schemaName} = new EntitySchema<${cls}>({`,
      `  class: ${cls},`,
      `  tableName: "${assoc.joinTable}",`,
      `  properties: {`,
      // Composite PK over (owner, target) — the whole row IS the set membership
      // (no payload); the default underscore naming maps `${ownerProp}` → the
      // `${assoc.ownerFk}` column, matching the drizzle join table.
      `    ${ownerProp}: { type: "string", primary: true },`,
      `    ${targetProp}: { type: "string", primary: true },`,
      `  },`,
      `});`,
      "",
    ),
  };
}

/** Row-entity class name for a contained entity part (`OrderLine` →
 *  `OrderLineRow`), its own child table keyed by a `parentId` FK. */

export const partRowClassOf = (partName: string): string => `${partName}Row`;

/** True when a field type is a COLLECTION (array of scalar / enum / VO / id),
 *  optionally optional-wrapped — the shape a part stores as one jsonb column. */

export function isCollectionFieldType(t: TypeIR): boolean {
  return (t.kind === "optional" ? t.inner : t).kind === "array";
}

/** One jsonb column carrying a part's collection field's serialised list.  The
 *  Row TS type is the DOC shape of the array (`string[]`, `{ amount: number;
 *  currency: string }[]`, …); the `nullable` flag adds `| null` for an optional
 *  collection. */

function collectionFieldColumn(f: FieldIR, ctx: EnrichedBoundedContextIR): MikroColumn {
  const inner = f.type.kind === "optional" ? f.type.inner : f.type;
  return {
    prop: f.name,
    mikroType: "json",
    tsType: docFieldType(inner, ctx),
    nullable: f.type.kind === "optional",
    primary: false,
    columnType: "jsonb",
  };
}

/** Render one child Row entity + EntitySchema for a contained entity part.
 *  Columns: `id` (PK), `parentId` (FK to the owner), then the part's own
 *  fields (scalar / enum / VO-flattened / id; a collection field folds into one
 *  jsonb column).  MikroORM owns the schema, so no explicit FK/index — the
 *  parent-scoped reads carry the relationship. */

function renderPartRowEntity(
  part: EntityPartIR,
  ctx: EnrichedBoundedContextIR,
): { block: string; schemaName: string } {
  const cls = partRowClassOf(part.name);
  const schemaName = `${cls}Schema`;
  const cols: MikroColumn[] = [
    { prop: "id", mikroType: "string", tsType: "string", nullable: false, primary: true },
    { prop: "parentId", mikroType: "string", tsType: "string", nullable: false, primary: false },
    ...part.fields.flatMap((f) =>
      isCollectionFieldType(f.type) ? [collectionFieldColumn(f, ctx)] : fieldColumns(f, ctx),
    ),
  ];
  const classFields = cols.map((c) => `  ${c.prop}!: ${c.tsType}${c.nullable ? " | null" : ""};`);
  const propLines = cols.map((c) => {
    const parts = [`type: "${c.mikroType}"`];
    if (c.primary) parts.push("primary: true");
    if (c.columnType) parts.push(`columnType: "${c.columnType}"`);
    if (c.nullable) parts.push("nullable: true");
    return `    ${c.prop}: { ${parts.join(", ")} },`;
  });
  return {
    schemaName,
    block: lines(
      `export class ${cls} {`,
      ...classFields,
      `}`,
      "",
      `export const ${schemaName} = new EntitySchema<${cls}>({`,
      `  class: ${cls},`,
      `  tableName: "${snake(plural(part.name))}",`,
      `  properties: {`,
      ...propLines,
      `  },`,
      `});`,
      "",
    ),
  };
}

// ---------------------------------------------------------------------------
// db/entities.ts — Row classes + EntitySchema definitions.
// ---------------------------------------------------------------------------

/** Document-shape columns: the whole aggregate collapses to `(id, data,
 *  version)` — one opaque jsonb blob + a concurrency counter.  Mirrors the
 *  drizzle `emitDocumentTable`; no per-field / containment / pivot columns. */

function documentColumnsOf(): MikroColumn[] {
  return [
    { prop: "id", mikroType: "string", tsType: "string", nullable: false, primary: true },
    {
      prop: "data",
      mikroType: "json",
      tsType: "unknown",
      nullable: false,
      primary: false,
      columnType: "jsonb",
    },
    { prop: "version", mikroType: "number", tsType: "number", nullable: false, primary: false },
  ];
}

/** Embedded-shape columns: the queryable root columns (via `columnsOf`) plus
 *  one jsonb column per `Id[]` reference collection (the id-string array folds
 *  onto the root row — no pivot table under embedded) and one jsonb column per
 *  containment (typed `unknown` on the Row, cast in the repo through
 *  `<Part>Doc`).  Mirrors the drizzle `emitEmbeddedTable`. */

function embeddedColumnsOf(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const cols = columnsOf(agg, ctx);
  // `Id[]` reference collections fold onto the root as a jsonb id-string array
  // (the embedded analogue of the relational pivot table) — `columnsOf` skips
  // them, so add them here, keeping the field's declared nullability.
  for (const f of agg.fields) {
    if (!isRefCollection(f.type)) continue;
    cols.push({
      prop: f.name,
      mikroType: "json",
      tsType: "string[]",
      nullable: f.optional ?? false,
      primary: false,
      columnType: "jsonb",
    });
  }
  for (const c of agg.contains) {
    cols.push({
      prop: c.name,
      mikroType: "json",
      tsType: "unknown",
      nullable: c.optional ?? false,
      primary: false,
      columnType: "jsonb",
    });
  }
  return cols;
}

/** A plain Row entity block from a fixed column list (audit / provenance
 *  history tables — no aggregate to walk). */

function renderRecordRowEntity(
  cls: string,
  tableName: string,
  cols: MikroColumn[],
): { block: string; schemaName: string } {
  const schemaName = `${cls}Schema`;
  const classFields = cols.map((c) => `  ${c.prop}!: ${c.tsType}${c.nullable ? " | null" : ""};`);
  const propLines = cols.map((c) => {
    const parts = [`type: "${c.mikroType}"`];
    if (c.primary) parts.push("primary: true");
    if (c.columnType) parts.push(`columnType: "${c.columnType}"`);
    if (c.nullable) parts.push("nullable: true");
    return `    ${c.prop}: { ${parts.join(", ")} },`;
  });
  return {
    schemaName,
    block: lines(
      `export class ${cls} {`,
      ...classFields,
      `}`,
      "",
      `export const ${schemaName} = new EntitySchema<${cls}>({`,
      `  class: ${cls},`,
      `  tableName: "${tableName}",`,
      `  properties: {`,
      ...propLines,
      `  },`,
      `});`,
      "",
    ),
  };
}

const JSONB = (prop: string, nullable: boolean): MikroColumn => ({
  prop,
  mikroType: "json",
  tsType: "unknown",
  nullable,
  primary: false,
  columnType: "jsonb",
});

const TEXT = (prop: string, opts: { primary?: boolean; nullable?: boolean } = {}): MikroColumn => ({
  prop,
  mikroType: "string",
  tsType: "string",
  nullable: opts.nullable ?? false,
  primary: opts.primary ?? false,
});

const TIMESTAMPTZ = (prop: string, opts: { nullable?: boolean } = {}): MikroColumn => ({
  prop,
  mikroType: "Date",
  tsType: "Date",
  nullable: opts.nullable ?? false,
  primary: false,
  columnType: "timestamptz",
});

const INT = (prop: string): MikroColumn => ({
  prop,
  mikroType: "number",
  tsType: "number",
  nullable: false,
  primary: false,
});

/** Row-entity class name for the transactional-outbox table.  Exported so the
 *  workflow builder's mikro outbox machinery references the same symbol. */

export const MIKRO_OUTBOX_ROW_CLASS = "LoomOutboxRow";

/** Row-entity class name for the timer-scheduler watermark table. */

export const MIKRO_TIMER_RUNS_ROW_CLASS = "LoomTimerRunsRow";

/** Timer-scheduler watermark Row (`loom_timer_runs`).  The scheduler creates this
 *  table itself with `CREATE TABLE IF NOT EXISTS` (it is self-owned
 *  infrastructure, deliberately outside the domain MigrationsIR), and on drizzle
 *  that is the end of the story.  On MikroORM it must ALSO be an entity: a table
 *  absent from the entity metadata is diffed as removed by `updateSchema()`, and
 *  `safe: true` alone would spare it without making it part of the model.  With
 *  the entity, `updateSchema()` creates it on boot 1 and the raw
 *  `CREATE TABLE IF NOT EXISTS` becomes the no-op it reads as. */

function timerRunsRowEntity(): { block: string; schemaName: string } {
  return renderRecordRowEntity(MIKRO_TIMER_RUNS_ROW_CLASS, "loom_timer_runs", [
    TEXT("timer", { primary: true }),
    TIMESTAMPTZ("lastFiredAt"),
  ]);
}

/** Transactional outbox Row (`__loom_outbox`) — the MikroORM edition of the
 *  drizzle `loomOutbox` pgTable (dispatch-delivery-semantics.md).  Column
 *  divergence from drizzle is deliberate on two properties, because MikroORM
 *  owns this schema through `updateSchema()` rather than a migration:
 *    - `id` is a TEXT pk the capture site fills with `randomUUID()`, not a
 *      `uuid DEFAULT gen_random_uuid()` — every other id in the mikro model is
 *      an application-generated text id, and a DB-side default would have to be
 *      threaded as `defaultRaw` purely to be immediately overwritten.
 *    - `occurredAt` / `attempts` are written by the capture site too, so they
 *      need no DDL default (the drizzle table has `defaultNow()` / `default(0)`
 *      because its INSERT omits them).
 *  `dispatchedAt` NULL is the undispatched marker the relay's drain filters on,
 *  exactly as on drizzle. */

function outboxRowEntity(): { block: string; schemaName: string } {
  return renderRecordRowEntity(MIKRO_OUTBOX_ROW_CLASS, "__loom_outbox", [
    TEXT("id", { primary: true }),
    TIMESTAMPTZ("occurredAt"),
    TEXT("type"),
    JSONB("payload", false),
    TIMESTAMPTZ("dispatchedAt", { nullable: true }),
    INT("attempts"),
  ]);
}

/** Audit history Row (`audit_records`) — the MikroORM edition of the drizzle
 *  `auditRecords` table.  Property names + underscore-mapped columns match, so
 *  the shared routes-builder's `em.insert(AuditRecordRow, { auditId, … })`
 *  round-trips into the same schema. */

function auditRecordEntity(): { block: string; schemaName: string } {
  return renderRecordRowEntity("AuditRecordRow", "audit_records", [
    TEXT("auditId", { primary: true }),
    TEXT("operationId"),
    TEXT("action"),
    TEXT("targetType"),
    TEXT("targetId"),
    JSONB("actor", true),
    // Nullable, matching `migrations-builder`: a `create` has no BEFORE state
    // and a `destroy` has no AFTER state, and the routes insert `null` for
    // each.  Declaring them NOT NULL here made the emitted DDL contradict the
    // insert sites.
    JSONB("before", true),
    JSONB("after", true),
    TIMESTAMPTZ("at"),
    TEXT("status"),
    TEXT("correlationId", { nullable: true }),
    TEXT("scopeId", { nullable: true }),
    TEXT("parentId", { nullable: true }),
  ]);
}

/** Provenance history Row (`provenance_records`) — the MikroORM edition of the
 *  drizzle `provenanceRecords` table. */

function provenanceRecordEntity(): { block: string; schemaName: string } {
  return renderRecordRowEntity("ProvenanceRecordRow", "provenance_records", [
    TEXT("traceId", { primary: true }),
    TEXT("snapshotId"),
    TEXT("targetType"),
    TEXT("field"),
    JSONB("inputs", false),
    JSONB("computedValue", true),
    TIMESTAMPTZ("at"),
    TEXT("correlationId", { nullable: true }),
    TEXT("scopeId", { nullable: true }),
    TEXT("actorId", { nullable: true }),
    TEXT("parentId", { nullable: true }),
  ]);
}

/** Row-entity class name for a workflow's persisted correlation state
 *  (`OrderFulfillment` → `OrderFulfillmentRow`).  Exported so the workflow
 *  builder's `usingMikro` store branch references the same symbol. */

export const mikroWorkflowRowClass = (wf: WorkflowIR): string => `${upperFirst(wf.name)}Row`;

/** Columns for a workflow's correlation-state Row: the correlation field is the
 *  string PK (an id column), every other declared saga state field maps through
 *  the shared `fieldColumns` — mirroring the drizzle `emitWorkflowStateTable`. */

function workflowStateColumns(wf: WorkflowIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const corr = wf.correlationField;
  const cols: MikroColumn[] = (wf.stateFields ?? []).flatMap((f) =>
    f.name === corr
      ? [{ prop: f.name, mikroType: "string", tsType: "string", nullable: false, primary: true }]
      : fieldColumns(f, ctx),
  );
  // Idempotent-consumer marker (dispatch-delivery-semantics.md §3) — the twin
  // of the drizzle `emitWorkflowStateTable`'s `last_event_id`.  Under a durable
  // channel the reactor preamble reads `state.lastEventId` and stamps it before
  // save, so without this column the emitted handler would not type-check.
  if (durableEventTypes(ctx).size > 0) cols.push(TEXT("lastEventId", { nullable: true }));
  return cols;
}

/** Row-entity class name for a folded projection's read-model row
 *  (`OrderBoard` → `OrderBoardRow`).  Exported so the projection builder's
 *  `usingMikro` store branch references the same symbol. */

export const mikroProjectionRowClass = (proj: ProjectionIR): string =>
  `${upperFirst(proj.name)}Row`;

/** Columns for a folded projection's read-model Row: the correlation field is
 *  the string PK, every other state field maps through the shared `fieldColumns`
 *  but is forced NULLABLE — a fold upserts only the fields its event carries, so
 *  a row is partial until every contributing event arrives.  Mirrors the drizzle
 *  `emitProjectionTable`. */

function projectionStateColumns(proj: ProjectionIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const corr = proj.correlationField;
  return proj.stateFields.flatMap((f): MikroColumn[] =>
    f.name === corr
      ? [{ prop: f.name, mikroType: "string", tsType: "string", nullable: false, primary: true }]
      : fieldColumns(f, ctx).map((c) => ({ ...c, nullable: true })),
  );
}

export function renderMikroEntities(
  aggs: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
  shapeOf: (agg: EnrichedAggregateIR) => "relational" | "embedded" | "document" = (a) =>
    (a.savingShape as "relational" | "embedded" | "document" | undefined) ?? "relational",
  opts: { audit?: boolean; provenance?: boolean; outbox?: boolean; timerRuns?: boolean } = {},
): string {
  const blocks: string[] = [];
  const schemaNames: string[] = [];
  // Event-sourced (`persistedAs: eventLog`) aggregates share a SINGLE
  // per-context `<ctx>_events` stream row (event-log-architecture.md),
  // discriminated by `stream_type`, rather than one table each.  Emitted once
  // after the per-aggregate walk; MikroORM owns the schema (via
  // `updateSchema()`), so the composite `(stream_type, stream_id, version)` PK
  // + inert `seq` cursor land as real columns.
  // An event-sourced WORKFLOW folds the same `<ctx>_events` stream (it has no
  // state table — see the correlation-row loop below), so it needs the stream
  // entity even when no AGGREGATE is event-sourced.  Gating on aggregates alone
  // meant a context whose only event-sourced thing was a workflow emitted no
  // entity at all, and the generated `http/workflows.ts` fell back to the
  // drizzle event store — importing `drizzle-orm`, which a `persistence:
  // mikroorm` project does not install, so the server died at import.
  const hasEventLog =
    aggs.some((agg) => agg.persistedAs === "eventLog") ||
    (ctx.workflows ?? []).some((wf) => wf.eventSourced);
  for (const agg of aggs) {
    if (agg.persistedAs === "eventLog") continue;
    // TPH concretes (aggregate-inheritance.md, sharedTable) own no Row — their
    // columns live in the base's shared table, emitted once for the base below.
    // …but a TPH concrete's contained parts still need their own child tables:
    // each part FKs the SHARED base row (the concrete has no table of its own),
    // and the part row's `parentId` holds that shared-table row id — which is
    // exactly the concrete's id (TPT-via-`contains`).  Mirrors emit/schema.ts.
    if (isTphConcrete(agg, aggs)) {
      for (const part of agg.parts ?? []) {
        const { block, schemaName: partSchema } = renderPartRowEntity(part, ctx);
        schemaNames.push(partSchema);
        blocks.push(block);
      }
      continue;
    }
    // Abstract bases own no table EXCEPT a TPH root, which owns the shared
    // table (a TPC / intermediate abstract base emits nothing).
    if (agg.isAbstract && !isTphBase(agg, aggs)) continue;
    // TPH base → the one shared hierarchy table; document → one `(id, data,
    // version)` jsonb blob; embedded → root columns + one jsonb column per
    // containment; else the aggregate's own Row (a TPC concrete carries its
    // merged base+own fields via columnsOf).
    const shape = shapeOf(agg);
    const embedded = shape === "embedded";
    const document = shape === "document";
    const cols = isTphBase(agg, aggs)
      ? tphSharedColumns(agg, aggs, ctx)
      : document
        ? documentColumnsOf()
        : embedded
          ? embeddedColumnsOf(agg, ctx)
          : columnsOf(agg, ctx);
    const cls = rowClassOf(agg.name);
    const schemaName = `${cls}Schema`;
    schemaNames.push(schemaName);
    const classFields = cols.map((c) => `  ${c.prop}!: ${c.tsType}${c.nullable ? " | null" : ""};`);
    const propLines = cols.map((c) => {
      const parts = [`type: "${c.mikroType}"`];
      if (c.primary) parts.push("primary: true");
      if (c.columnType) parts.push(`columnType: "${c.columnType}"`);
      if (c.nullable) parts.push("nullable: true");
      return `    ${c.prop}: { ${parts.join(", ")} },`;
    });
    blocks.push(
      lines(
        `export class ${cls} {`,
        ...classFields,
        `}`,
        "",
        `export const ${schemaName} = new EntitySchema<${cls}>({`,
        `  class: ${cls},`,
        `  tableName: "${tableOf(agg.name)}",`,
        `  properties: {`,
        ...propLines,
        `  },`,
        `});`,
        "",
      ),
    );
    // `Id[]` reference-collection associations persist as pivot Row entities
    // (composite-PK join tables), one per declared collection field.  Under
    // document (whole blob) OR embedded (id-string array folded onto the root
    // jsonb column, see `embeddedColumnsOf`) they ride inline — no pivot table.
    if (!document && !embedded)
      for (const assoc of agg.associations ?? []) {
        const { block, schemaName: joinSchema } = renderJoinRowEntity(assoc);
        schemaNames.push(joinSchema);
        blocks.push(block);
      }
    // Contained entity parts persist as parent-scoped child Row entities
    // (relational shape only), one table per declared part.  Under embedded
    // (jsonb containment columns) or document (whole blob) they fold in — no
    // child tables.
    if (!embedded && !document) {
      for (const part of agg.parts ?? []) {
        const { block, schemaName: partSchema } = renderPartRowEntity(part, ctx);
        schemaNames.push(partSchema);
        blocks.push(block);
      }
    }
  }
  if (hasEventLog) {
    const cls = eventRowClassOf(ctx.name);
    const schemaName = `${cls}Schema`;
    schemaNames.push(schemaName);
    blocks.push(
      lines(
        `export class ${cls} {`,
        // OPTIONAL, unlike every other column: `seq` is a DB-generated
        // `bigserial` (see the property below), so every append omits it — and
        // MikroORM derives `RequiredEntityData` from the CLASS, not from the
        // `autoincrement` flag.  Declared required, `em.insert(<Ctx>EventRow, {…})`
        // fails `tsc` with "Property 'seq' is missing" on every event-sourced
        // append.  Found by's compile proof: no gate hid this
        // one, the tsc TIERS did — the corpus tsc gates run drizzle only, and the
        // mikro behavioural leg builds with esbuild (no typecheck), so an
        // event-sourced aggregate or workflow on `persistence: mikroorm` has
        // never actually been type-checked.
        "  seq?: number;",
        "  streamType!: string;",
        "  streamId!: string;",
        "  version!: number;",
        "  type!: string;",
        "  data!: unknown;",
        "  occurredAt!: Date;",
        "}",
        "",
        `export const ${schemaName} = new EntitySchema<${cls}>({`,
        `  class: ${cls},`,
        `  tableName: "${snake(ctx.name)}_events",`,
        "  properties: {",
        // `seq` — context-global monotonic cursor (bigserial), inert until the
        // replay reader lands; not part of the PK.  Must be a real Postgres
        // `bigserial` (sequence-backed DB DEFAULT), like the drizzle event
        // store: MikroORM's `updateSchema()` only turns an autoincrement
        // *primary* into a serial, so a bare `bigint autoincrement` on this
        // non-PK column ships as a plain NOT NULL bigint with no default and
        // every event insert (which omits `seq`) fails the not-null constraint.
        // `columnType: "bigserial"` emits the sequence-backed column; the
        // `autoincrement` flag keeps MikroORM treating it as DB-generated so it
        // is left out of the insert column list.
        '    seq: { type: "number", columnType: "bigserial", autoincrement: true },',
        // Composite `(stream_type, stream_id, version)` PK: every ES stream in
        // the context shares this table, discriminated by `streamType`.
        '    streamType: { type: "string", primary: true },',
        '    streamId: { type: "string", primary: true },',
        '    version: { type: "number", primary: true },',
        '    type: { type: "string" },',
        '    data: { type: "json", columnType: "jsonb" },',
        '    occurredAt: { type: "Date", columnType: "timestamptz" },',
        "  },",
        "});",
        "",
      ),
    );
  }
  // Persisted workflow-correlation state (workflow-and-applier.md A2-S2): one
  // Row per non-event-sourced correlation-bearing workflow — the MikroORM twin
  // of the drizzle `emitWorkflowStateTable`.  The in-process dispatcher's
  // load/save helpers (http/workflows.ts, usingMikro branch) read/upsert these.
  // An event-sourced workflow folds its `<ctx>_events` stream instead (no state
  // table), and a plain command workflow has no correlation field → no Row.
  for (const wf of ctx.workflows ?? []) {
    if (wf.eventSourced || !wf.correlationField) continue;
    const { block, schemaName } = renderRecordRowEntity(
      mikroWorkflowRowClass(wf),
      snake(plural(wf.name)),
      workflowStateColumns(wf, ctx),
    );
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  // Folded-projection read-model Row entities (projection.md): one Row per
  // FOLDED projection — the MikroORM twin of the drizzle `emitProjectionTable`.
  // The in-process dispatcher's fold helpers (http/projections.ts, usingMikro
  // branch) load/upsert these; the by-key/list read routes read them.  Query-
  // time projections have no read-model row and are skipped.
  for (const proj of ctx.projections ?? []) {
    if (!isMaterializedProjection(proj)) continue;
    const { block, schemaName } = renderRecordRowEntity(
      mikroProjectionRowClass(proj),
      snake(plural(proj.name)),
      projectionStateColumns(proj, ctx),
    );
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  // Audit / provenance history Row entities — emitted (like the drizzle
  // `audit_records` / `provenance_records` tables) only when the model has an
  // audited target / a provenanced field, so a plain project pays nothing.
  if (opts.audit) {
    const { block, schemaName } = auditRecordEntity();
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  if (opts.provenance) {
    const { block, schemaName } = provenanceRecordEntity();
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  // Transactional-outbox Row — emitted (like the drizzle `__loom_outbox` table)
  // only when a context carries a durable channel, so a project with no
  // at-least-once delivery contract pays nothing.
  if (opts.outbox) {
    const { block, schemaName } = outboxRowEntity();
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  // Timer-scheduler watermark Row — only for a deployable that OWNS a timer
  // (the same condition that emits `scheduler.ts`).
  if (opts.timerRuns) {
    const { block, schemaName } = timerRunsRowEntity();
    schemaNames.push(schemaName);
    blocks.push(block);
  }
  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      "// MikroORM persistence model — Row entities mapped to the relational",
      "// tables.  Kept separate from the rich domain aggregates; the per-",
      "// aggregate repository maps between them.",
      `import { EntitySchema } from "@mikro-orm/core";`,
      "",
      ...blocks,
      `export const entities = [${schemaNames.join(", ")}];`,
    ) + "\n"
  );
}
