// ---------------------------------------------------------------------------
// mikroorm — idiomatic MikroORM persistence emitters for the node/hono backend
// (D-REALIZATION-AXES). The SECOND node persistence backend, selected by
// `persistence: mikroorm` (alongside the default `drizzle`).
//
// The generated Domain layer (encapsulated aggregates with a private
// constructor + `<Agg>._create(state)` factory) is persistence-agnostic and
// reused as-is. MikroORM only replaces the `db/` layer: an EntitySchema-based
// persistence model (`db/entities.ts`), a `mikro-orm.config.ts`, the server-
// entry connection bootstrap, and a per-aggregate repository.
//
// This is written the way a MikroORM developer would hand-write a DDD
// data-mapper layer: the persistence model (Row entities) is deliberately
// separate from the rich domain aggregate, and the repository maps between
// them — using the EntityManager idiomatically (`em.fork({ keepTransactionContext:
// true })` for an isolated per-call unit-of-work that still joins an ambient
// `db.transactional(...)` when the audit / provenance route runs the save +
// history flush atomically, `em.findOne` / `em.find` with real FilterQuery
// objects, `em.upsert`, `em.nativeDelete`).  Outside a transaction the flag is
// a no-op (nothing to keep).  Schema is owned by MikroORM (`orm.schema.updateSchema()`
// at startup), so this backend is self-consistent without drizzle migrations.
//
// Row ↔ domain mapping reuses Loom's shared builders (`hydrateRootExpr`,
// `projectFieldEntries`/`projectionObject`, `toWireMethod`) so the Row entity's
// property names match the drizzle column names and the hydration is identical
// to the drizzle path.
//
// SCOPE (v1, validator-gated in `ir/validate/validate.ts`): relational shape,
// flat aggregates with scalar / enum / value-object / single id-ref fields,
// CRUD + simple finds + context `retrieval` query bundles (where / sort /
// call-site page — DEBT-17). Everything else is rejected at validate time; a
// find / retrieval predicate outside the MikroORM FilterQuery subset emits a
// runtime-throwing stub (mirrors the .NET Dapper v1 path).
// ---------------------------------------------------------------------------

import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  AssociationIR,
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  EventIR,
  ExprIR,
  FieldIR,
  RepositoryIR,
  RetrievalIR,
  TypeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesMoneyDeep,
  exprUsesCurrentUser,
  findUsesCurrentUser,
  isQueryTimeProjection,
} from "../../../ir/types/loom-ir.js";
import {
  discriminatorValue,
  isTphBase,
  isTphConcrete,
  ownFieldsOf,
  tableOwnerName,
  tphConcretesOf,
} from "../../../ir/util/inheritance.js";
import { sortableFields } from "../../../ir/util/sortable-fields.js";
import { isValueCollectionType } from "../../../ir/util/value-collections.js";
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { joinColumnName, joinTableConstName } from "../emit.js";
import { isRefCollection } from "../repository-associations-builder.js";
import {
  deserializeField,
  docFieldType,
  docTypeAlias,
  documentCapabilityBody,
  entityFromDocFn,
  entityToDocFn,
  findPredicate,
  serializeField,
} from "../repository-document-builder.js";
import { hydrateConcreteFromSharedRow, hydrateRootExpr } from "../repository-find-builder.js";
import { hydrateEntityExpr } from "../repository-find-hydrate.js";
import { collectEnums, collectValueObjects } from "../repository-imports-builder.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import {
  projectFieldEntries,
  projectionObject,
  provColumnEntries,
} from "../repository-save-builder.js";
import { toWireMethod } from "../repository-wire-builder.js";
import { aggregateIsAudited, insertStampEntries, updateStampEntries } from "./audit-stamp.js";

/** Postgres table for an aggregate — lowercase plural (e.g. `orders`). */
const tableOf = (aggName: string): string => plural(snake(aggName));

/** Row-entity class name for an aggregate (the MikroORM persistence model). */
const rowClassOf = (aggName: string): string => `${aggName}Row`;

/** Row-entity class name for the shared per-context event-log stream row
 *  (`<Ctx>EventRow`) — one table for every `persistedAs(eventLog)` aggregate in
 *  the context, discriminated by `streamType`. */
const eventRowClassOf = (ctxName: string): string => `${upperFirst(ctxName)}EventRow`;

/** Pivot Row-entity class for an `Id[]` reference-collection association
 *  (`trainer_party` join table → `TrainerPartyRow`).  A plain composite-PK
 *  pivot, mirroring the drizzle many-to-many join table. */
const joinRowClassOf = (assoc: AssociationIR): string =>
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
const partRowClassOf = (partName: string): string => `${partName}Row`;

/** True when a field type is a COLLECTION (array of scalar / enum / VO / id),
 *  optionally optional-wrapped — the shape a part stores as one jsonb column. */
function isCollectionFieldType(t: TypeIR): boolean {
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
const TIMESTAMPTZ = (prop: string): MikroColumn => ({
  prop,
  mikroType: "Date",
  tsType: "Date",
  nullable: false,
  primary: false,
  columnType: "timestamptz",
});

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
    JSONB("before", false),
    JSONB("after", false),
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
  return (wf.stateFields ?? []).flatMap((f) =>
    f.name === corr
      ? [{ prop: f.name, mikroType: "string", tsType: "string", nullable: false, primary: true }]
      : fieldColumns(f, ctx),
  );
}

export function renderMikroEntities(
  aggs: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
  shapeOf: (agg: EnrichedAggregateIR) => "relational" | "embedded" | "document" = (a) =>
    (a.savingShape as "relational" | "embedded" | "document" | undefined) ?? "relational",
  opts: { audit?: boolean; provenance?: boolean } = {},
): string {
  const blocks: string[] = [];
  const schemaNames: string[] = [];
  // Event-sourced (`persistedAs(eventLog)`) aggregates share a SINGLE
  // per-context `<ctx>_events` stream row (event-log-architecture.md),
  // discriminated by `stream_type`, rather than one table each.  Emitted once
  // after the per-aggregate walk; MikroORM owns the schema (via
  // `updateSchema()`), so the composite `(stream_type, stream_id, version)` PK
  // + inert `seq` cursor land as real columns.
  const hasEventLog = aggs.some((agg) => agg.persistedAs === "eventLog");
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
        "  seq!: number;",
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

// ---------------------------------------------------------------------------
// mikro-orm.config.ts — the standard MikroORM config module.
// ---------------------------------------------------------------------------

export function renderMikroConfig(): string {
  return (
    lines(
      "// Auto-generated.  MikroORM configuration (persistence: mikroorm).",
      `import { defineConfig } from "@mikro-orm/postgresql";`,
      `import { entities } from "./db/entities";`,
      "",
      "if (!process.env.DATABASE_URL) {",
      "  throw new Error(",
      '    "DATABASE_URL is required.  Set it in the environment " +',
      '      "(e.g. postgres://user:pass@host:5432/db).",',
      "  );",
      "}",
      "",
      "export default defineConfig({",
      "  clientUrl: process.env.DATABASE_URL,",
      "  entities,",
      "  // No RequestContext middleware in the generated server, so repositories",
      "  // fork the EntityManager per call instead of relying on the global EM.",
      "  allowGlobalContext: true,",
      "});",
    ) + "\n"
  );
}

/** index.ts bootstrap lines — replaces the drizzle pool/db block. Initialises
 *  MikroORM, applies the schema (dev), exposes `db` as the EntityManager. */
export function mikroConnectionSetup(): readonly string[] {
  return [
    `const orm = await MikroORM.init(mikroConfig);`,
    `// Dev-friendly schema bootstrap: create/alter tables from the entity`,
    `// metadata on boot.  System-mode compose isolates each deployable to its`,
    `// own database, so this runs cleanly.  Replace with 'mikro-orm migration:up'`,
    `// for production.`,
    `await orm.schema.updateSchema();`,
    `const db = orm.em;`,
  ];
}

/** Drizzle import lines in index.ts to swap out, and the MikroORM ones to swap
 *  in, when the deployable selects mikroorm. */
export const MIKRO_INDEX_IMPORTS: readonly string[] = [
  `import { MikroORM } from "@mikro-orm/postgresql";`,
  `import mikroConfig from "./mikro-orm.config";`,
];

/** package.json dependency rows (JSON-shaped, like the drizzle adapter). */
export const MIKRO_DEPS: readonly string[] = [
  `"@mikro-orm/core": "^6.4.0",`,
  `"@mikro-orm/postgresql": "^6.4.0",`,
];

// ---------------------------------------------------------------------------
// find `where` → MikroORM FilterQuery object literal. Minimal subset; throws on
// anything unsupported so the caller can emit a runtime-throwing stub body.
// ---------------------------------------------------------------------------

const FILTER_OP: Record<string, string> = {
  "<": "$lt",
  ">": "$gt",
  "<=": "$lte",
  ">=": "$gte",
  "!=": "$ne",
};

/** The FilterQuery property name for a `this`-rooted field access, or null.
 *  Accepts `this.<field>` (a `member` over `this` — the shape a repository
 *  `find ... where this.field` lowers to), a bare `this-prop` ref (`total` — the
 *  shape a `view ... where total` / criterion candidate field lowers to), and a
 *  VO subfield `this.<field>.<sub>` (→ the flattened `<field>_<sub>` column, the
 *  MikroORM twin of the drizzle `<field>_<sub>` column). */
function thisFieldColumn(e: ExprIR): string | null {
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  if (e.kind === "member" && e.receiver.kind === "member" && e.receiver.receiver.kind === "this")
    return `${e.receiver.member}_${e.member}`;
  return null;
}

/** Render a `this.<col> <op> <param>` comparison as a `{ col: ... }` entry. */
function comparisonEntry(e: Extract<ExprIR, { kind: "binary" }>): string {
  // FilterQuery keys are entity PROPERTY names (== field names), not DB columns.
  const col = thisFieldColumn(e.left);
  if (col === null) throw new Error("mikroorm: unsupported find predicate (lhs not this.<field>)");
  const rhs = filterValue(e.right);
  if (e.op === "==") return `${col}: ${rhs}`;
  const op = FILTER_OP[e.op];
  if (!op) throw new Error(`mikroorm: unsupported operator '${e.op}' in find`);
  return `${col}: { ${op}: ${rhs} }`;
}

function filterValue(e: ExprIR): string {
  switch (e.kind) {
    case "ref":
      if (e.refKind === "param") return e.name;
      if (e.refKind === "enum-value") return JSON.stringify(e.name);
      throw new Error(`mikroorm: unsupported ref '${e.refKind}' in find`);
    case "member":
      // `currentUser.<claim>` — a principal-referencing (tenancy) capability
      // filter reads the ambient request principal via `requireCurrentUser()`,
      // exactly as the drizzle repository does; the value is compared against
      // the row column on the LHS.
      if (e.receiver.kind === "ref" && e.receiver.refKind === "current-user")
        return `requireCurrentUser().${e.member}`;
      throw new Error("mikroorm: unsupported member value in find");
    case "literal":
      switch (e.lit) {
        case "string":
          return JSON.stringify(e.value);
        case "bool":
          return e.value;
        case "int":
        case "long":
        case "decimal":
        case "money":
          return e.value;
        default:
          throw new Error("mikroorm: unsupported literal in find");
      }
    default:
      throw new Error(`mikroorm: unsupported value '${e.kind}' in find`);
  }
}

/** `this.<field>` where field is a boolean column → the column name, else
 *  null.  MikroORM lowers a bare boolean column to `{ col: true }` (and
 *  `!this.col` to `{ col: false }`), the FilterQuery analogue of drizzle's
 *  `col = true`. */
function booleanColumnName(e: ExprIR): string | null {
  const inner = e.kind === "paren" ? e.inner : e;
  if (
    inner.kind === "member" &&
    inner.receiver.kind === "this" &&
    inner.memberType.kind === "primitive" &&
    inner.memberType.name === "bool"
  )
    return inner.member;
  if (
    inner.kind === "ref" &&
    inner.refKind === "this-prop" &&
    inner.type?.kind === "primitive" &&
    inner.type.name === "bool"
  )
    return inner.name;
  return null;
}

/** One conjunct → a single FilterQuery entry (`key: value`).  Handles
 *  comparisons (`col <op> value`), bare boolean columns (`this.active` →
 *  `active: true`), negated boolean columns (`!this.active` → `active:
 *  false`), and a general `!<compound>` (→ `$not: {...}`). */
function predicateEntry(e: ExprIR): string {
  const inner = e.kind === "paren" ? e.inner : e;
  const boolCol = booleanColumnName(inner);
  if (boolCol) return `${boolCol}: true`;
  if (inner.kind === "unary" && inner.op === "!") {
    const negCol = booleanColumnName(inner.operand);
    if (negCol) return `${negCol}: false`;
    return `$not: ${whereToMikroFilter(inner.operand)}`;
  }
  if (inner.kind === "binary" && (inner.op === "==" || FILTER_OP[inner.op] !== undefined)) {
    return comparisonEntry(inner);
  }
  throw new Error(`mikroorm: unsupported find predicate '${inner.kind}'`);
}

/** Conjunctions merge into one object; `||` becomes `$or`.  Bare boolean
 *  columns and unary `!` are lowered via `predicateEntry`. */
function whereToMikroFilter(e: ExprIR): string {
  const inner = e.kind === "paren" ? e.inner : e;
  if (inner.kind === "binary" && inner.op === "&&") {
    const entries = flattenAnd(inner).map((c) => predicateEntry(c));
    return `{ ${entries.join(", ")} }`;
  }
  if (inner.kind === "binary" && inner.op === "||") {
    return `{ $or: [${orBranches(inner)
      .map((b) => whereToMikroFilter(b))
      .join(", ")}] }`;
  }
  return `{ ${predicateEntry(inner)} }`;
}

/** Split a `&&` chain into its conjuncts (each rendered by `predicateEntry`). */
function flattenAnd(e: Extract<ExprIR, { kind: "binary" }>): ExprIR[] {
  const out: ExprIR[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "&&") {
      visit(inner.left);
      visit(inner.right);
    } else {
      out.push(inner);
    }
  };
  visit(e);
  return out;
}

