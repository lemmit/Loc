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
// them — using the EntityManager idiomatically (`em.fork()` for isolated unit-
// of-work, `em.findOne` / `em.find` with real FilterQuery objects, `em.upsert`,
// `em.nativeDelete`). Schema is owned by MikroORM (`orm.schema.updateSchema()`
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
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesMoney,
  exprUsesCurrentUser,
  findUsesCurrentUser,
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
import { aggregateIsVersioned } from "../../../ir/util/versioned-capability.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";
import { joinColumnName, joinTableConstName } from "../emit.js";
import { isRefCollection } from "../repository-associations-builder.js";
import {
  deserializeField,
  docFieldType,
  findPredicate,
  serializeField,
} from "../repository-document-builder.js";
import { hydrateConcreteFromSharedRow, hydrateRootExpr } from "../repository-find-builder.js";
import { hydrateEntityExpr } from "../repository-find-hydrate.js";
import { collectEnums, collectValueObjects } from "../repository-imports-builder.js";
import { repoPortImportLine, repoPortName } from "../repository-port-builder.js";
import { projectFieldEntries, projectionObject } from "../repository-save-builder.js";
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
      return { mikro: "decimal", ts: "string" };
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

function columnsOf(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): MikroColumn[] {
  const id: MikroColumn = {
    prop: "id",
    mikroType: "string",
    tsType: "string",
    nullable: false,
    primary: true,
  };
  // `Id[]` reference collections persist as pivot tables (join-Row entities),
  // not columns on the aggregate row — skip them here.
  const scalarFields = agg.fields.filter((f) => !isRefCollection(f.type));
  return [id, ...scalarFields.flatMap((f) => fieldColumns(f, ctx))];
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

/** Render one child Row entity + EntitySchema for a contained entity part.
 *  Columns: `id` (PK), `parentId` (FK to the owner), then the part's own
 *  fields (scalar / enum / VO-flattened / id).  MikroORM owns the schema, so
 *  no explicit FK/index — the parent-scoped reads carry the relationship. */
function renderPartRowEntity(
  part: EntityPartIR,
  ctx: EnrichedBoundedContextIR,
): { block: string; schemaName: string } {
  const cls = partRowClassOf(part.name);
  const schemaName = `${cls}Schema`;
  const cols: MikroColumn[] = [
    { prop: "id", mikroType: "string", tsType: "string", nullable: false, primary: true },
    { prop: "parentId", mikroType: "string", tsType: "string", nullable: false, primary: false },
    ...part.fields.filter((f) => !isRefCollection(f.type)).flatMap((f) => fieldColumns(f, ctx)),
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

export function renderMikroEntities(
  aggs: readonly EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
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
    if (isTphConcrete(agg, aggs)) continue;
    // Abstract bases own no table EXCEPT a TPH root, which owns the shared
    // table (a TPC / intermediate abstract base emits nothing).
    if (agg.isAbstract && !isTphBase(agg, aggs)) continue;
    // TPH base → the one shared hierarchy table; else the aggregate's own
    // Row (a TPC concrete carries its merged base+own fields via columnsOf).
    const cols = isTphBase(agg, aggs) ? tphSharedColumns(agg, aggs, ctx) : columnsOf(agg, ctx);
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
    // (composite-PK join tables), one per declared collection field.
    for (const assoc of agg.associations ?? []) {
      const { block, schemaName: joinSchema } = renderJoinRowEntity(assoc);
      schemaNames.push(joinSchema);
      blocks.push(block);
    }
    // Contained entity parts persist as parent-scoped child Row entities
    // (relational shape), one table per declared part.
    for (const part of agg.parts ?? []) {
      const { block, schemaName: partSchema } = renderPartRowEntity(part, ctx);
      schemaNames.push(partSchema);
      blocks.push(block);
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
        // replay reader lands; not part of the PK.
        '    seq: { type: "number", columnType: "bigint", autoincrement: true },',
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

/** Render a `this.<col> <op> <param>` comparison as a `{ col: ... }` entry. */
function comparisonEntry(e: Extract<ExprIR, { kind: "binary" }>): string {
  const left = e.left;
  if (left.kind !== "member" || left.receiver.kind !== "this")
    throw new Error("mikroorm: unsupported find predicate (lhs not this.<field>)");
  // FilterQuery keys are entity PROPERTY names (== field names), not DB columns.
  const col = left.member;
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
// Principal-referencing filters (`currentUser.<field>`) are rejected on Hono at
// validate time, so only closed predicates reach here; each lowers to a
// FilterQuery object via `whereToMikroFilter` (guaranteed in-subset by
// `validateFindPredicateAdapterSupport`).  A read's `ignoring *` / `ignoring
// <Cap>` bypass drops the capability-origin predicates it names.
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
    if (exprUsesCurrentUser(pred)) return; // principal — validator-rejected on Hono
    const origin = origins[i];
    // Only capability-origin (`undefined` = bare/hand-written) filters are
    // bypassable; `ignoring *` drops every origin, a named `ignoring` the match.
    if (origin !== undefined && (bypass?.bypassAll || (bypass?.bypassCaps ?? []).includes(origin)))
      return;
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
  const hasChildren = (agg.associations ?? []).length > 0 || (agg.contains ?? []).length > 0;
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
// these helpers just supply those locals.  v1 is bounded to single-level flat
// parts (validator-gated), so a part row never nests further.
// ---------------------------------------------------------------------------

/** The entity part a containment names (undefined if malformed — validator-
 *  gated, so callers no-op). */
function partForContainment(agg: EnrichedAggregateIR, c: ContainmentIR): EntityPartIR | undefined {
  return (agg.parts ?? []).find((p) => p.name === c.partName);
}

/** Save projection for a child part row — `{ id, parentId, <fields> }`,
 *  reusing the shared field projector so the columns match the Row entity. */
function partProjection(
  part: EntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: `${varExpr}.parentId as string` },
    ...part.fields
      .filter((f) => !isRefCollection(f.type))
      .flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
  ]);
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
    if (c.collection) {
      return [
        `${indent}const ${c.name} = (await ${emVar}.find(${prow}, { parentId: ${ownerIdExpr} }, { orderBy: { id: "asc" } })).map((r) => ${hydrateEntityExpr(part, "r", agg, ctx)});`,
      ];
    }
    return [
      `${indent}const ${c.name}Row = await ${emVar}.findOne(${prow}, { parentId: ${ownerIdExpr} });`,
      `${indent}const ${c.name} = ${c.name}Row === null ? null : ${hydrateEntityExpr(part, `${c.name}Row`, agg, ctx)};`,
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
    const head = [
      `${indent}const ${rows} = rootIds.length === 0 ? [] : await ${emVar}.find(${prow}, { parentId: { $in: rootIds } }, { orderBy: { parentId: "asc", id: "asc" } });`,
      `${indent}const ${map} = new Map<string, ${elemT}>();`,
    ];
    if (c.collection) {
      return [
        ...head,
        `${indent}for (const r of ${rows}) {`,
        `${indent}  const list = ${map}.get(r.parentId) ?? [];`,
        `${indent}  list.push(${hydrateEntityExpr(part, "r", agg, ctx)});`,
        `${indent}  ${map}.set(r.parentId, list);`,
        `${indent}}`,
      ];
    }
    return [
      ...head,
      `${indent}for (const r of ${rows}) ${map}.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
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

/** Diff-sync each containment's child rows on save: delete the rows the
 *  aggregate no longer holds, upsert the current set (id is the PK). */
function containSaveLines(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  emVar: string,
  indent: string,
): string[] {
  return (agg.contains ?? []).flatMap((c) => {
    const part = partForContainment(agg, c);
    if (!part) return [];
    const prow = partRowClassOf(part.name);
    const cap = upperFirst(c.name);
    const itemsRef = c.collection
      ? `aggregate.${c.name}`
      : `(aggregate.${c.name} ? [aggregate.${c.name}] : [])`;
    return [
      `${indent}// Full child sync of the '${c.name}' containment.`,
      `${indent}const existing${cap} = await ${emVar}.find(${prow}, { parentId: aggregate.id as string });`,
      `${indent}const currentIds${cap} = new Set(${itemsRef}.map((e) => e.id as string));`,
      `${indent}for (const r of existing${cap}) {`,
      `${indent}  if (!currentIds${cap}.has(r.id)) await ${emVar}.nativeDelete(${prow}, { id: r.id });`,
      `${indent}}`,
      `${indent}for (const child of ${itemsRef}) {`,
      `${indent}  await ${emVar}.upsert(${prow}, ${partProjection(part, "child", ctx)});`,
      `${indent}}`,
    ];
  });
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
  const scalarFields = agg.fields.filter((f) => !isRefCollection(f.type));
  const hasAssocs = (agg.associations ?? []).length > 0;
  const hasContains = (agg.contains ?? []).length > 0;
  const hasChildren = hasAssocs || hasContains;
  // The id (primary key) leads the upsert payload — `projectFieldEntries`
  // covers only the declared fields, so it's prepended explicitly (matching
  // the drizzle save row).
  const saveProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...kindProjection,
    ...scalarFields.flatMap((f) => projectFieldEntries(f, "aggregate", ctx)),
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
    { fieldName: "version", expr: "1" },
  ]);
  const updateData = projectionObject("aggregate", [
    ...kindProjection,
    ...nonVersionEntries,
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

  const findMethods = (repo?.finds ?? []).map((f) => {
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
        `    const em = this.em.fork();`,
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
        `    const em = this.em.fork();`,
        `    const rows = await em.find(${row}, ${filter});`,
        dbg(f.name, "rows.length"),
        ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
        `  }`,
      );
    }
    // Single-row find: load the children inline (owner id known) then
    // hydrate, mirroring findById.
    if (hasChildren) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name} | null> {`,
        `    const em = this.em.fork();`,
        `    const row = await em.findOne(${row}, ${filter});`,
        `    if (row === null) return null;`,
        ...assocInlineLoadLines(agg, "em", "row.id", "    "),
        ...containInlineLoadLines(agg, ctx, "em", "row.id", "    "),
        `    return ${hydrate("row")};`,
        `  }`,
      );
    }
    return lines(
      `  async ${name}(${params}): Promise<${agg.name} | null> {`,
      `    const em = this.em.fork();`,
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
        `    const em = this.em.fork();`,
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
          `    const em = this.em.fork();`,
          // No FK cascade (MikroORM owns the schema), so clear the owner's
          // pivot rows + contained child rows before the root delete.
          ...(agg.associations ?? []).map(
            (a) =>
              `    await em.nativeDelete(${joinRowClassOf(a)}, { ${joinColumnName(a.ownerFk)}: id as string });`,
          ),
          ...(agg.contains ?? []).flatMap((c) => {
            const part = partForContainment(agg, c);
            return part
              ? [
                  `    await em.nativeDelete(${partRowClassOf(part.name)}, { parentId: id as string });`,
                ]
              : [];
          }),
          `    await em.nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
          `  }`,
        )
      : lines(
          `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
          `    await this.em.fork().nativeDelete(${row}, ${withContextFilters("{ id: id as string }", kindClause)});`,
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
    `    const em = this.em.fork();`,
    `    const row = await em.findOne(${row}, ${withContextFilters("{ id: id as string }", baseFilters)});`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
    ...assocInlineLoadLines(agg, "em", "id as string", "    "),
    ...containInlineLoadLines(agg, ctx, "em", "id as string", "    "),
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
    `    const em = this.em.fork();`,
    `    const rows = await em.find(${row}, ${withContextFilters("{ id: { $in: ids as string[] } }", baseFilters)});`,
    ...assocHydrateBind(agg, ctx, "em", "", "return", "    "),
    `  }`,
    "",
    versioned
      ? `  async save(aggregate: ${agg.name}, expectedVersion?: number): Promise<void> {`
      : `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const em = this.em.fork();`,
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

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      // Domain-side repository PORT this concrete implements (audit S7).
      repoPortImportLine(agg.name),
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

  const findMethods = (repo?.finds ?? []).map((find) => {
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
    "    const em = this.em.fork();",
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
    "    const em = this.em.fork();",
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
    "    const em = this.em.fork();",
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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emits a template literal into the generated TS source, not interpolated here
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

  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      usesDecimal && `import Decimal from "decimal.js";`,
      // Domain-side repository PORT this concrete implements (audit S7).
      repoPortImportLine(agg.name),
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${eventRow} } from "../entities";`,
      `import { ${agg.name} } from "../../domain/${lowerFirst(agg.name)}";`,
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
  return { voImportLine, usesMoney: concretes.some(aggregateUsesMoney) };
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
    `    const em = this.em.fork();`,
    `    const row = await em.findOne(${row}, { id: id as string });`,
    `    if (row === null) return null;`,
    `    return hydrate${base.name}(row);`,
    `  }`,
    "",
    `  async findAll(): Promise<${base.name}[]> {`,
    `    const em = this.em.fork();`,
    `    const rows = await em.find(${row}, {});`,
    `    return rows.map(hydrate${base.name});`,
    `  }`,
    `}`,
    "",
    `function hydrate${base.name}(row: ${row}): ${base.name} {`,
    `  switch (row.kind) {`,
    ...cases,
    `    default:`,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: ${row.kind} is emitted into the generated source, not interpolated here
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
