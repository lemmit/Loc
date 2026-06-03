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
// CRUD + simple finds. Everything else is rejected at validate time.
// ---------------------------------------------------------------------------

import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  FieldIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { hydrateRootExpr } from "../repository-find-builder.js";
import { projectFieldEntries, projectionObject } from "../repository-save-builder.js";
import { toWireMethod } from "../repository-wire-builder.js";

/** Postgres table for an aggregate — lowercase plural (e.g. `orders`). */
const tableOf = (aggName: string): string => plural(snake(aggName));

/** Row-entity class name for an aggregate (the MikroORM persistence model). */
const rowClassOf = (aggName: string): string => `${aggName}Row`;

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
  return [id, ...agg.fields.flatMap((f) => fieldColumns(f, ctx))];
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
  for (const agg of aggs) {
    const cols = columnsOf(agg, ctx);
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

/** Conjunctions merge into one object; `||` becomes `$or`. */
function whereToMikroFilter(e: ExprIR): string {
  if (e.kind === "paren") return whereToMikroFilter(e.inner);
  if (e.kind === "binary") {
    if (e.op === "&&") {
      const entries = [...flattenAnd(e)].map((c) => comparisonEntry(c));
      return `{ ${entries.join(", ")} }`;
    }
    if (e.op === "||") {
      return `{ $or: [${orBranches(e)
        .map((b) => `{ ${comparisonEntry(b)} }`)
        .join(", ")}] }`;
    }
    return `{ ${comparisonEntry(e)} }`;
  }
  throw new Error(`mikroorm: unsupported find expression '${e.kind}'`);
}

function flattenAnd(e: Extract<ExprIR, { kind: "binary" }>): Extract<ExprIR, { kind: "binary" }>[] {
  const out: Extract<ExprIR, { kind: "binary" }>[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "&&") {
      visit(inner.left);
      visit(inner.right);
    } else if (inner.kind === "binary") {
      out.push(inner);
    } else {
      throw new Error("mikroorm: unsupported conjunct in find");
    }
  };
  visit(e);
  return out;
}

function orBranches(e: Extract<ExprIR, { kind: "binary" }>): Extract<ExprIR, { kind: "binary" }>[] {
  const out: Extract<ExprIR, { kind: "binary" }>[] = [];
  const visit = (n: ExprIR): void => {
    const inner = n.kind === "paren" ? n.inner : n;
    if (inner.kind === "binary" && inner.op === "||") {
      visit(inner.left);
      visit(inner.right);
    } else if (inner.kind === "binary") {
      out.push(inner);
    } else {
      throw new Error("mikroorm: unsupported disjunct in find");
    }
  };
  visit(e);
  return out;
}

// ---------------------------------------------------------------------------
// Per-aggregate repository — a drop-in for the drizzle `<Agg>Repository`.
// ---------------------------------------------------------------------------

export function renderMikroRepository(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassOf(agg.name);
  const hydrate = (rowVar: string) => hydrateRootExpr(agg, rowVar, ctx);
  // The id (primary key) leads the upsert payload — `projectFieldEntries`
  // covers only the declared fields, so it's prepended explicitly (matching
  // the drizzle save row).
  const saveProjection = projectionObject("aggregate", [
    { fieldName: "id", expr: "aggregate.id as string" },
    ...agg.fields.flatMap((f) => projectFieldEntries(f, "aggregate", ctx)),
  ]);

  const dbg = (find: string, rowsExpr: string) =>
    `    requestLog().debug({ event: "find_executed", aggregate: "${agg.name}", find: "${find}", rows: ${rowsExpr} });`;

  const findMethods = (repo?.finds ?? []).map((f) => {
    const name = lowerFirst(f.name);
    const isList = f.returnType.kind === "array";
    const ret = isList ? `${agg.name}[]` : `${agg.name} | null`;
    const params = f.params.map((p) => `${p.name}: ${tsParamType(p.type)}`).join(", ");
    let filter: string;
    try {
      filter = f.filter ? whereToMikroFilter(f.filter) : "{}";
    } catch {
      return lines(
        `  async ${name}(${params}): Promise<${ret}> {`,
        `    throw new Error("mikroorm v1: this find's predicate is not yet supported");`,
        `  }`,
      );
    }
    if (isList) {
      return lines(
        `  async ${name}(${params}): Promise<${agg.name}[]> {`,
        `    const em = this.em.fork();`,
        `    const rows = await em.find(${row}, ${filter});`,
        dbg(f.name, "rows.length"),
        `    return rows.map((row) => ${hydrate("row")});`,
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

  const deleteMethod = agg.canonicalDestroy
    ? lines(
        `  async delete(id: Ids.${agg.name}Id): Promise<void> {`,
        `    await this.em.fork().nativeDelete(${row}, { id: id as string });`,
        `  }`,
      )
    : "";

  const body = lines(
    `export class ${agg.name}Repository {`,
    `  constructor(`,
    `    private readonly em: EntityManager,`,
    `    private readonly events: DomainEventDispatcher,`,
    `  ) {}`,
    "",
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    `    const em = this.em.fork();`,
    `    const row = await em.findOne(${row}, { id: id as string });`,
    `    if (row === null) {`,
    `      requestLog().debug({ event: "aggregate_loaded", aggregate: "${agg.name}", id: id as string, found: false });`,
    `      return null;`,
    `    }`,
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
    `    const rows = await em.find(${row}, { id: { $in: ids as string[] } });`,
    `    return rows.map((row) => ${hydrate("row")});`,
    `  }`,
    "",
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    `    const em = this.em.fork();`,
    `    await em.upsert(${row}, ${saveProjection});`,
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
      `import { EntityManager } from "@mikro-orm/postgresql";`,
      `import { ${row} } from "../entities";`,
      `import { ${agg.name} } from "../../domain/${lowerFirst(agg.name)}";`,
      voImportLine,
      `import * as Ids from "../../domain/ids";`,
      `import { AggregateNotFoundError } from "../../domain/errors";`,
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