/** Split a `||` chain into its disjuncts (each a full FilterQuery object). */
function orBranches(e: Extract<ExprIR, { kind: "binary" }>): ExprIR[] {
  const out: ExprIR[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "||") {
      visit(inner.left);
      visit(inner.right);
    } else {
      out.push(inner);
    }
  };
  visit(e);
  return out;
}

// ---------------------------------------------------------------------------
// Capability `filter` predicates (`filter <expr>` → AggregateIR.contextFilters).
//
// MikroORM has no global query filter (EF Core's `HasQueryFilter`), so — like
// drizzle — the repository ANDs each capability predicate into every root read.
// A NON-principal predicate lowers to a FilterQuery via `whereToMikroFilter`
// (guaranteed in-subset by `validateFindPredicateAdapterSupport`).  A
// PRINCIPAL-referencing filter (tenancy: `this.tenantId == currentUser.tenantId`)
// is applied too: `currentUser.<claim>` lowers against the ambient
// `requireCurrentUser()` accessor (exactly as the drizzle repository), so the
// tenant scope IS enforced on every mikro read.  A read's `ignoring *` /
// `ignoring <Cap>` bypass drops the capability-origin predicates it names.
// ---------------------------------------------------------------------------

interface FilterBypass {
  bypassAll?: boolean;
  bypassCaps?: string[];
}

/** The applicable capability filters for an aggregate as MikroORM FilterQuery
 *  object-literal strings, honoring a read's `ignoring` bypass. */
function mikroContextFilters(agg: EnrichedAggregateIR, bypass?: FilterBypass): string[] {
  const filters = agg.contextFilters ?? [];
  const origins = agg.contextFilterOrigins ?? [];
  const out: string[] = [];
  filters.forEach((pred, i) => {
    const origin = origins[i];
    // Only capability-origin (`undefined` = bare/hand-written) filters are
    // bypassable; `ignoring *` drops every origin, a named `ignoring` the match.
    if (origin !== undefined && (bypass?.bypassAll || (bypass?.bypassCaps ?? []).includes(origin)))
      return;
    if (exprUsesCurrentUser(pred)) {
      // A principal filter is not gated for FilterQuery-lowerability by the
      // adapter validator (`validateFindPredicateAdapterSupport` skips it), so
      // guard the lowering: apply the flat `this.<field> == currentUser.<claim>`
      // shape, and drop any shape outside the subset (e.g. a deep-scope subtree
      // predicate) rather than throwing at generation — such a system is not
      // generated on the mikro adapter today.
      try {
        out.push(whereToMikroFilter(pred));
      } catch {
        /* unlowerable principal filter — left unapplied (unreachable in-corpus) */
      }
      return;
    }
    out.push(whereToMikroFilter(pred));
  });
  return out;
}

/** Merge a base FilterQuery object-literal with the aggregate's applicable
 *  capability filters (`$and`).  No filters → the base unchanged (byte-
 *  identical to the pre-filter output); a `{}` base is dropped from the AND. */
function withContextFilters(base: string, caps: string[]): string {
  if (caps.length === 0) return base;
  const parts = base === "{}" ? caps : [base, ...caps];
  return parts.length === 1 ? parts[0]! : `{ $and: [${parts.join(", ")}] }`;
}

// ---------------------------------------------------------------------------
// `Id[]` reference-collection associations (many-to-many pivot tables).  The
// domain aggregate carries the collection as a bare `<field>` in `_rehydrate`
// (hydrateRootExpr emits `${f.name}`), so each read loads the target-id list
// from the pivot table into that local; the save does a full-list replace (set
// semantics — delete every owner row, insert the current list).  Mirrors the
// drizzle join-table path; no FK (MikroORM owns the schema via updateSchema),
// so the aggregate delete also clears the owner's pivot rows.
// ---------------------------------------------------------------------------

/** Bulk-load lines: each association → a `<field>ByOwner` map keyed by owner
 *  id, read from the pivot table for the `rootIds` in scope. */
function assocMapLoadLines(agg: EnrichedAggregateIR, emVar: string, indent: string): string[] {
  return (agg.associations ?? []).flatMap((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    const rows = `${a.fieldName}JoinRows`;
    const map = `${a.fieldName}ByOwner`;
    return [
      `${indent}const ${rows} = rootIds.length === 0 ? [] : await ${emVar}.find(${jc}, { ${oc}: { $in: rootIds } }, { orderBy: { ${oc}: "asc", ${tc}: "asc" } });`,
      `${indent}const ${map} = new Map<string, Ids.${a.targetAgg}Id[]>();`,
      `${indent}for (const jr of ${rows}) {`,
      `${indent}  const list = ${map}.get(jr.${oc}) ?? [];`,
      `${indent}  list.push(Ids.${a.targetAgg}Id(jr.${tc}));`,
      `${indent}  ${map}.set(jr.${oc}, list);`,
      `${indent}}`,
    ];
  });
}

/** Per-row `const <field> = <field>ByOwner.get(row.id) ?? [];` decls. */
function assocRowDeclLines(agg: EnrichedAggregateIR, rowVar: string, indent: string): string[] {
  return (agg.associations ?? []).map(
    (a) => `${indent}const ${a.fieldName} = ${a.fieldName}ByOwner.get(${rowVar}.id) ?? [];`,
  );
}

/** Inline single-owner association loads (findById) — `const <field> = (await
 *  em.find(pivot, { owner: id })).map(jr => Id(jr.target));`. */
function assocInlineLoadLines(
  agg: EnrichedAggregateIR,
  emVar: string,
  ownerIdExpr: string,
  indent: string,
): string[] {
  return (agg.associations ?? []).map((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    return `${indent}const ${a.fieldName} = (await ${emVar}.find(${jc}, { ${oc}: ${ownerIdExpr} }, { orderBy: { ${tc}: "asc" } })).map((jr) => Ids.${a.targetAgg}Id(jr.${tc}));`;
  });
}

/** Full-list-replace save of every association's pivot rows (set semantics). */
function assocSaveLines(agg: EnrichedAggregateIR, emVar: string, indent: string): string[] {
  return (agg.associations ?? []).flatMap((a) => {
    const jc = joinRowClassOf(a);
    const oc = joinColumnName(a.ownerFk);
    const tc = joinColumnName(a.targetFk);
    return [
      `${indent}// Full-list replace of the '${a.fieldName}' reference set.`,
      `${indent}await ${emVar}.nativeDelete(${jc}, { ${oc}: aggregate.id as string });`,
      `${indent}for (const t of aggregate.${a.fieldName}) {`,
      `${indent}  await ${emVar}.insert(${jc}, { ${oc}: aggregate.id as string, ${tc}: t as string });`,
      `${indent}}`,
    ];
  });
}

/** The array-hydration statement(s) binding `rows` → `${targetVar}`.  With
 *  associations it bulk-loads the pivot maps and assembles each row's list in a
 *  block; without, it stays the byte-identical single `.map(...)`. */
/** The value-object collection fields of an aggregate (`<VO>[]` root fields) —
 *  each stored INLINE as one jsonb column on the owner row. */
function valueCollFieldsOf(agg: EnrichedAggregateIR): FieldIR[] {
  return agg.fields.filter((f) => isValueCollectionType(f.type));
}

/** Per-row value-collection decls binding `<field>` from the owner row's inline
 *  jsonb column (`const lineItems = (row.lineItems ?? []).map((x) => new Money(
 *  Number(x.amount), x.currency));`).  No DB round-trip — the array rides on the
 *  root row, so this is pure deserialisation.  The value-collection analogue of
 *  `assocRowDeclLines`; empty for an aggregate without VO collections, so the
 *  output stays byte-identical. */
function valueCollRowDeclLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  rowVar: string,
  indent: string,
): string[] {
  return valueCollFieldsOf(agg).map(
    (f) => `${indent}const ${f.name} = ${deserializeField(f.type, `${rowVar}.${f.name}`, ctx)};`,
  );
}

function assocHydrateBind(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  targetVar: string,
  keyword: "const" | "return",
  indent: string,
): string[] {
  const hy = hydrateRootExpr(agg, "row", ctx);
  const head = keyword === "return" ? "return" : `const ${targetVar} =`;
  const hasValueColls = valueCollFieldsOf(agg).length > 0;
  const hasChildren =
    (agg.associations ?? []).length > 0 || (agg.contains ?? []).length > 0 || hasValueColls;
  if (!hasChildren) {
    return [`${indent}${head} rows.map((row) => ${hy});`];
  }
  return [
    `${indent}const rootIds = rows.map((r) => r.id);`,
    ...assocMapLoadLines(agg, emVar, indent),
    ...containMapLoadLines(agg, ctx, emVar, indent),
    `${indent}${head} rows.map((row) => {`,
    ...assocRowDeclLines(agg, "row", `${indent}  `),
    ...containRowDeclLines(agg, "row", `${indent}  `),
    ...valueCollRowDeclLines(agg, ctx, "row", `${indent}  `),
    `${indent}  return ${hy};`,
    `${indent}});`,
  ];
}

// ---------------------------------------------------------------------------
// Contained entity parts (`contains <name>: <Part>[]` / singular).  Relational
// shape: each part is a parent-scoped `<Part>Row` child table.  Mirrors the
// `Id[]` association machinery — bulk-load into a `<name>ByParent` map on the
// array reads, inline-load on findById, diff-sync on save.  The domain root
// hydrates each containment from a bare `<name>` local (hydrateRootExpr), so
// these helpers just supply those locals.  NESTED parts (part-in-part) recurse
// (deepest-first loads / tree-position-stamped saves / cascade deletes), and a
// COLLECTION field on a part folds into one jsonb column — so the full
// containment tree round-trips (validator only gates event-sourced /
// aggregate-inheritance participants, which have no relational child-table home).
// ---------------------------------------------------------------------------

/** The entity part a containment names (undefined if malformed — validator-
 *  gated, so callers no-op). */
function partForContainment(agg: EnrichedAggregateIR, c: ContainmentIR): EntityPartIR | undefined {
  return (agg.parts ?? []).find((p) => p.name === c.partName);
}

/** The MikroORM part hydrate — `hydrateEntityExpr` with the collection-field
 *  override wired in: a part's array field is stored as one serialised jsonb
 *  column, so it (de)serialises through the shared `deserializeField` (VO/id/
 *  money elements reconstructed) rather than the drizzle native-array
 *  passthrough.  For a part with no collection field this is byte-identical to a
 *  bare `hydrateEntityExpr` (the override never fires). */
function mikroHydrateEntity(
  part: EntityPartIR,
  rowVar: string,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  return hydrateEntityExpr(part, rowVar, agg, ctx, {
    collectionField: (f, rv) => deserializeField(f.type, `${rv}.${f.name}`, ctx),
  });
}

/** Save projection for a child part row — `{ id, parentId, <fields> }`,
 *  reusing the shared field projector so the columns match the Row entity.
 *
 *  A NESTED part (part-in-part) is stamped from TREE POSITION instead of the
 *  object's own `parentId`: a freshly-built nested part has no reliable
 *  construction-time parentId (a `new Label` inside a `new Shipment` has no
 *  shipment id yet), so the recursive save passes the enclosing loop variable's
 *  id as `parentIdExpr` — mirroring the drizzle `entityProjection` FK-stamp
 *  rule.  A COLLECTION field folds into one jsonb column, serialised through the
 *  shared `serializeField` (the MikroORM json column stores the plain value
 *  directly — VOs flattened to plain objects, ids/money to strings). */
function partProjection(
  part: EntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
  parentIdExpr?: string,
): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: parentIdExpr ?? `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) =>
      isCollectionFieldType(f.type)
        ? [{ fieldName: f.name, expr: serializeField(f.type, `${varExpr}.${f.name}`, ctx) }]
        : projectFieldEntries(f, varExpr, ctx),
    ),
  ]);
}

/** Recursively bulk-load a part's OWN nested containments (part-in-part) into
 *  per-direct-parent `<name>ByParent` maps keyed by the child row's id, emitted
 *  BEFORE the `hydrateEntityExpr` that references them.  `rowsVar` is the parent
 *  level's already-loaded rows array local.  Deepest-first: each level loads its
 *  rows (`parentId $in <parent ids>`), recurses to build grandchild maps, then
 *  groups its own rows (whose hydrate now finds the grandchild maps in scope).
 *  Empty for a leaf part, so single-level output is byte-identical.  The
 *  MikroORM analogue of the drizzle `nestedContainLoads`. */
function nestedContainMikroLoads(
  part: EntityPartIR,
  rowsVar: string,
  emVar: string,
  indent: string,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string[] {
  return part.contains.flatMap((nc) => {
    const ncPart = partForContainment(agg, nc);
    if (!ncPart) return [];
    const ncRow = partRowClassOf(ncPart.name);
    const rowsLocal = `${nc.name}Rows`;
    const out = [
      `${indent}const ${rowsLocal} = ${rowsVar}.length === 0 ? [] : await ${emVar}.find(${ncRow}, { parentId: { $in: ${rowsVar}.map((r) => r.id) } }, { orderBy: { parentId: "asc", id: "asc" } });`,
      ...nestedContainMikroLoads(ncPart, rowsLocal, emVar, indent, agg, ctx),
    ];
    if (nc.collection) {
      out.push(
        `${indent}const ${nc.name}ByParent = new Map<string, ${ncPart.name}[]>();`,
        `${indent}for (const r of ${rowsLocal}) {`,
        `${indent}  const list = ${nc.name}ByParent.get(r.parentId) ?? [];`,
        `${indent}  list.push(${mikroHydrateEntity(ncPart, "r", agg, ctx)});`,
        `${indent}  ${nc.name}ByParent.set(r.parentId, list);`,
        `${indent}}`,
      );
    } else {
      out.push(
        `${indent}const ${nc.name}ByParent = new Map<string, ${ncPart.name}>();`,
        `${indent}for (const r of ${rowsLocal}) {`,
        `${indent}  if (${nc.name}ByParent.has(r.parentId)) continue;`,
        `${indent}  ${nc.name}ByParent.set(r.parentId, ${mikroHydrateEntity(ncPart, "r", agg, ctx)});`,
        `${indent}}`,
      );
    }
    return out;
  });
}

/** Inline single-owner containment loads (findById / single find) — each
 *  containment bound to a `<name>` local from its child table. */
function containInlineLoadLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  ownerIdExpr: string,
  indent: string,
): string[] {
  return (agg.contains ?? []).flatMap((c) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    // A part with its OWN nested containments must materialise its child rows
    // into a local so `nestedContainMikroLoads` can build the `<nc>ByParent`
    // maps the hydrate references; a leaf part keeps the byte-identical inline
    // form.
    const hasNested = part.contains.length > 0;
    if (c.collection) {
      if (!hasNested)
        return [
          `${indent}const ${c.name} = (await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } })).map((r) => ${mikroHydrateEntity(part, "r", agg, ctx)});`,
        ];
      const rows = `${c.name}Rows`;
      return [
        `${indent}const ${rows} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } });`,
        ...nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx),
        `${indent}const ${c.name} = ${rows}.map((r) => ${mikroHydrateEntity(part, "r", agg, ctx)});`,
      ];
    }
    if (!hasNested)
      return [
        `${indent}const ${c.name}Row = await ${emVar}.findOne(${prow}, { parentId: ${ownerIdExpr} });`,
        `${indent}const ${c.name} = ${c.name}Row === null ? null : ${mikroHydrateEntity(part, `${c.name}Row`, agg, ctx)};`,
      ];
    const rows = `${c.name}Rows`;
    return [
      `${indent}const ${rows} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } });`,
      ...nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx),
      `${indent}const ${c.name} = ${rows}.length === 0 ? null : ${mikroHydrateEntity(part, `${rows}[0]!`, agg, ctx)};`,
    ];
  });
}

/** Bulk-load every containment into a `<name>ByParent` map keyed by owner id
 *  (the array-read analogue of `assocMapLoadLines`). */
function containMapLoadLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  indent: string,
): string[] {
  return (agg.contains ?? []).flatMap((c) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    const rows = `${c.name}Rows`;
    const map = `${c.name}ByParent`;
    const elemT = c.collection ? `${part.name}[]` : part.name;
    // Load this containment's rows, then (for a part with its OWN nested
    // containments) recursively build the child `<nc>ByParent` maps BEFORE the
    // grouping hydrate references them.  Empty for a leaf part → byte-identical
    // single-level output.
    const rowsDecl = `${indent}const ${rows} = rootIds.length === 0 ? [] : await ${emVar}.find(${prow}, { parentId: { $in: rootIds } }, { orderBy: { parentId: "asc", id: "asc" } });`;
    const nested = nestedContainMikroLoads(part, rows, emVar, indent, agg, ctx);
    const mapDecl = `${indent}const ${map} = new Map<string, ${elemT}>();`;
    if (c.collection) {
      return [
        rowsDecl,
        ...nested,
        mapDecl,
        `${indent}for (const r of ${rows}) {`,
        `${indent}  const list = ${map}.get(r.parentId) ?? [];`,
        `${indent}  list.push(${mikroHydrateEntity(part, "r", agg, ctx)});`,
        `${indent}  ${map}.set(r.parentId, list);`,
        `${indent}}`,
      ];
    }
    return [
      rowsDecl,
      ...nested,
      mapDecl,
      `${indent}for (const r of ${rows}) ${map}.set(r.parentId, ${mikroHydrateEntity(part, "r", agg, ctx)});`,
    ];
  });
}

/** Per-row containment decls binding `<name>` from the bulk `<name>ByParent`
 *  map (the array-read analogue of `assocRowDeclLines`). */
function containRowDeclLines(agg: EnrichedAggregateIR, rowVar: string, indent: string): string[] {
  return (agg.contains ?? []).map(
    (c) =>
      `${indent}const ${c.name} = ${c.name}ByParent.get(${rowVar}.id) ?? ${c.collection ? "[]" : "null"};`,
  );
}

/** Diff-sync each containment's child rows on save: delete the rows the owner no
 *  longer holds, upsert the current set (id is the PK), then RECURSE into each
 *  part's own nested containments keyed by that part instance's id.  The
 *  MikroORM analogue of the drizzle `syncContain`: `depth` uniquifies the loop /
 *  `existing` / `currentIds` locals across levels, and a NESTED part's `parentId`
 *  is stamped from tree position (the enclosing loop variable's id) rather than
 *  the object's own — a freshly-built nested part has no reliable parentId. */
function containSaveLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  indent: string,
): string[] {
  const sync = (
    containments: readonly ContainmentIR[],
    ownerExpr: string,
    ownerIdExpr: string,
    ind: string,
    depth: number,
  ): string[] =>
    containments.flatMap((c) => {
      const part = partForContainment(agg, c);
      if (!part) return [];
      const prow = partRowClassOf(part.name);
      const suffix = depth === 0 ? "" : String(depth);
      const cap = `${upperFirst(c.name)}${suffix}`;
      const loopVar = `child${suffix}`;
      const itemsRef = c.collection
        ? `${ownerExpr}.${c.name}`
        : `(${ownerExpr}.${c.name} ? [${ownerExpr}.${c.name}] : [])`;
      // Root-level part keeps its own `parentId`; a nested part FKs to the
      // enclosing loop variable's id (tree position).
      const parentIdExpr = depth === 0 ? undefined : `${ownerExpr}.id as string`;
      return [
        `${ind}// Full child sync of the '${c.name}' containment.`,
        `${ind}const existing${cap} = await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} });`,
        `${ind}const currentIds${cap} = new Set(${itemsRef}.map((e) => e.id as string));`,
        `${ind}for (const r of existing${cap}) {`,
        `${ind}  if (!currentIds${cap}.has(r.id)) await ${emVar}.nativeDelete(${prow}, { id: r.id });`,
        `${ind}}`,
        `${ind}for (const ${loopVar} of ${itemsRef}) {`,
        `${ind}  await ${emVar}.upsert(${prow}, ${partProjection(part, loopVar, ctx, parentIdExpr)});`,
        ...sync(part.contains, loopVar, `${loopVar}.id as string`, `${ind}  `, depth + 1),
        `${ind}}`,
      ];
    });
  return sync(agg.contains ?? [], "aggregate", "aggregate.id as string", indent, 0);
}

/** Recursive cascade-delete of a subtree of contained child rows.  MikroORM
 *  owns the schema and the generated EntitySchemas carry no relation/FK, so
 *  there's no DB cascade — the repository clears descendants explicitly,
 *  DEEPEST-first.  A leaf part deletes straight by `parentId`; a part with its
 *  own nested containments first loads its row ids, recurses to clear
 *  grandchildren (`parentId $in <ids>`), then deletes its own rows.  For a
 *  single-level aggregate this reduces to the original one-liner per part
 *  (byte-identical).  `parentIdValue` is the `parentId` FilterQuery VALUE (an
 *  `id as string` at the root, a `{ $in: <ids> }` object below). */
function containCascadeDeleteLines(
  agg: EnrichedAggregateIR,
  emVar: string,
  parentIdValue: string,
  indent: string,
  depth: number,
): string[] {
  return containCascade(agg, agg.contains ?? [], emVar, parentIdValue, indent, depth);
}

function containCascade(
  agg: EnrichedAggregateIR,
  containments: readonly ContainmentIR[],
  emVar: string,
  parentIdValue: string,
  indent: string,
  depth: number,
): string[] {
  return containments.flatMap((c, i) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    if (part.contains.length === 0) {
      return [`${indent}await ${emVar}.nativeDelete(${prow}, { parentId: ${parentIdValue} });`];
    }
    const idsVar = `${c.name}DelIds${depth === 0 ? "" : depth}${i === 0 ? "" : `_${i}`}`;
    return [
      `${indent}const ${idsVar} = (await ${emVar}.find(${prow}, { parentId: ${parentIdValue} })).map((r) => r.id);`,
      ...containCascade(agg, part.contains, emVar, `{ $in: ${idsVar} }`, indent, depth + 1),
      `${indent}await ${emVar}.nativeDelete(${prow}, { parentId: ${parentIdValue} });`,
    ];
  });
}

// ---------------------------------------------------------------------------
// Context-level `view`s + query-time `projection`s sourced from an aggregate
// synthesise a parameterless-find repository read (`repo.<viewName>()` →
// `<Agg>[]`), exactly as the drizzle `repository-builder` does — the shared
// http/views + projection routes call these by name, so the MikroORM repo must
// emit them or the boot crashes on a missing method.  Reusing the FindIR shape
// means the find-method builder (predicate lowering, capability-filter AND,
// hydration) applies for free.
// ---------------------------------------------------------------------------
function synthViewFinds(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): RepositoryIR["finds"] {
  const viewFinds = (ctx.views ?? [])
    .filter((v) => v.source.kind === "aggregate" && v.source.name === agg.name)
    .map((view) => ({
      name: lowerFirst(view.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: agg.name } } as TypeIR,
      filter: view.filter,
      // Carry the view's `ignoring` bypass so its capability-filter conjunction
      // drops the bypassed origins (the view read honours the bypass as a find).
      bypassAll: view.bypassAll,
      bypassCaps: view.bypassCaps,
    }));
  const projectionFinds = (ctx.projections ?? [])
    .filter((p) => isQueryTimeProjection(p) && p.query?.source === agg.name)
    .map((p) => ({
      name: lowerFirst(p.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: agg.name } } as TypeIR,
      filter: p.query?.filter,
    }));
  return [...viewFinds, ...projectionFinds];
}

// ---------------------------------------------------------------------------
// Per-aggregate repository — a drop-in for the drizzle `<Agg>Repository`.
// ---------------------------------------------------------------------------

export function renderMikroRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  // TPH (aggregate-inheritance.md, sharedTable): a concrete subtype has no Row
  // of its own — it reads/writes the base's shared table, scoped to its `kind`
  // discriminator on every read and stamping `kind` on every write.  The Row
  // class + table are the base's; `kindClause` is ANDed into each read filter.
  const pool = ctx.aggregates;
  const kind = discriminatorValue(agg, pool);
  const rowAgg = tableOwnerName(agg, pool);
  const row = rowClassOf(rowAgg);
  const kindClause = kind ? [`{ kind: ${JSON.stringify(kind)} }`] : [];
  const kindProjection = kind ? [{ fieldName: "kind", expr: JSON.stringify(kind) }] : [];
  const hydrate = (rowVar: string) => hydrateRootExpr(agg, rowVar, ctx);
  // Capability `filter` predicates AND into every root read.  `baseFilters` is
  // the no-`ignoring` set (findById / findManyByIds / retrievals); each find
  // recomputes with its own `ignoring` bypass.  Empty when the aggregate has no
  // `filter` capability, so the read FilterQuery stays byte-identical.  The TPH
  // `kind` scope rides the same `$and` composition as a capability filter.
  const baseFilters = [...mikroContextFilters(agg), ...kindClause];
  // `Id[]` reference collections persist in pivot tables, not columns, so they
  // are excluded from the aggregate-row save projection (synced separately).
  // Value-object collections (`<VO>[]`) fold onto one inline jsonb column each,
  // serialised through the shared `serializeField` (VO elements → plain objects,
  // money/id → strings) — the root analogue of the part-collection jsonb column.
  const scalarFields = agg.fields.filter(
    (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type),
  );
  const valueCollFields = valueCollFieldsOf(agg);
  const valueCollEntries = valueCollFields.map((f) => ({
    fieldName: f.name,
    expr: serializeField(f.type, `aggregate.${f.name}`, ctx),
  }));
  const hasAssocs = (agg.associations ?? []).length > 0;
  const hasContains = (agg.contains ?? []).length > 0;
  const hasValueColls = valueCollFields.length > 0;
  const hasChildren = hasAssocs || hasContains;
  // Whether a read must declare per-row hydrate locals before the `_rehydrate`
  // (associations / contained parts / value-object collections all bind a bare
  // `<field>` local `hydrateRootExpr` references).  A plain flat aggregate has
  // none, so its single-row reads stay the byte-identical inline expression.
  const hasHydrateLocals = hasChildren || hasValueColls;
  // The id (primary key) leads the upsert payload — `projectFieldEntries`
  // covers only the declared fields, so it's prepended explicitly (matching
  // the drizzle save row).
  // Co-located provenance sidecar (provenance.md): each provenanced field's
  // `<field>_provenance` jsonb column reads straight off the domain getter, the
  // same shared entries the drizzle root projection uses.  Empty for a plain
  // aggregate → byte-identical mikro output.
  const provEntries = provColumnEntries(agg.fields, "aggregate");
  const saveProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...kindProjection,
    ...scalarFields.flatMap((f) => projectFieldEntries(f, "aggregate", ctx)),
    ...valueCollEntries,
    ...provEntries,
  ]);

  // Persist-time audit stamping (node-persist-time-auditing): on an audited
  // aggregate the upsert payload is wrapped in `stampInsert(...)` so the audit
  // columns are filled from the ambient request principal at save time, and
  // the create-only columns (createdAt/createdBy — insert-set minus update-set)
  // are excluded from the conflict UPDATE via `onConflictExcludeFields`, so a
  // re-save leaves them at their on-disk values (immutable).  A non-audited
  // aggregate keeps the byte-identical bare upsert.
  const audited = aggregateIsAudited(agg);
  const upsertCall = audited
    ? (() => {
        const updateFields = new Set(updateStampEntries(agg).map((e) => e.field));
        const createOnly = insertStampEntries(agg)
          .map((e) => e.field)
          .filter((f) => !updateFields.has(f));
        const opts =
          createOnly.length > 0
            ? `, { onConflictExcludeFields: [${createOnly.map((f) => JSON.stringify(f)).join(", ")}] }`
            : "";
        return `    await em.upsert(${row}, stampInsert(${saveProjection})${opts});`;
      })()
    : `    await em.upsert(${row}, ${saveProjection});`;

  // Versioned optimistic-concurrency save (M-T3.4, default-on) — the MikroORM
  // analogue of the drizzle guarded write (repository-save-builder.ts).  No
  // existing row → `em.insert` seeding `version: 1`.  Existing row → a guarded
  // `em.nativeUpdate` whose WHERE pins `version = expected` and whose SET bumps
  // it; zero affected rows means another request won the race in between →
  // `ConcurrencyError` (mapped to 409 by the shared onError arm).  `expected` is
  // the caller's `expectedVersion` (threaded from the route's `If-Match`) falling
  // back to the just-loaded `aggregate.version`.
  const versioned = aggregateIsVersioned(agg);
  const nonVersionEntries = scalarFields
    .filter((f) => f.name !== "version")
    .flatMap((f) => projectFieldEntries(f, "aggregate", ctx));
  const insertProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...kindProjection,
    ...nonVersionEntries,
    ...valueCollEntries,
    ...provEntries,
    { fieldName: "version", expr: "1" },
  ]);
  const updateData = projectionObject("aggregate", [
    ...kindProjection,
    ...nonVersionEntries,
    ...valueCollEntries,
    ...provEntries,
    { fieldName: "version", expr: "expected + 1" },
  ]);
  const insertValues = audited ? `stampInsert(${insertProjection})` : insertProjection;
  const updateSet = audited ? `stampUpdate(${updateData})` : updateData;
  const versionedSaveLines = [
    `    const expected = expectedVersion ?? aggregate.version;`,
    `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
    `    if (existing === null) {`,
    `      await em.insert(${row}, ${insertValues});`,
    `    } else {`,
    `      const affected = await em.nativeUpdate(${row}, { id: aggregate.id as string, version: expected }, ${updateSet});`,
    `      if (affected === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
    `    }`,
  ];

  const dbg = (find: string, rowsExpr: string) =>
    `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${find}", rows: ${rowsExpr} });`;

  const findMethods = [...(repo?.finds ?? []), ...synthViewFinds(agg, ctx)].map((f) => {
    const name = lowerFirst(f.name);
    const paged = pagedReturn(f.returnType);
    const isList = f.returnType.kind === "array";
    const ret = isList ? `${agg.name}[]` : `${agg.name} | null`;
    const params = f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`).join(", ");
    let filter: string;
    try {
      // The find's own `where`, AND-ed with the aggregate's capability filters
      // (dropping the ones this read's `ignoring` clause bypasses).
      const caps = [
        ...mikroContextFilters(agg, { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps }),
        ...kindClause,
      ];
      filter = withContextFilters(f.filter ? whereToMikroFilter(f.filter) : "{}", caps);
    } catch {
      return lines(
        `  async ${name}(${paged ? `${params}${params ? ", " : ""}page: number, pageSize: number, sort: string, dir: string` : params}): Promise<${paged ? `{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }` : ret}> {`,
        `    throw new Error("mikroorm v1: this find's predicate is not yet supported");`,
        `  }`,
      );
    }
    // Paged return (`find x(): <Agg> paged`; the auto-`findAll` after M-T2.6):
    // trailing `page`/`pageSize`/`sort`/`dir` controls → a `em.count` +
    // `em.find` with `limit`/`offset`/`orderBy`, wrapped in the paged envelope.
    // Server-side sort is whitelisted to scalar root columns (`sortableFields`);
    // an unknown key falls back to `id` (the stable default order — the route's
    // zod enum already rejects out-of-whitelist keys).  MikroORM aggregates are
    // flat, so no child bulk-load — the page rows hydrate the same way the
    // array branch does.
    if (paged) {
      const pagedParams = [
        ...f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`),
        "page: number",
        "pageSize: number",
        "sort: string",
        "dir: string",
      ].join(", ");
      const sortable = sortableFields(agg)
        .map((s) => JSON.stringify(s))
        .join(", ");
      return lines(
        `  async ${name}(${pagedParams}): Promise<{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const sortable = new Set<string>([${sortable}]);`,
        `    const sortField = sortable.has(sort) ? sort : "id";`,
        `    const orderBy: Record<string, "asc" | "desc"> = { [sortField]: dir === "desc" ? "desc" : "asc" };`,
        `    const total = await em.count(${row}, ${filter});`,
        `    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;`,
        `    const rows = await em.find(${row}, ${filter}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy });`,
        dbg(f.name, "rows.length"),
        ...assocHydrateBind(agg, ctx, "em", "items", "const", "    "),
        `    return { items, page, pageSize, total, totalPages };`,
        `  }`,
      );
    }
    if (isList) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const rows = await em.find(${row}, ${filter});`,
        dbg(f.name, "rows.length"),
        ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
        `  }`,
      );
    }
    // Single-row find: load the children inline (owner id known) then
    // hydrate, mirroring findById.  Value-object collections need a per-row
    // local too (deserialised off the row's inline jsonb column), so the block
    // form fires for them as well as for associations / contained parts.
    if (hasHydrateLocals) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name} | null> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const row = await em.findOne(${row}, ${filter});`,
        `    if (row === null) return null;`,
        ...assocInlineLoadLines(agg, "em", "row.id", "    "),
        ...containInlineLoadLines(agg, ctx, "em", "row.id", "    "),
        ...valueCollRowDeclLines(agg, ctx, "row", "    "),
        `    return ${hydrate("row")};`,
        `  }`,
      );
    }
    return lines(
      `  async ${name}(${params}): Promise<${agg.name} | null> {`,
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const row = await em.findOne(${row}, ${filter});`,
      `    return row === null ? null : ${hydrate("row")};`,
      `  }`,
    );
  });

  // Context `retrieval` query bundles targeting this aggregate (retrieval.md) —
  // emitted as `run<Name>(...)` methods, the MikroORM analogue of the drizzle
  // `runMethod` (DEBT-17).  The `where` lowers through the same `whereToMikroFilter`
  // oracle a find uses (so the same subset is supported; an out-of-subset
  // predicate emits a runtime-throwing stub).  `sort` → `em.find` `orderBy`, and
  // a call-site `page` → `limit`/`offset` (never part of the declaration —
  // mirrors the drizzle path).  The validator gates parts/non-relational off
  // this adapter, so the hydrate is the flat `hydrateRootExpr` the finds use;
  // `Id[]` reference collections (associations) bulk-load from their pivot
  // tables via `assocHydrateBind`, same as an array find.
  const retrievalMethods = (ctx.retrievals ?? [])
    .filter(
      (r): r is RetrievalIR => r.targetType.kind === "entity" && r.targetType.name === agg.name,
    )
    .map((r) => {
      const methodName = `run${upperFirst(r.name)}`;
      const baseParams = r.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
      const params = [...baseParams, "page?: { offset?: number; limit?: number }"].join(", ");
      let filter: string;
      try {
        // Retrievals read the aggregate table, so the capability filters AND in
        // too (no `ignoring` surface on retrievals — the no-bypass `baseFilters`).
        filter = withContextFilters(whereToMikroFilter(r.where), baseFilters);
      } catch {
        return lines(
          `  async ${methodName}(${params}): Promise<${agg.name}[]> {`,
          `    throw new Error("mikroorm v1: this retrieval's predicate is not yet supported");`,
          `  }`,
        );
      }
      // `sort` → MikroORM `orderBy`.  Only the first path segment (a direct
      // column) is used in v1 — nested / collection sort paths are gated by
      // validateRetrievals, same as the drizzle path.
      const orderBy =
        r.sort.length > 0
          ? `, orderBy: { ${r.sort.map((s) => `${s.path[0]!.name}: "${s.direction}"`).join(", ")} }`
          : "";
      return lines(
        `  async ${methodName}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const rows = await em.find(${row}, ${filter}, { limit: page?.limit, offset: page?.offset${orderBy} });`,
        dbg(r.name, "rows.length"),
        ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
        `  }`,
      );
    });

  const deleteMethod = agg.canonicalDestroy
    ? hasChildren
      ? lines(
          `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
          `    const em = this.em.fork({ keepTransactionContext: true });`,
          // No FK cascade (MikroORM owns the schema), so clear the owner's
          // pivot rows + contained child rows before the root delete.
          ...(agg.associations ?? []).map(
            (a) =>
              `    await em.nativeDelete(${joinRowClassOf(a)}, { ${joinColumnName(a.ownerFk)}: id as string });`,
          ),
          ...containCascadeDeleteLines(agg, "em", "id as string", "    ", 0),
          `    await em.nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
          `  }`,
        )
      : lines(
          `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
          `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
          `  }`,
        )
    : "";

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — see emit/value-objects.ts's renderValueObject.
    `  private readonly em: EntityManager;`,
    `  private readonly events: DomainEventDispatcher;`,
    `  constructor(`,
    `    em: EntityManager,`,
    `    events: DomainEventDispatcher,`,
    `  ) {`,
    `    this.em = em;`,
    `    this.events = events;`,
    `  }`,
    "",
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, ${withContextFilters("{ id: id as string }", baseFilters)});`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
    ...assocInlineLoadLines(agg, "em", "id as string", "    "),
    ...containInlineLoadLines(agg, ctx, "em", "id as string", "    "),
    ...valueCollRowDeclLines(agg, ctx, "row", "    "),
    `    const loaded = ${hydrate("row")};`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: true });`,
    `    return loaded;`,
    `  }`,
    "",
    `  async getById(id: Ids.${agg.name}Id): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, ${withContextFilters("{ id: { $in: ids as string[] } }", baseFilters)});`,
    ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    ...(versioned ? versionedSaveLines : [upsertCall]),
    ...(hasAssocs ? assocSaveLines(agg, "em", "    ") : []),
    ...(hasContains ? containSaveLines(agg, ctx, "em", "    ") : []),
    `    requestLog().debug({ event: "repository_save", aggregate: "${agg.name}", id: aggregate.id as string });`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    `      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string });`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    deleteMethod ? "" : null,
    deleteMethod || null,
    ...findMethods.flatMap((m) => ["", m]),
    ...retrievalMethods.flatMap((m) => ["", m]),
    "",
    toWireMethod(agg, ctx),
    `}`,
  );

  // Narrow VO/enum imports to the symbols the body actually references
  // (value when `new <Vo>(` or `<Enum>.<member>`, else type-only) — same
  // body-scan strategy the drizzle repository builder uses.
  const bodyScan = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const candidates = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  const referenced = candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (referenced.length > 0) {
    const anyValue = referenced.some(isValueUsed);
    voImportLine = anyValue
      ? `import { ${referenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${referenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesDecimal = /new\s+Decimal\(/.test(bodyScan);
  const usesPrincipal = /\brequireCurrentUser\(/.test(bodyScan);

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      // Domain-side repository PORT this concrete implements (audit S7).
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      // The aggregate Row + every `Id[]` association's pivot Row entity + each
      // contained entity part's child Row entity.
      `import { ${[
        row,
        ...(agg.associations ?? []).map(joinRowClassOf),
        ...(agg.parts ?? []).map((p) => partRowClassOf(p.name)),
      ].join(", ")} } from "../entities";`,
      // Persist-time audit stamping helper — pulled in only when this
      // aggregate's `save()` stamps (audited).  Stamps the audit columns from
      // the ambient request principal at the upsert (db/audit-stamp.ts).
      audited && `import { stampInsert${versioned ? ", stampUpdate" : ""} } from "../audit-stamp";`,
      // The aggregate root + its contained entity parts (same domain module).
      `import { ${[agg.name, ...(agg.parts ?? []).map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import { AggregateNotFoundError${versioned ? ", ConcurrencyError" : ""} } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Embedded-shape (`shape(embedded)`) MikroORM repository.  The queryable
// middle of the saving-shape spectrum: the aggregate ROOT stays real columns
// (hydrated/saved like the relational path), while each CONTAINMENT folds into
// one jsonb column — (de)serialised through the shared `<part>ToDoc` /
// `<part>FromDoc` helpers the document repository uses.  No child tables.
// ---------------------------------------------------------------------------

/** Per-containment local-const decls that materialise the jsonb columns into
 *  part instances, named `<c.name>` so `hydrateRootExpr`'s bare-name refs
 *  resolve.  Also materialises each `Id[]` reference collection from its folded
 *  jsonb id-string array (re-branded to the target id), the embedded analogue of
 *  the relational pivot-table load and the mirror of the drizzle embedded
 *  `hydrateLocals` ref-collection branch. */
function embeddedHydrateLocals(
  agg: EnrichedAggregateIR,
  rowVar: string,
  indent: string,
  ctx: EnrichedBoundedContextIR,
): string[] {
  const out: string[] = [];
  for (const f of agg.fields) {
    if (f.type.kind !== "array" || f.type.element.kind !== "id") continue;
    const target = f.type.element.targetName;
    out.push(
      `${indent}const ${f.name} = ((${rowVar}.${f.name} ?? []) as string[]).map((s) => Ids.${target}Id(s));`,
    );
  }
  // Value-object collections (`<VO>[]`) fold onto an inline jsonb column, so
  // deserialise each into its `<field>` local (the embedded analogue of the
  // relational `valueCollRowDeclLines`).
  for (const f of valueCollFieldsOf(agg)) {
    out.push(`${indent}const ${f.name} = ${deserializeField(f.type, `${rowVar}.${f.name}`, ctx)};`);
  }
  for (const c of agg.contains) {
    const fromDoc = `${lowerFirst(c.partName)}FromDoc`;
    if (c.collection)
      out.push(
        `${indent}const ${c.name} = ((${rowVar}.${c.name} ?? []) as ${c.partName}Doc[]).map((x) => ${fromDoc}(x));`,
      );
    else if (c.optional)
      out.push(
        `${indent}const ${c.name} = ${rowVar}.${c.name} == null ? null : ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`,
      );
    else
      out.push(`${indent}const ${c.name} = ${fromDoc}(${rowVar}.${c.name} as ${c.partName}Doc);`);
  }
  return out;
}

export function renderMikroEmbeddedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(agg.name);
  const idVar = `Ids.${agg.name}Id`;
  const baseFilters = mikroContextFilters(agg);
  const scalarFields = agg.fields.filter(
    (f) => !isRefCollection(f.type) && !isValueCollectionType(f.type),
  );

  // Root save row: id + scalar column projection + one jsonb id-string array
  // per `Id[]` reference collection (folded onto the root, no pivot table) +
  // one jsonb array per value-object collection (serialised through the shared
  // `serializeField`) + one jsonb entry per containment (via `<part>ToDoc`).
  const rootEntries: string[] = ["id: aggregate.id as string"];
  for (const f of scalarFields)
    for (const e of projectFieldEntries(f, "aggregate", ctx))
      rootEntries.push(`${e.fieldName}: ${e.expr}`);
  for (const f of agg.fields)
    if (isRefCollection(f.type))
      rootEntries.push(`${f.name}: aggregate.${f.name}.map((x) => x as string)`);
  for (const f of valueCollFieldsOf(agg))
    rootEntries.push(`${f.name}: ${serializeField(f.type, `aggregate.${f.name}`, ctx)}`);
  for (const c of agg.contains) {
    const toDoc = `${lowerFirst(c.partName)}ToDoc`;
    if (c.collection) rootEntries.push(`${c.name}: aggregate.${c.name}.map((e) => ${toDoc}(e))`);
    else if (c.optional)
      rootEntries.push(
        `${c.name}: aggregate.${c.name} == null ? null : ${toDoc}(aggregate.${c.name})`,
      );
    else rootEntries.push(`${c.name}: ${toDoc}(aggregate.${c.name}!)`);
  }
  const rootRow = `{ ${rootEntries.join(", ")} }`;

  const audited = aggregateIsAudited(agg);
  const upsertCall = audited
    ? `    await em.upsert(${row}, stampInsert(rootRow));`
    : `    await em.upsert(${row}, rootRow);`;

  // Versioned optimistic-concurrency save (M-T3.4, default-on via `crudish`) —
  // the embedded analogue of the relational `versionedSaveLines` and the drizzle
  // embedded builder's guarded write.  `rootEntries` already carries `version:
  // aggregate.version` (a projected field); the guarded path drops it and stamps
  // the CAS value itself (1 on insert, expected + 1 on the update).  A
  // non-versioned embedded aggregate keeps the byte-identical bare upsert.
  const versioned = aggregateIsVersioned(agg);
  const rootEntriesNoVersion = rootEntries.filter((e) => !e.startsWith("version:"));
  const rootRowInsert = `{ ${rootEntriesNoVersion.join(", ")}, version: 1 }`;
  const rootRowUpdate = `{ ${rootEntriesNoVersion.join(", ")}, version: expected + 1 }`;
  const insertValues = audited ? `stampInsert(${rootRowInsert})` : rootRowInsert;
  const updateSet = audited ? `stampUpdate(${rootRowUpdate})` : rootRowUpdate;
  const versionedSaveLines = [
    `    const expected = expectedVersion ?? aggregate.version;`,
    `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
    `    if (existing === null) {`,
    `      await em.insert(${row}, ${insertValues});`,
    `    } else {`,
    `      const affected = await em.nativeUpdate(${row}, { id: aggregate.id as string, version: expected }, ${updateSet});`,
    `      if (affected === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
    `    }`,
  ];

  const dbg = (find: string, rowsExpr: string) =>
    `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${find}", rows: ${rowsExpr} });`;

  const findMethods = [...(repo?.finds ?? []), ...synthViewFinds(agg, ctx)].map((f) => {
    const name = lowerFirst(f.name);
    const paged = pagedReturn(f.returnType);
    const isList = f.returnType.kind === "array";
    const ret = isList ? `${agg.name}[]` : `${agg.name} | null`;
    const params = f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`).join(", ");
    let filter: string;
    try {
      const caps = mikroContextFilters(agg, { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps });
      filter = withContextFilters(f.filter ? whereToMikroFilter(f.filter) : "{}", caps);
    } catch {
      return lines(
        `  async ${name}(${paged ? `${params}${params ? ", " : ""}page: number, pageSize: number, sort: string, dir: string` : params}): Promise<${paged ? `{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }` : ret}> {`,
        `    throw new Error("mikroorm v1: this find's predicate is not yet supported");`,
        `  }`,
      );
    }
    if (paged) {
      const pagedParams = [
        ...f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`),
        "page: number",
        "pageSize: number",
        "sort: string",
        "dir: string",
      ].join(", ");
      const sortable = sortableFields(agg)
        .map((s) => JSON.stringify(s))
        .join(", ");
      return lines(
        `  async ${name}(${pagedParams}): Promise<{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const sortable = new Set<string>([${sortable}]);`,
        `    const sortField = sortable.has(sort) ? sort : "id";`,
        `    const orderBy: Record<string, "asc" | "desc"> = { [sortField]: dir === "desc" ? "desc" : "asc" };`,
        `    const total = await em.count(${row}, ${filter});`,
        `    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;`,
        `    const rows = await em.find(${row}, ${filter}, { limit: pageSize, offset: (page - 1) * pageSize, orderBy });`,
        dbg(f.name, "rows.length"),
        `    const items = rows.map((row) => {`,
        ...embeddedHydrateLocals(agg, "row", "      ", ctx),
        `      return ${hydrateRootExpr(agg, "row", ctx)};`,
        `    });`,
        `    return { items, page, pageSize, total, totalPages };`,
        `  }`,
      );
    }
    if (isList) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork({ keepTransactionContext: true });`,
        `    const rows = await em.find(${row}, ${filter});`,
        dbg(f.name, "rows.length"),
        `    return rows.map((row) => {`,
        ...embeddedHydrateLocals(agg, "row", "      ", ctx),
        `      return ${hydrateRootExpr(agg, "row", ctx)};`,
        `    });`,
        `  }`,
      );
    }
    return lines(
      `  async ${name}(${params}): Promise<${agg.name} | null> {`,
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const row = await em.findOne(${row}, ${filter});`,
      `    if (row === null) return null;`,
      ...embeddedHydrateLocals(agg, "row", "    ", ctx),
      `    return ${hydrateRootExpr(agg, "row", ctx)};`,
      `  }`,
    );
  });

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `  async delete(id: ${idVar}): Promise<void> {`,
        `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, ${withContextFilters("{ id: id as string }", [])});`,
        `  }`,
      )
    : "";

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    `  private readonly em: EntityManager;`,
    `  private readonly events: DomainEventDispatcher;`,
    `  constructor(`,
    `    em: EntityManager,`,
    `    events: DomainEventDispatcher,`,
    `  ) {`,
    `    this.em = em;`,
    `    this.events = events;`,
    `  }`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, ${withContextFilters("{ id: id as string }", baseFilters)});`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
    ...embeddedHydrateLocals(agg, "row", "    ", ctx),
    `    const loaded = ${hydrateRootExpr(agg, "row", ctx)};`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: true });`,
    `    return loaded;`,
    `  }`,
    "",
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, ${withContextFilters("{ id: { $in: ids as string[] } }", baseFilters)});`,
    `    return rows.map((row) => {`,
    ...embeddedHydrateLocals(agg, "row", "      ", ctx),
    `      return ${hydrateRootExpr(agg, "row", ctx)};`,
    `    });`,
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    ...(versioned ? versionedSaveLines : [`    const rootRow = ${rootRow};`, upsertCall]),
    `    requestLog().debug({ event: "repository_save", aggregate: "${agg.name}", id: aggregate.id as string });`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    `      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string });`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    deleteMethod ? "" : null,
    deleteMethod || null,
    ...findMethods.flatMap((m) => ["", m]),
    "",
    toWireMethod(agg, ctx),
    `}`,
    "",
    // Containment (de)serialisers — parts only; the root uses columns.
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
    ...agg.parts.flatMap((p) => [entityFromDocFn(p, false, agg.name, ctx), ""]),
  );

  const bodyScan = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const candidates = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  const referenced = candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (referenced.length > 0) {
    const anyValue = referenced.some(isValueUsed);
    voImportLine = anyValue
      ? `import { ${referenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${referenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesDecimal = /new\s+Decimal\(/.test(bodyScan);
  const usesPrincipal = /\brequireCurrentUser\(/.test(bodyScan);

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${row} } from "../entities";`,
      audited && `import { stampInsert${versioned ? ", stampUpdate" : ""} } from "../audit-stamp";`,
      `import { ${[agg.name, ...agg.parts.map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import { AggregateNotFoundError${versioned ? ", ConcurrencyError" : ""} } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Document-shape (`shape(document)`) MikroORM repository.  The whole aggregate
// tree collapses to ONE opaque jsonb blob (`(id, data, version)`) — the Marten-
// style end of the saving-shape spectrum.  Row ↔ domain mapping runs entirely
// through the shared `<agg>ToDoc` / `<agg>FromDoc` (de)serialisers the drizzle
// document repository uses (contained parts nest, `Id[]` references ride as id
// strings), so the wire contract is byte-identical to the drizzle document
// path.  Capability `filter`s and find predicates can't be column FilterQueries
// (every field lives in the blob), so they evaluate IN-APP over the rehydrated
// aggregates — mirroring `buildDocumentRepositoryFile`.
// ---------------------------------------------------------------------------
export function renderMikroDocumentRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(agg.name);
  const idVar = `Ids.${agg.name}Id`;
  const versioned = aggregateIsVersioned(agg);
  const emitsDelete = !!agg.canonicalDestroy;
  // Root rehydrate — a versioned root takes the authoritative `version` COLUMN
  // (the blob copy lags a write), matching the drizzle document path.
  const fromDocOf = (rowVar: string): string =>
    versioned
      ? `${lowerFirst(agg.name)}FromDoc(${rowVar}.data as ${agg.name}Doc, ${rowVar}.version)`
      : `${lowerFirst(agg.name)}FromDoc(${rowVar}.data as ${agg.name}Doc)`;
  // In-app capability predicate over a rehydrated aggregate (soft-delete /
  // non-principal tenancy).  Principal filters are validator-rejected on Hono,
  // so no `requireCurrentUser()` bind is reachable here.
  const capRec = documentCapabilityBody(agg, "rec");
  const capX = documentCapabilityBody(agg, "x");

  // Finds evaluate in-memory over the rehydrated read model (the read already
  // deserialises every row), narrowed first by the capability filter then by
  // the find's own predicate — same selector shape as the drizzle document
  // builder's `documentFindMethod`.
  const findMethods = [...(repo?.finds ?? []), ...synthViewFinds(agg, ctx)].map((f) => {
    const params = f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`).join(", ");
    const pred = findPredicate(agg, f, ctx);
    const isArray = f.returnType.kind === "array";
    const isOptional = f.returnType.kind === "optional";
    const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
    const allExpr = capX ? `all.filter((x) => ${capX})` : "all";
    const selector = isArray
      ? pred
        ? `${allExpr}.filter(${pred})`
        : allExpr
      : isOptional
        ? `${allExpr}.find(${pred ?? "() => true"}) ?? null`
        : `${allExpr}.find(${pred ?? "() => true"})!`;
    const rowsExpr = isArray ? "result.length" : "result == null ? 0 : 1";
    return lines(
      `  async ${f.name}(${params}): Promise<${ret}> {`,
      `    const em = this.em.fork({ keepTransactionContext: true });`,
      `    const rows = await em.find(${row}, {});`,
      `    const all = rows.map((r) => ${fromDocOf("r")});`,
      `    const result = ${selector};`,
      `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${f.name}", rows: ${rowsExpr} });`,
      `    return result;`,
      `  }`,
    );
  });

  const deleteMethod = emitsDelete
    ? lines(
        `  async delete(id: ${idVar}): Promise<void> {`,
        `    await this.em.fork({ keepTransactionContext: true }).nativeDelete(${row}, { id: id as string });`,
        `  }`,
      )
    : "";

  const saveLines = versioned
    ? [
        `    const expected = expectedVersion ?? aggregate.version;`,
        `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
        `    if (existing === null) {`,
        `      await em.insert(${row}, { id: aggregate.id as string, data, version: 1 });`,
        `    } else {`,
        `      const affected = await em.nativeUpdate(${row}, { id: aggregate.id as string, version: expected }, { data, version: expected + 1 });`,
        `      if (affected === 0) throw new ConcurrencyError("${agg.name}", aggregate.id as string);`,
        `    }`,
      ]
    : [
        `    const existing = await em.findOne(${row}, { id: aggregate.id as string });`,
        `    if (existing === null) {`,
        `      await em.insert(${row}, { id: aggregate.id as string, data, version: 1 });`,
        `    } else {`,
        `      await em.nativeUpdate(${row}, { id: aggregate.id as string }, { data, version: existing.version + 1 });`,
        `    }`,
      ];

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    `  private readonly em: EntityManager;`,
    `  private readonly events: DomainEventDispatcher;`,
    `  constructor(`,
    `    em: EntityManager,`,
    `    events: DomainEventDispatcher,`,
    `  ) {`,
    `    this.em = em;`,
    `    this.events = events;`,
    `  }`,
    "",
    `  async findById(id: ${idVar}): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, { id: id as string });`,
    `    requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: !!row });`,
    `    if (row === null) return null;`,
    ...(capRec
      ? [
          `    const rec = ${fromDocOf("row")};`,
          `    if (!(${capRec})) return null;`,
          `    return rec;`,
        ]
      : [`    return ${fromDocOf("row")};`]),
    `  }`,
    "",
    `  async getById(id: ${idVar}): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    `  async findManyByIds(ids: ${idVar}[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, { id: { $in: ids as string[] } });`,
    `    return rows.map((r) => ${fromDocOf("r")})${capX ? `.filter((x) => ${capX})` : ""};`,
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const data = ${lowerFirst(agg.name)}ToDoc(aggregate);`,
    ...saveLines,
    `    requestLog().debug({ event: "repository_save", aggregate: "${agg.name}", id: aggregate.id as string });`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    `      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string });`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
    deleteMethod ? "" : null,
    deleteMethod || null,
    ...findMethods.flatMap((m) => ["", m]),
    "",
    toWireMethod(agg, ctx),
    `}`,
    "",
    // Document (de)serialisers — module-level so they recurse into contained
    // parts.  The root carries a `<Agg>Doc` type alias; parts carry their own.
    docTypeAlias(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [docTypeAlias(p, false, agg.name, ctx), ""]),
    entityToDocFn(agg, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityToDocFn(p, ctx), ""]),
    entityFromDocFn(agg, true, agg.name, ctx),
    "",
    ...agg.parts.flatMap((p) => [entityFromDocFn(p, false, agg.name, ctx), ""]),
  );

  const bodyScan = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const candidates = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  const referenced = candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (referenced.length > 0) {
    const anyValue = referenced.some(isValueUsed);
    voImportLine = anyValue
      ? `import { ${referenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${referenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesDecimal = /new\s+Decimal\(/.test(bodyScan);
  const usesPrincipal = /\brequireCurrentUser\(/.test(bodyScan);

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${row} } from "../entities";`,
      `import { ${[agg.name, ...agg.parts.map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      versioned
        ? `import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";`
        : `import { AggregateNotFoundError } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}

/** TS type for a find parameter (id params are branded; scalars pass through). */
function tsParamType(t: TypeIR): string {
  const inner = t.kind === "optional" ? t.inner : t;
  if (inner.kind === "id") return `Ids.${inner.targetName}Id`;
  if (inner.kind === "enum") return inner.name;
  if (inner.kind === "primitive") {
    switch (inner.name) {
      case "int":
      case "long":
        return "number";
      case "bool":
        return "boolean";
      case "datetime":
        return "Date";
      default:
        return "string";
    }
  }
  return "string";
}

// ---------------------------------------------------------------------------
// Event-sourced (`persistedAs(eventLog)`) MikroORM repository (appliers,
// MikroORM edition).  The Hono domain fold (`_apply` / `_fromEvents`) + CQRS
// are persistence-agnostic and reused; this is the EntityManager version of
// the event store — read the `<agg>_events` stream ordered by version and fold
// via `_fromEvents`; append `pullEvents()` with gap-free versions; finds load
// every stream + fold in-memory.  Payloads round-trip through the document
// builder's field (de)serialisers.
// ---------------------------------------------------------------------------
export function renderMikroEventSourcedRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const eventRow = eventRowClassOf(ctx.name);
  // This aggregate's slice of the shared per-context event log — discriminated
  // by `stream_type = "<Agg>"` (mirrors the Drizzle ES repo).
  const streamType = agg.name;
  const streamEvents: EventIR[] = (agg.appliers ?? [])
    .map((ap) => ctx.events.find((e) => e.name === ap.event))
    .filter((e): e is EventIR => e != null);

  const eventToDataArms = streamEvents.flatMap((e) => {
    const entries = e.fields.map(
      (f) => `${f.name}: ${serializeField(f.type, `ev.${f.name}`, ctx)}`,
    );
    return [`    case ${JSON.stringify(e.name)}:`, `      return { ${entries.join(", ")} };`];
  });
  const rowToEventArms = streamEvents.flatMap((e) => {
    const entries = [
      `type: ${JSON.stringify(e.name)}`,
      ...e.fields.map((f) => `${f.name}: ${deserializeField(f.type, `d.${f.name}`, ctx)}`),
    ];
    const dType = e.fields.map((f) => `${f.name}: ${docFieldType(f.type, ctx)}`).join("; ");
    return [
      `    case ${JSON.stringify(e.name)}: {`,
      `      const d = data as { ${dType} };`,
      `      return { ${entries.join(", ")} } as Events.${e.name};`,
      "    }",
    ];
  });

  const findMethods = [...(repo?.finds ?? []), ...synthViewFinds(agg, ctx)].map((find) => {
    const usesUser = findUsesCurrentUser(find);
    const baseParams = find.params.map((p) => `${p.name}: ${tsParamType(p.type)}`);
    const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
    const pred = findPredicate(agg, find, ctx);
    const isArray = find.returnType.kind === "array";
    const isOptional = find.returnType.kind === "optional";
    const ret = isArray ? `${agg.name}[]` : isOptional ? `${agg.name} | null` : agg.name;
    const selector = isArray
      ? pred
        ? `all.filter(${pred})`
        : "all"
      : isOptional
        ? `all.find(${pred ?? "() => true"}) ?? null`
        : `all.find(${pred ?? "() => true"})!`;
    return lines(
      `  async ${find.name}(${params}): Promise<${ret}> {`,
      "    const all = await this._loadAll();",
      `    return ${selector};`,
      "  }",
    );
  });

  const repoUsesUser = (repo?.finds ?? []).some(findUsesCurrentUser);

  const body = lines(
    `export class ${agg.name}Repository implements ${repoPortName(agg.name)} {`,
    // Explicit field declarations + constructor assignments, not
    // parameter properties — see emit/value-objects.ts's renderValueObject.
    "  private readonly em: EntityManager;",
    "  private readonly events: DomainEventDispatcher;",
    "  constructor(",
    "    em: EntityManager,",
    "    events: DomainEventDispatcher,",
    "  ) {",
    "    this.em = em;",
    "    this.events = events;",
    "  }",
    "",
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    `    const rows = await em.find(${eventRow}, { streamType: "${streamType}", streamId: id as string }, { orderBy: { version: "ASC" } });`,
    "    if (rows.length === 0) return null;",
    `    return ${agg.name}._fromEvents(`,
    "      id,",
    "      rows.map((r) => rowToEvent({ type: r.type, data: r.data })),",
    "    );",
    "  }",
    "",
    `  async getById(id: Ids.${agg.name}Id): Promise<${agg.name}> {`,
    "    const found = await this.findById(id);",
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    "    return found;",
    "  }",
    "",
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    "    if (ids.length === 0) return [];",
    `    const out: ${agg.name}[] = [];`,
    "    for (const id of ids) {",
    "      const found = await this.findById(id);",
    "      if (found) out.push(found);",
    "    }",
    "    return out;",
    "  }",
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    "    const pending = aggregate.pullEvents();",
    "    if (pending.length > 0) {",
    "      const streamId = aggregate.id as string;",
    `      const prior = await em.find(${eventRow}, { streamType: "${streamType}", streamId }, { orderBy: { version: "DESC" }, limit: 1 });`,
    "      let version = prior.length > 0 ? prior[0]!.version : 0;",
    "      for (const event of pending) {",
    "        version++;",
    `        const r = new ${eventRow}();`,
    `        r.streamType = "${streamType}";`,
    "        r.streamId = streamId;",
    "        r.version = version;",
    "        r.type = event.type;",
    "        r.data = eventToData(event);",
    "        r.occurredAt = new Date();",
    "        em.persist(r);",
    "      }",
    "      await em.flush();",
    "    }",
    '    requestLog().debug({ event: "repository_save", aggregate: ' +
      JSON.stringify(agg.name) +
      ", id: aggregate.id as string });",
    "    for (const event of pending) {",
    '      requestLog().info({ event: "event_dispatched", event_type: event.type, aggregate: ' +
      JSON.stringify(agg.name) +
      ", id: aggregate.id as string });",
    "      await this.events.dispatch(event);",
    "    }",
    "  }",
    "",
    `  private async _loadAll(): Promise<${agg.name}[]> {`,
    "    const em = this.em.fork({ keepTransactionContext: true });",
    `    const rows = await em.find(${eventRow}, { streamType: "${streamType}" }, { orderBy: { streamId: "ASC", version: "ASC" } });`,
    "    const byStream = new Map<string, Events.DomainEvent[]>();",
    "    for (const r of rows) {",
    "      const list = byStream.get(r.streamId) ?? [];",
    "      list.push(rowToEvent({ type: r.type, data: r.data }));",
    "      byStream.set(r.streamId, list);",
    "    }",
    `    return [...byStream.entries()].map(([id, evs]) => ${agg.name}._fromEvents(Ids.${agg.name}Id(id), evs));`,
    "  }",
    ...findMethods.flatMap((m) => ["", m]),
    "",
    toWireMethod(agg, ctx),
    "}",
    "",
    "function eventToData(ev: Events.DomainEvent): Record<string, unknown> {",
    "  switch (ev.type) {",
    ...eventToDataArms,
    "    default:",
    "      return {};",
    "  }",
    "}",
    "",
    "function rowToEvent(row: { type: string; data: unknown }): Events.DomainEvent {",
    "  const data = row.data;",
    "  switch (row.type) {",
    ...rowToEventArms,
    "    default:",
    "      throw new Error(`unknown event type: ${row.type}`);",
    "  }",
    "}",
  );

  const bodyScan = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const candidates = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  const referenced = candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (referenced.length > 0) {
    const anyValue = referenced.some(isValueUsed);
    voImportLine = anyValue
      ? `import { ${referenced.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${referenced.join(", ")} } from "../../domain/value-objects";`;
  }
  const usesDecimal = /new\s+Decimal\(/.test(bodyScan);
  const usesPrincipal = /\brequireCurrentUser\(/.test(bodyScan);

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      // Domain-side repository PORT this concrete implements (audit S7).
      repoPortImportLine(agg.name),
      usesPrincipal && `import { requireCurrentUser } from "../../auth/middleware";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${eventRow} } from "../entities";`,
      // The aggregate root + any contained entity parts (folded in-memory from
      // the stream) — `toWire` projects the part shapes, so their classes must
      // be in scope even though the ES store never touches a child table.
      `import { ${[agg.name, ...(agg.parts ?? []).map((p) => p.name)].join(", ")} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import type * as Events from "../../domain/events";`,
      `import { AggregateNotFoundError } from "../../domain/errors";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      repoUsesUser && `import type { User } from "../../auth/user-types";`,
      `import { requestLog } from "../../obs/als";`,
      "",
      body,
      "",
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Polymorphic base readers (aggregate-inheritance.md) — MikroORM editions of
// the drizzle `buildBaseReaderFile` / `buildTpcBaseReaderFile`.  An abstract
// base owns no user repository (validator-forbidden), but polymorphic access
// ("reference any PaymentMethod, query all of them") still needs a read home:
// a `<Base>Repository` returning the `Concrete | …` tagged union.
// ---------------------------------------------------------------------------

/** Narrow the VO/enum/Decimal imports a base-reader body actually references,
 *  matching the discipline the per-aggregate repository builder keeps. */
function baseReaderImports(
  bodyStr: string,
  concretes: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
): { voImportLine: string | false; usesMoney: boolean } {
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const voOrEnum = [
    ...new Set(concretes.flatMap((c) => [...collectValueObjects(c, ctx), ...collectEnums(c, ctx)])),
  ].filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  let voImportLine: string | false = false;
  if (voOrEnum.length > 0) {
    voImportLine = voOrEnum.some(isValueUsed)
      ? `import { ${voOrEnum.map((n) => (isValueUsed(n) ? n : `type ${n}`)).join(", ")} } from "../../domain/value-objects";`
      : `import type { ${voOrEnum.join(", ")} } from "../../domain/value-objects";`;
  }
  // Deep check — a concrete with money only inside a VO field still hydrates
  // via `new Decimal(...)`, so gate the import on the VO-aware predicate.
  return {
    voImportLine,
    usesMoney: concretes.some((c) => aggregateUsesMoneyDeep(c, ctx.valueObjects)),
  };
}

/** TPH (`sharedTable`) read-only `<Base>Repository` — scans the shared Row and
 *  dispatches on the `kind` discriminator to hydrate the right concrete. */
export function renderMikroBaseReader(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(base.name);
  const cases = concretes.flatMap((c) => [
    `    case ${JSON.stringify(c.name)}:`,
    `      return ${hydrateConcreteFromSharedRow(c, "row", ctx)};`,
  ]);
  const body = lines(
    `export class ${base.name}Repository {`,
    `  private readonly em: EntityManager;`,
    `  constructor(em: EntityManager) {`,
    `    this.em = em;`,
    `  }`,
    "",
    `  async findById(id: Ids.${base.name}Id): Promise<${base.name} | null> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const row = await em.findOne(${row}, { id: id as string });`,
    `    if (row === null) return null;`,
    `    return hydrate${base.name}(row);`,
    `  }`,
    "",
    `  async findAll(): Promise<${base.name}[]> {`,
    `    const em = this.em.fork({ keepTransactionContext: true });`,
    `    const rows = await em.find(${row}, {});`,
    `    return rows.map(hydrate${base.name});`,
    `  }`,
    `}`,
    "",
    `function hydrate${base.name}(row: ${row}): ${base.name} {`,
    `  switch (row.kind) {`,
    ...cases,
    `    default:`,
    "      throw new Error(`unknown " + base.name + " kind: ${row.kind}`);",
    `  }`,
    `}`,
  );
  const { voImportLine, usesMoney } = baseReaderImports(body, concretes, ctx);
  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesMoney && `import Decimal from "decimal.js";`,
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${row} } from "../entities";`,
      `import * as Ids from "../../domain/ids";`,
      ...concretes.map((c) => `import { ${c.name} } from "../../domain/${lowerFirst(c.name)}";`),
      voImportLine,
      `import type { ${base.name} } from "../../domain/${lowerFirst(base.name)}";`,
      "",
      body,
      "",
    ) + "\n"
  );
}

/** TPC (`ownTable`) read-only `<Base>Repository` — each concrete is its own
 *  table with a full repository, so this DELEGATES: `findAll` unions each
 *  concrete's `all()`, `findById` tries each in turn.  Every aggregate loads
 *  its complete tree through the loader that already knows how (mirrors the
 *  drizzle `buildTpcBaseReaderFile`; N round-trips traded for reuse). */
export function renderMikroTpcBaseReader(
  base: EnrichedAggregateIR,
  concretes: readonly EnrichedAggregateIR[],
): string {
  const repoCtor = (c: EnrichedAggregateIR): string => `${c.name}Repository`;
  const repoField = (c: EnrichedAggregateIR): string => `${lowerFirst(c.name)}Repo`;
  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import type { DomainEventDispatcher } from "../../domain/events";`,
      `import * as Ids from "../../domain/ids";`,
      ...concretes.map(
        (c) => `import { ${repoCtor(c)} } from "./${lowerFirst(c.name)}-repository";`,
      ),
      `import type { ${base.name} } from "../../domain/${lowerFirst(base.name)}";`,
      "",
      `// Polymorphic ${base.name} reader (TPC / ownTable): delegates to each`,
      `// concrete repository so every aggregate loads its full tree, then unions`,
      `// the results.  Read-only — writes go through the per-concrete repos.`,
      `export class ${base.name}Repository {`,
      ...concretes.map((c) => `  private readonly ${repoField(c)}: ${repoCtor(c)};`),
      `  constructor(em: EntityManager, events: DomainEventDispatcher) {`,
      ...concretes.map((c) => `    this.${repoField(c)} = new ${repoCtor(c)}(em, events);`),
      `  }`,
      "",
      `  async findById(id: Ids.${base.name}Id): Promise<${base.name} | null> {`,
      ...concretes.flatMap((c) => [
        `    const ${repoField(c)}Hit = await this.${repoField(c)}.findById(id as unknown as Ids.${c.name}Id);`,
        `    if (${repoField(c)}Hit) return ${repoField(c)}Hit;`,
      ]),
      `    return null;`,
      `  }`,
      "",
      `  async findAll(): Promise<${base.name}[]> {`,
      `    const results = await Promise.all([`,
      ...concretes.map((c) => `      this.${repoField(c)}.all(),`),
      `    ]);`,
      `    return results.flat();`,
      `  }`,
      `}`,
      "",
    ) + "\n"
  );
}
