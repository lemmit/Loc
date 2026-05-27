import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead } from "../../ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EntityPartIR,
  FieldIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import {
  aggregateUsesMoney,
  findUsesCurrentUser,
  viewUsesCurrentUser,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { joinColumnName, joinTableConstName, valueObjectColumnNames } from "./emit.js";
import {
  associationMapLines,
  associationsOf,
  isRefCollection,
} from "./repository-associations-builder.js";
import { collectEnums, collectValueObjects } from "./repository-imports-builder.js";

// ---------------------------------------------------------------------------
// Generates the TypeScript repository file for an aggregate.
//
// The repository shape is fixed:
//   - `findById(id)` loads root + all contained part rows in a transaction
//     and reconstructs the aggregate tree
//   - `getById(id)` is `findById` with a not-found error
//   - `save(aggregate)` upserts root, then diff-syncs each contained
//     collection (insert new + update existing + delete removed) inside a
//     transaction, then dispatches drained domain events
//   - one method per repository-defined `find` query, body filled by
//     convention-based parameter-name → property-name matching
//
// All projection logic (Domain ↔ Drizzle row) is generated procedurally
// so type-safety in the output survives strict `tsc`.
// ---------------------------------------------------------------------------

export function buildRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  emitTrace = false,
): string {
  // Walk every find's filter (and any matching view filters — both
  // lower to Drizzle predicates on the same table) to figure out
  // which Drizzle operators we'll need.  Default operators (eq / and
  // / inArray) are always pulled in; the lowering may add ne / gt /
  // gte / lt / lte / or / not depending on the expression shape.
  const drizzleOps = new Set<string>(["eq", "and", "inArray"]);
  const viewFilters = ctx.views
    .filter((v) => v.aggregateName === agg.name && v.filter)
    .map((v) => v.filter!);
  const allFilters = [
    ...(repo?.finds ?? [])
      .map((f) => f.filter)
      .filter((x): x is import("../../ir/types/loom-ir.js").ExprIR => !!x),
    ...viewFilters,
  ];
  for (const f of allFilters) {
    const lowered = lowerToDrizzle(f, lowerFirst(plural(agg.name)), ctx);
    if (lowered) for (const op of lowered.ops) drizzleOps.add(op);
  }
  // If any find or matching view filter references currentUser, the
  // per-method signature gains a `currentUser: User` parameter that
  // the closure-captured Drizzle predicate reads.  Pull the User
  // type in as a type-only import so the file compiles even when
  // the verifier hook isn't wired yet.
  const repoUsesUser =
    (repo?.finds ?? []).some(findUsesCurrentUser) ||
    ctx.views.filter((v) => v.aggregateName === agg.name).some(viewUsesCurrentUser);
  const partNames = agg.parts.map((p) => p.name);
  const domainImports = [agg.name, ...partNames].join(", ");
  const valueObjectsUsed = collectValueObjects(agg, ctx);
  const enumsUsed = collectEnums(agg, ctx);
  const voOrEnumImports = [...valueObjectsUsed, ...enumsUsed];
  // Synthesised parameterless finds for each context-level view sourced
  // from this aggregate.  Lowering reuses the find path so the
  // validator's queryable checks + bulk hydration all work for free.
  const viewFinds: FindIR[] = ctx.views
    .filter((v) => v.aggregateName === agg.name)
    .map((view) => ({
      name: lowerFirst(view.name),
      params: [],
      returnType: { kind: "array", element: { kind: "entity", name: agg.name } },
      filter: view.filter,
    }));

  // Render the class body first so the file's imports + `type Tx` can be
  // narrowed to what's actually referenced — keeps the generated header
  // free of dead names (Biome generated-code gate).
  const bodyStr = lines(
    `export class ${agg.name}Repository {`,
    `  constructor(`,
    `    private readonly db: Db,`,
    `    private readonly events: DomainEventDispatcher,`,
    `  ) {}`,
    "",
    findByIdMethod(agg, ctx, emitTrace),
    "",
    `  async getById(id: Ids.${agg.name}Id): Promise<${agg.name}> {`,
    `    const found = await this.findById(id);`,
    `    if (!found) throw new AggregateNotFoundError(\`${agg.name} \${id} not found\`);`,
    `    return found;`,
    `  }`,
    "",
    // Bulk loader used by views that follow `X id` references in bind
    // expressions.  Same hydration path as the array-return finds;
    // filter is a single `inArray`.
    findManyByIdsMethod(agg, ctx),
    "",
    saveMethod(agg, ctx, emitTrace),
    "",
    ...(repo?.finds ?? []).flatMap((find) => [findQueryMethod(agg, find, ctx), ""]),
    ...viewFinds.flatMap((find) => [findQueryMethod(agg, find, ctx), ""]),
    // toWire — domain instance → wire DTO (plain object).  Used by the
    // Hono routes layer to serialize responses; the shape mirrors the
    // .NET <Agg>Response record so the cross-check sees identical specs.
    toWireMethod(agg, ctx),
    "",
    `}`,
  );

  // Strip string contents so symbols mentioned only inside error messages
  // or labels don't register as references for the import narrowing below.
  const bodyScan = bodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  // Narrow `drizzle-orm` ops to those actually called in the body, drop
  // `type Tx` when no method declares a `(tx: Tx)` parameter.
  const usedDrizzleOps = [...drizzleOps]
    .filter((op) => new RegExp(`\\b${op}\\(`).test(bodyScan))
    .sort();
  const usesTx = /:\s*Tx\b/.test(bodyScan);
  // VO / enum imports: per-symbol. A name needs a runtime value when
  // the body uses `new <Vo>(` (value-object construction) or `<Name>.<member>`
  // (enum value access). Otherwise it's type-only.
  const isValueUsed = (n: string): boolean =>
    new RegExp(`new\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyScan);
  const voOrEnumReferenced = voOrEnumImports.filter((n) => new RegExp(`\\b${n}\\b`).test(bodyScan));
  const anyVoOrEnumValueUsed = voOrEnumReferenced.some(isValueUsed);
  let voOrEnumImportLine: string | false = false;
  if (voOrEnumReferenced.length > 0) {
    if (!anyVoOrEnumValueUsed) {
      voOrEnumImportLine = `import type { ${voOrEnumReferenced.join(", ")} } from "../../domain/value-objects";`;
    } else {
      const symbols = voOrEnumReferenced.map((n) => (isValueUsed(n) ? n : `type ${n}`));
      voOrEnumImportLine = `import { ${symbols.join(", ")} } from "../../domain/value-objects";`;
    }
  }

  const repoUsesMoney = aggregateUsesMoney(agg);

  return lines(
    "// Auto-generated.  Do not edit by hand.",
    repoUsesMoney && `import Decimal from "decimal.js";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    usedDrizzleOps.length > 0 && `import { ${usedDrizzleOps.join(", ")} } from "drizzle-orm";`,
    `import * as schema from "../schema";`,
    repoUsesUser && `import type { User } from "../../auth/user-types";`,
    `import { ${domainImports} } from "../../domain/${lowerFirst(agg.name)}";`,
    voOrEnumImportLine,
    `import * as Ids from "../../domain/ids";`,
    `import { AggregateNotFoundError } from "../../domain/errors";`,
    `import type { DomainEventDispatcher } from "../../domain/events";`,
    `import { requestLog } from "../../obs/als";`,
    "",
    `type Db = NodePgDatabase<typeof schema>;`,
    usesTx && `type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];`,
    "",
    bodyStr,
    "",
  );
}

// ---------------------------------------------------------------------------
// toWire — domain → wire DTO serializer (matches the routes-builder's
// `<Agg>Response` zod schema; see routes-builder.ts).
// ---------------------------------------------------------------------------

function toWireMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  return lines(
    `  toWire(root: ${agg.name}): unknown {`,
    `    return ${wireProjectionEntity(agg, "root", ctx)};`,
    `  }`,
  );
}

function wireProjectionEntity(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
): string {
  // Single canonical walk — see `agg.wireShape` (populated by
  // src/ir/enrichments.ts).  This serializer feeds repo.toWire();
  // its output's keys must line up with the route's response Zod
  // schema and the .NET DTO.  `forApiRead` strips `internal` and
  // `secret` fields so the wire output matches the response schema's
  // field set.  Enriched brand flows in via
  // `PlatformSurface.emitProject(contexts: EnrichedBoundedContextIR[])`.
  const fields = forApiRead(wireShapeFor(ent));
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(`id: ${varExpr}.id as string`);
      continue;
    }
    if (wf.source === "containment") {
      const partName =
        wf.type.kind === "array" && wf.type.element.kind === "entity"
          ? wf.type.element.name
          : wf.type.kind === "entity"
            ? wf.type.name
            : "";
      const partIR = ctx.aggregates.flatMap((a) => a.parts).find((p) => p.name === partName);
      if (!partIR) continue;
      if (wf.type.kind === "array") {
        parts.push(
          `${wf.name}: ${varExpr}.${wf.name}.map((e: ${partIR.name}) => (${wireProjectionEntity(partIR, "e", ctx)}))`,
        );
      } else {
        parts.push(`${wf.name}: ${wireProjectionEntity(partIR, `${varExpr}.${wf.name}`, ctx)}`);
      }
      continue;
    }
    // property or derived — both reach the value via the same getter
    // on the domain class.
    parts.push(
      `${wf.name}: ${wireProjectionValue(`${varExpr}.${wf.name}`, wf.type, ctx, wf.optional)}`,
    );
  }
  // Co-located provenance rides the wire DTO so any GET surfaces the
  // current lineage inline (the field's own value still emits above).
  for (const f of ent.fields.filter((f) => f.provenanced)) {
    parts.push(`${f.name}_provenance: ${varExpr}.${f.name}_provenance`);
  }
  return `{ ${parts.join(", ")} }`;
}

function wireProjectionValue(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  optional: boolean,
): string {
  if (t.kind === "optional") {
    return `(${expr} == null ? null : ${wireProjectionValue(expr, t.inner, ctx, true)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "datetime")
      return optional
        ? `(${expr} == null ? null : (${expr} as Date).toISOString())`
        : `(${expr} as Date).toISOString()`;
    // decimal: JSON number — .NET serializes decimal the same way, so
    // both backends round-trip identically.
    return expr;
  }
  if (t.kind === "id") return `${expr} as string`;
  if (t.kind === "enum") return `${expr} as string`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return expr;
    const fields = vo.fields
      .map((vf) => `${vf.name}: ${wireProjectionValue(`${expr}.${vf.name}`, vf.type, ctx, false)}`)
      .join(", ");
    if (optional) {
      return `(${expr} == null ? null : { ${fields} })`;
    }
    return `{ ${fields} }`;
  }
  if (t.kind === "array") {
    // Lambda param is contextually typed by `.map` over the element
    // type; an explicit annotation would fight strict-mode inference
    // for branded `T id` element arrays.
    return `${expr}.map((a) => (${wireProjectionValue("a", t.element, ctx, false)}))`;
  }
  if (t.kind === "entity") return expr;
  return expr;
}

// ---------------------------------------------------------------------------
// findById — load root, load each part collection, hydrate
// ---------------------------------------------------------------------------

function findManyByIdsMethod(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string {
  const tableName = lowerFirst(plural(agg.name));
  // Bulk-load every containment (collections + singulars) into per-
  // parent maps; mirrors the array-return path of findQueryMethod.
  const eagerContains = agg.contains
    .map((c) => ({ c, part: agg.parts.find((p) => p.name === c.partName) }))
    .filter((x): x is { c: typeof x.c; part: EntityPartIR } => !!x.part);
  const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
  return lines(
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const rootRows = await this.db.select().from(schema.${tableName}).where(inArray(schema.${tableName}.id, ids));`,
    `    if (rootRows.length === 0) return [];`,
    needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
    ...eagerContains.flatMap(({ c, part }) => {
      const childTable = lowerFirst(plural(part.name));
      const head = `    const ${c.name}Rows = await this.db.select().from(schema.${childTable}).where(inArray(schema.${childTable}.parentId, rootIds));`;
      if (c.collection) {
        return [
          head,
          `    const ${c.name}ByParent = new Map<string, ${part.name}[]>();`,
          `    for (const r of ${c.name}Rows) {`,
          `      const list = ${c.name}ByParent.get(r.parentId) ?? [];`,
          `      list.push(${hydrateEntityExpr(part, "r", agg, ctx)});`,
          `      ${c.name}ByParent.set(r.parentId, list);`,
          `    }`,
        ];
      }
      return [
        head,
        `    const ${c.name}ByParent = new Map<string, ${part.name}>();`,
        `    for (const r of ${c.name}Rows) {`,
        `      if (${c.name}ByParent.has(r.parentId)) continue;`,
        `      ${c.name}ByParent.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
        `    }`,
      ];
    }),
    associationMapLines(agg, "this.db", "    "),
    `    return rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
    `  }`,
  );
}

function findByIdMethod(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  emitTrace = false,
): string {
  // Inner body of the `db.transaction(async (tx) => { … })` callback.
  // Built at 6-space indent so we can wrap it differently for --trace
  // (which needs an outer try/catch + tx_begin/commit/rollback logs)
  // without duplicating the body across both variants.
  const body = txCallbackBody(agg, ctx);
  return lines(
    `  async findById(id: Ids.${agg.name}Id): Promise<${agg.name} | null> {`,
    emitTrace
      ? [
          // Trace-on: wrap the existing call in try/catch + the three
          // tx_* logs.  Body re-indented +2 so it sits inside the new
          // wrapper.
          `    ${renderHonoStoreLogCall("txBegin", `aggregate: "${agg.name}", id: id as string`)}`,
          `    try {`,
          `      const result = await this.db.transaction(async (tx) => {`,
          ...body.map((l) => `  ${l}`),
          `      });`,
          `      ${renderHonoStoreLogCall("txCommit", `aggregate: "${agg.name}", id: id as string`)}`,
          `      return result;`,
          `    } catch (txErr) {`,
          `      ${renderHonoStoreLogCall("txRollback", `aggregate: "${agg.name}", id: id as string, error: txErr instanceof Error ? txErr.message : String(txErr)`)}`,
          `      throw txErr;`,
          `    }`,
        ]
      : [`    return await this.db.transaction(async (tx) => {`, ...body, `    });`],
    `  }`,
  );
}

/** Inner body of the save db.transaction callback at 6-space indent.
 *  Extracted so the trace-on variant can re-indent and wrap it with the
 *  outer try/catch + tx_* logs.  Also the seam where `child_synced`
 *  trace lines (--trace) are injected per child upsert. */
function saveTxBody(agg: EnrichedAggregateIR, ctx: BoundedContextIR, emitTrace: boolean): string[] {
  const tableName = lowerFirst(plural(agg.name));
  const containBlocks = agg.contains.flatMap((c): string[] => {
    if (!c.collection) return [];
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) return [];
    const childTable = lowerFirst(plural(part.name));
    const cap = upperFirst(c.name);
    return [
      "",
      `      const existing${cap} = await tx.select({ id: schema.${childTable}.id }).from(schema.${childTable}).where(eq(schema.${childTable}.parentId, aggregate.id));`,
      `      const existingIds${cap} = new Set(existing${cap}.map((r) => r.id));`,
      `      const currentIds${cap} = new Set(aggregate.${c.name}.map((e) => e.id as string));`,
      `      const toDelete${cap} = [...existingIds${cap}].filter((id) => !currentIds${cap}.has(id));`,
      `      if (toDelete${cap}.length > 0) {`,
      `        await tx.delete(schema.${childTable}).where(and(eq(schema.${childTable}.parentId, aggregate.id), inArray(schema.${childTable}.id, toDelete${cap})));`,
      `      }`,
      `      for (const child of aggregate.${c.name}) {`,
      `        const childRow = ${entityProjection(part, "child", ctx)};`,
      `        await tx.insert(schema.${childTable}).values(childRow).onConflictDoUpdate({ target: schema.${childTable}.id, set: childRow });`,
      // Classify against existingIds BEFORE the upsert tells us insert vs
      // update with no second DB round-trip; ordering matters for the
      // semantic (current existingIds reflects what was on disk, the
      // upsert is happening now).
      ...(emitTrace
        ? [
            `        const childAction = existingIds${cap}.has(child.id as string) ? "update" : "insert";`,
            `        ${renderHonoStoreLogCall("childSynced", `parent: "${agg.name}", part: "${part.name}", id: child.id as string, action: childAction`)}`,
          ]
        : []),
      `      }`,
    ];
  });
  // Diff-sync each reference collection's join table: delete pairs the
  // aggregate no longer holds, insert the new ones (idempotent via the
  // composite PK).  Set semantics — the wire contract for `Id<T>[]`
  // doesn't promise order — but we still write the ordinal column from
  // the field's index so it's something deterministic per backend.
  const assocBlocks = associationsOf(agg).flatMap((assoc) => {
    const joinConst = joinTableConstName(assoc);
    const ownerCol = joinColumnName(assoc.ownerFk);
    const targetCol = joinColumnName(assoc.targetFk);
    const cap = upperFirst(assoc.fieldName);
    return [
      "",
      `      const existing${cap} = await tx.select({ t: schema.${joinConst}.${targetCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${ownerCol}, aggregate.id));`,
      `      const existingIds${cap} = new Set(existing${cap}.map((r) => r.t));`,
      `      const current${cap} = aggregate.${assoc.fieldName}.map((x) => x as string);`,
      `      const currentIds${cap} = new Set(current${cap});`,
      `      const toDelete${cap} = [...existingIds${cap}].filter((t) => !currentIds${cap}.has(t));`,
      `      if (toDelete${cap}.length > 0) {`,
      `        await tx.delete(schema.${joinConst}).where(and(eq(schema.${joinConst}.${ownerCol}, aggregate.id), inArray(schema.${joinConst}.${targetCol}, toDelete${cap})));`,
      `      }`,
      `      for (let i = 0; i < current${cap}.length; i++) {`,
      `        const row = { ${ownerCol}: aggregate.id as string, ${targetCol}: current${cap}[i]!, ordinal: i };`,
      `        await tx.insert(schema.${joinConst}).values(row).onConflictDoUpdate({ target: [schema.${joinConst}.${ownerCol}, schema.${joinConst}.${targetCol}], set: { ordinal: i } });`,
      `      }`,
    ];
  });
  return [
    `      const rootRow = ${rootProjection(agg, "aggregate", ctx)};`,
    `      await tx.insert(schema.${tableName}).values(rootRow).onConflictDoUpdate({ target: schema.${tableName}.id, set: rootRow });`,
    ...containBlocks,
    ...assocBlocks,
  ];
}

/** Inner body of the findById db.transaction callback at 6-space indent.
 *  Extracted so the trace-on variant can re-indent and wrap it with the
 *  outer try/catch + tx_* logs. */
function txCallbackBody(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string[] {
  const tableName = lowerFirst(plural(agg.name));
  // Eager-load each `contains` child (collection or singular).
  const childLoads = agg.contains.flatMap((c): string[] => {
    const part = agg.parts.find((p) => p.name === c.partName);
    if (!part) return [];
    const childTable = lowerFirst(plural(part.name));
    if (c.collection) {
      return [
        `      const ${c.name}Rows = await tx.select().from(schema.${childTable}).where(eq(schema.${childTable}.parentId, id));`,
        `      const ${c.name} = ${c.name}Rows.map((r) => ${hydrateEntityExpr(part, "r", agg, ctx)});`,
      ];
    }
    return [
      `      const ${c.name}Rows = await tx.select().from(schema.${childTable}).where(eq(schema.${childTable}.parentId, id)).limit(1);`,
      `      const ${c.name} = ${c.name}Rows.length > 0 ? ${hydrateEntityExpr(part, `${c.name}Rows[0]!`, agg, ctx)} : null;`,
    ];
  });
  // Load reference collections (`T id[]`) from their join tables.
  const assocLoads = associationsOf(agg).flatMap((assoc) => {
    const joinConst = joinTableConstName(assoc);
    const ownerCol = joinColumnName(assoc.ownerFk);
    const targetCol = joinColumnName(assoc.targetFk);
    return [
      `      const ${assoc.fieldName}Rows = await tx.select({ t: schema.${joinConst}.${targetCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${ownerCol}, id)).orderBy(schema.${joinConst}.ordinal);`,
      `      const ${assoc.fieldName} = ${assoc.fieldName}Rows.map((r) => Ids.${assoc.targetAgg}Id(r.t));`,
    ];
  });
  return [
    `      const rootRows = await tx.select().from(schema.${tableName}).where(eq(schema.${tableName}.id, id));`,
    `      if (rootRows.length === 0) {`,
    `        ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: false`)}`,
    `        return null;`,
    `      }`,
    `      const root = rootRows[0]!;`,
    ...childLoads,
    ...assocLoads,
    // Hydrate root.  Bind to a local so the load-success log line can
    // fire BEFORE returning — keeping the debug record adjacent to the
    // row read.
    `      const loaded = ${hydrateRootExpr(agg, "root", ctx)};`,
    `      ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: true`)}`,
    `      return loaded;`,
  ];
}

function hydrateRootExpr(agg: EnrichedAggregateIR, rowVar: string, ctx: BoundedContextIR): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      // Loaded into a local const from the join table (see findByIdMethod).
      fields.push(`${f.name}`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    fields.push(`${c.name}`);
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

// Restore the co-located lineage so a fresh load (and any subsequent GET)
// surfaces it — without this the lineage would vanish after the request
// that wrote it.  The column is `$type`d ProvLineage, so no cast needed.
function provHydrateEntries(fields: FieldIR[], rowVar: string): string[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => `${f.name}_provenance: ${rowVar}.${f.name}_provenance ?? null`);
}

function hydrateEntityExpr(
  part: EntityPartIR,
  rowVar: string,
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${part.name}Id(${rowVar}.id)`);
  fields.push(`parentId: Ids.${agg.name}Id(${rowVar}.parentId)`);
  for (const f of part.fields) {
    fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
  }
  fields.push(...provHydrateEntries(part.fields, rowVar));
  return `${part.name}._create({ ${fields.join(", ")} })`;
}

function hydrateFieldExpr(f: FieldIR, rowVar: string, ctx: BoundedContextIR): string {
  return hydrateValueExpr(f.name, f.type, rowVar, ctx, f.optional);
}

function hydrateValueExpr(
  fieldName: string,
  t: TypeIR,
  rowVar: string,
  ctx: BoundedContextIR,
  optional: boolean,
): string {
  const colExpr = `${rowVar}.${fieldName}`;
  if (t.kind === "optional") {
    return `(${colExpr} == null ? null : ${hydrateValueExpr(fieldName, t.inner, rowVar, ctx, true)})`;
  }
  if (t.kind === "primitive") {
    // decimal hydrates lossy through JS `number` — money does NOT
    // (it would defeat the precision contract that justifies money's
    // existence).  Drizzle's `numeric()` column returns a string at
    // runtime, which `new Decimal(...)` consumes without precision
    // loss.
    if (t.name === "decimal") return `Number(${colExpr})`;
    if (t.name === "money") return `new Decimal(${colExpr})`;
    return colExpr;
  }
  if (t.kind === "id") {
    return `Ids.${t.targetName}Id(${colExpr})`;
  }
  if (t.kind === "enum") {
    return `${colExpr} as ${t.name}`;
  }
  if (t.kind === "valueobject") {
    const cols = valueObjectColumnNames(fieldName, t.name, ctx);
    const args = cols
      .map((c) => primitiveColumnRead(`${rowVar}.${c.columnName}`, c.type))
      .join(", ");
    if (optional) {
      return `(${rowVar}.${cols[0]!.columnName} == null ? null : new ${t.name}(${args}))`;
    }
    return `new ${t.name}(${args})`;
  }
  return colExpr;
}

function primitiveColumnRead(expr: string, t: TypeIR): string {
  if (t.kind === "primitive" && t.name === "decimal") return `Number(${expr})`;
  if (t.kind === "primitive" && t.name === "money") return `new Decimal(${expr})`;
  return expr;
}

// ---------------------------------------------------------------------------
// save — upsert root + diff-sync children + dispatch events
// ---------------------------------------------------------------------------

function saveMethod(agg: EnrichedAggregateIR, ctx: BoundedContextIR, emitTrace = false): string {
  // Inner body of the save transaction at 6-space indent.  Built into a
  // local array so the trace-on variant can wrap it with try/catch +
  // tx_* logs without duplicating the body.
  const body = saveTxBody(agg, ctx, emitTrace);
  return lines(
    `  async save(aggregate: ${agg.name}): Promise<void> {`,
    emitTrace
      ? [
          `    ${renderHonoStoreLogCall("txBegin", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
          `    try {`,
          `      await this.db.transaction(async (tx) => {`,
          ...body.map((l) => `  ${l}`),
          `      });`,
          `      ${renderHonoStoreLogCall("txCommit", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
          `    } catch (txErr) {`,
          `      ${renderHonoStoreLogCall("txRollback", `aggregate: "${agg.name}", id: aggregate.id as string, error: txErr instanceof Error ? txErr.message : String(txErr)`)}`,
          `      throw txErr;`,
          `    }`,
        ]
      : [`    await this.db.transaction(async (tx) => {`, ...body, `    });`],
    `    ${renderHonoStoreLogCall("repositorySave", `aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    "",
    `    for (const event of aggregate.pullEvents()) {`,
    // `(event as object).constructor.name` is the emitted DomainEvent
    // subclass name — reliable in TypeScript without depending on a
    // per-event `type` discriminator field.  The `as object` cast
    // handles the corner case where the aggregate declares no events:
    // pullEvents returns `DomainEvent[]` typed as `never[]`, so
    // `event.constructor` would fail tsc.  Field name is `event_type`
    // (not `event`) so it doesn't collide with the envelope's `event` key.
    `      ${renderHonoStoreLogCall("eventDispatched", `event_type: (event as object).constructor.name, aggregate: "${agg.name}", id: aggregate.id as string`)}`,
    `      await this.events.dispatch(event);`,
    `    }`,
    `  }`,
  );
}

function rootProjection(agg: EnrichedAggregateIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    // Reference collections live in join tables, not on the root row.
    ...agg.fields
      .filter((f) => !isRefCollection(f.type))
      .flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(agg.fields, varExpr),
  ]);
}

function entityProjection(part: EntityPartIR, varExpr: string, ctx: BoundedContextIR): string {
  return projectionObject(varExpr, [
    { fieldName: "id", expr: `${varExpr}.id as string` },
    { fieldName: "parentId", expr: `${varExpr}.parentId as string` },
    ...part.fields.flatMap((f) => projectFieldEntries(f, varExpr, ctx)),
    ...provColumnEntries(part.fields, varExpr),
  ]);
}

// Co-located provenance sidecar: the `<field>_provenance` column reads
// straight off the domain getter (typed `ProvLineage | null`), so save
// and the `$type`d jsonb column line up without a cast.
function provColumnEntries(
  fields: FieldIR[],
  varExpr: string,
): { fieldName: string; expr: string }[] {
  return fields
    .filter((f) => f.provenanced)
    .map((f) => ({ fieldName: `${f.name}_provenance`, expr: `${varExpr}.${f.name}_provenance` }));
}

function projectFieldEntries(
  f: FieldIR,
  varExpr: string,
  ctx: BoundedContextIR,
): { fieldName: string; expr: string }[] {
  return projectValueEntries(f.name, f.type, `${varExpr}.${f.name}`, ctx, f.optional);
}

function projectValueEntries(
  fieldName: string,
  t: TypeIR,
  valueExpr: string,
  ctx: BoundedContextIR,
  optional: boolean,
): { fieldName: string; expr: string }[] {
  if (t.kind === "optional") {
    return projectValueEntries(fieldName, t.inner, valueExpr, ctx, true);
  }
  if (t.kind === "primitive") {
    if (t.name === "decimal") {
      return [{ fieldName, expr: `String(${valueExpr})` }];
    }
    if (t.name === "money") {
      // Persist as a precise-decimal string — decimal.js's `.toString()`
      // returns the canonical form `numeric(19, 4)` accepts.
      return [{ fieldName, expr: `${valueExpr}.toString()` }];
    }
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "id") {
    return [{ fieldName, expr: `${valueExpr} as string` }];
  }
  if (t.kind === "enum") {
    return [{ fieldName, expr: valueExpr }];
  }
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return [{ fieldName, expr: valueExpr }];
    return vo.fields.flatMap((vf) => {
      const sub = `${valueExpr}.${vf.name}`;
      return projectValueEntries(`${fieldName}_${vf.name}`, vf.type, sub, ctx, optional);
    });
  }
  return [{ fieldName, expr: valueExpr }];
}

function projectionObject(
  _varExpr: string,
  entries: { fieldName: string; expr: string }[],
): string {
  return `{ ${entries.map((e) => `${e.fieldName}: ${e.expr}`).join(", ")} }`;
}

// ---------------------------------------------------------------------------
// Find queries — convention-based equality predicates
// ---------------------------------------------------------------------------

function findQueryMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const tableName = lowerFirst(plural(agg.name));
  // When the find's `where` references currentUser, the method gains a
  // trailing `currentUser: User` parameter that the closure-captured
  // Drizzle predicate reads from.  Hono routes / workflow handlers
  // thread the user from `c.get("currentUser")` into the call.
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsTypeForReturn(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  const whereClause = buildFindWhereClause(agg, find, tableName, ctx);

  if (find.returnType.kind === "array") {
    // Bulk-load every containment (collections + singulars).  Earlier
    // versions of this code only handled a SINGLE collection
    // containment per find — anything else was silently dropped, so a
    // `find ...(): Order[]` against an aggregate with `contains
    // shipping: Address` (singular) emitted code referencing an
    // undefined `shipping` variable.  Now we load each containment
    // into a per-parent Map and use a hydrate helper that reads from
    // those maps.
    const eagerContains = agg.contains
      .map((c) => ({ c, part: agg.parts.find((p) => p.name === c.partName) }))
      .filter((x): x is { c: typeof x.c; part: EntityPartIR } => !!x.part);
    const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
    return lines(
      `  async ${find.name}(${params}): Promise<${agg.name}[]> {`,
      `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause};`,
      `    if (rootRows.length === 0) {`,
      `      ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: 0`)}`,
      `      return [];`,
      `    }`,
      needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
      ...eagerContains.flatMap(({ c, part }) => {
        const childTable = lowerFirst(plural(part.name));
        const head = `    const ${c.name}Rows = await this.db.select().from(schema.${childTable}).where(inArray(schema.${childTable}.parentId, rootIds));`;
        if (c.collection) {
          return [
            head,
            `    const ${c.name}ByParent = new Map<string, ${part.name}[]>();`,
            `    for (const r of ${c.name}Rows) {`,
            `      const list = ${c.name}ByParent.get(r.parentId) ?? [];`,
            `      list.push(${hydrateEntityExpr(part, "r", agg, ctx)});`,
            `      ${c.name}ByParent.set(r.parentId, list);`,
            `    }`,
          ];
        }
        // Singular containment: at most one row per parent (DB doesn't
        // enforce that, but the aggregate boundary does).  First-row-
        // wins on duplicates.
        return [
          head,
          `    const ${c.name}ByParent = new Map<string, ${part.name}>();`,
          `    for (const r of ${c.name}Rows) {`,
          `      if (${c.name}ByParent.has(r.parentId)) continue;`,
          `      ${c.name}ByParent.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
          `    }`,
        ];
      }),
      associationMapLines(agg, "this.db", "    "),
      `    const result = rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
      `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: result.length`)}`,
      `    return result;`,
      `  }`,
    );
  }

  // Optional / single result variants
  const optional = find.returnType.kind === "optional";
  return lines(
    optional
      ? `  async ${find.name}(${params}): Promise<${agg.name} | null> {`
      : `  async ${find.name}(${params}): Promise<${agg.name}> {`,
    `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause}.limit(1);`,
    optional
      ? [
          `    if (rootRows.length === 0) {`,
          `      ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: 0`)}`,
          `      return null;`,
          `    }`,
        ]
      : // Throws → no `find_executed` log on this branch.  The thrown
        // AggregateNotFoundError is logged at the route's onError seam
        // (`not_found` warn) so we don't double-log the same fact.
        `    if (rootRows.length === 0) throw new AggregateNotFoundError("not found");`,
    `    const result = await this.findById(rootRows[0]!.id as Ids.${agg.name}Id) as ${agg.name}${optional ? " | null" : ""};`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: result == null ? 0 : 1`)}`,
    `    return result;`,
    `  }`,
  );
}

function buildFindWhereClause(
  agg: EnrichedAggregateIR,
  find: FindIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
): string {
  if (find.filter) {
    // The IR validator (Layer ②) rejects any `where` clause that can't
    // lower to Drizzle's queryable subset, so by the time we get here
    // lowering always succeeds.  See validateLoomModel +
    // firstNonQueryableNode in src/ir/validate.ts.
    const lowered = lowerToDrizzle(find.filter, tableName, ctx);
    if (!lowered) {
      throw new Error(
        `internal: where-clause for find '${find.name}' on '${agg.name}' ` +
          "could not lower to Drizzle, but the validator should have caught this. " +
          "Please file a bug.",
      );
    }
    return `.where(${lowered.expr})`;
  }
  // Drizzle's `eq<T>(left, right)` infers `T` from the column's TS type
  // (plain `string` for `text(...)` columns).  Branded id params
  // (`Ids.CustomerId = string & {…}`) are structurally assignable to
  // `string`, so no cast is needed.  An older version of this code
  // wrote `${p.name} as never` defensively; the cast hid type safety
  // (a column rename desyncing from a find name produced bad runtime
  // SQL with no compile error) and is gone now.
  const conditions: string[] = [];
  for (const p of find.params) {
    const matched = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matched) {
      conditions.push(`eq(schema.${tableName}.${matched.name}, ${p.name})`);
    }
  }
  if (conditions.length === 0) return "";
  return `.where(${conditions.length === 1 ? conditions[0] : `and(${conditions.join(", ")})`})`;
}

/** Variant of `hydrateRootExpr` where ALL containments
 * (collections + singulars) are pre-loaded into per-parent maps.
 * Used by the array-returning find path to fully hydrate every root
 * in one batched read.  Singular containments default to `null` if
 * the parent had no row in the bulk join. */
function hydrateRootForFindAllExpr(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      fields.push(`${f.name}: ${f.name}ByOwner.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    if (c.collection) {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${c.name}: ${c.name}ByParent.get(${rowVar}.id) ?? null`);
    }
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

function tsTypeForReturn(t: TypeIR): string {
  if (t.kind === "id") return `Ids.${t.targetName}Id`;
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "money":
        return "Decimal";
      case "string":
      case "guid":
        return "string";
      case "bool":
        return "boolean";
      case "datetime":
        return "Date";
    }
  }
  if (t.kind === "enum") return t.name;
  if (t.kind === "array") return `${tsTypeForReturn(t.element)}[]`;
  if (t.kind === "optional") return `${tsTypeForReturn(t.inner)} | null`;
  return "unknown";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// IR expression → Drizzle expression
//
// Lowers the common subset of `where`-clause expressions to Drizzle
// operators (eq / ne / gt / gte / lt / lte / and / or / not), keyed
// off `schema.<table>.<column>` references.  Returns null when the
// expression contains shapes Drizzle can't represent in plain SQL
// (collection ops, lambdas, member access into parts, etc.); the
// caller then falls back to a TODO comment.
// ---------------------------------------------------------------------------

const COMPARE_OP_TO_DRIZZLE: Record<string, string> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

interface DrizzleLowering {
  /** The TypeScript source for the whole expression. */
  expr: string;
  /** Operators referenced; caller adds them to the file's import line. */
  ops: Set<string>;
}

function lowerToDrizzle(
  expr: import("../../ir/types/loom-ir.js").ExprIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
): DrizzleLowering | null {
  const ops = new Set<string>();
  const text = lowerExpr(expr);
  if (text === null) return null;
  return { expr: text, ops };

  function lowerExpr(e: import("../../ir/types/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return lowerExpr(e.inner);
    if (e.kind === "binary") {
      if (e.op === "&&" || e.op === "||") {
        const l = lowerExpr(e.left);
        const r = lowerExpr(e.right);
        if (l === null || r === null) return null;
        const fn = e.op === "&&" ? "and" : "or";
        ops.add(fn);
        return `${fn}(${l}, ${r})`;
      }
      const drizzleFn = COMPARE_OP_TO_DRIZZLE[e.op];
      if (!drizzleFn) return null;
      const colExpr = renderColumnRef(e.left) ?? renderColumnRef(e.right);
      const valueExpr =
        renderColumnRef(e.left) === null ? renderValue(e.left) : renderValue(e.right);
      if (colExpr === null || valueExpr === null) return null;
      ops.add(drizzleFn);
      return `${drizzleFn}(${colExpr}, ${valueExpr})`;
    }
    if (e.kind === "unary" && e.op === "!") {
      const inner = lowerExpr(e.operand);
      if (inner === null) return null;
      ops.add("not");
      return `not(${inner})`;
    }
    // `this.<refColl>.contains(x)` — membership over a reference
    // collection.  Lowers to a subquery over the field's join table:
    // the owner row is matched iff a (owner, target=x) pair exists.
    if (
      e.kind === "method-call" &&
      e.member === "contains" &&
      e.receiverType.kind === "array" &&
      e.receiverType.element.kind === "id" &&
      e.args.length === 1
    ) {
      const fieldName = refCollectionFieldName(e.receiver);
      const owner = ctx.aggregates.find((a) => lowerFirst(plural(a.name)) === tableName);
      const assoc = owner
        ? associationsOf(owner).find((x) => x.fieldName === fieldName)
        : undefined;
      const arg = renderValue(e.args[0]!);
      if (!assoc || arg === null) return null;
      const joinConst = joinTableConstName(assoc);
      const ownerCol = joinColumnName(assoc.ownerFk);
      const targetCol = joinColumnName(assoc.targetFk);
      ops.add("inArray");
      ops.add("eq");
      return `inArray(schema.${tableName}.id, this.db.select({ id: schema.${joinConst}.${ownerCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${targetCol}, ${arg})))`;
    }
    return null;
  }

  /** Field name behind a `this.<field>` receiver, or null. */
  function refCollectionFieldName(e: import("../../ir/types/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return refCollectionFieldName(e.inner);
    if (e.kind === "member" && e.receiver.kind === "this") return e.member;
    if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
    return null;
  }

  function renderColumnRef(e: import("../../ir/types/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return renderColumnRef(e.inner);
    // `this.field` — direct column access.  In the IR this is a
    // `member` over the `this` literal.
    if (e.kind === "member" && e.receiver.kind === "this") {
      return `schema.${tableName}.${e.member}`;
    }
    // `this.field.subField` (value-object member access).  Schema
    // flattens VO fields into `<field>_<subField>` columns.
    if (
      e.kind === "member" &&
      e.receiver.kind === "member" &&
      e.receiver.receiver.kind === "this"
    ) {
      return `schema.${tableName}.${e.receiver.member}_${e.member}`;
    }
    // Bare-identifier reference to a `this` property (the validator
    // resolves these to `this-prop`).
    if (e.kind === "ref" && e.refKind === "this-prop") {
      return `schema.${tableName}.${e.name}`;
    }
    return null;
  }

  function renderValue(e: import("../../ir/types/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return renderValue(e.inner);
    if (e.kind === "literal") {
      switch (e.lit) {
        case "string":
          return JSON.stringify(e.value);
        case "int":
        case "long":
        case "decimal":
          return e.value;
        case "money":
          // Drizzle's `numeric()` column accepts a string parameter
          // without precision loss — pass the literal's source value
          // directly, quoted.
          return JSON.stringify(e.value);
        case "bool":
          return e.value;
        case "null":
          return "null";
        default:
          return null;
      }
    }
    if (e.kind === "ref") {
      // Param / let / lambda: bare identifier.  Drizzle's `eq<T>` infers
      // `T` from the column on the left side; branded id types are
      // structurally assignable to the column's plain string/number
      // type, so a bare reference type-checks cleanly.  An older
      // version cast `${e.name} as never` defensively — that hid a
      // class of type errors (a where-clause referencing a renamed
      // column or a parameter with the wrong type compiled silently),
      // so the cast is gone.
      if (e.refKind === "param" || e.refKind === "let" || e.refKind === "lambda") {
        return e.name;
      }
      // Enum value: render as the literal string.  EF / Drizzle store
      // enums as text columns matching `OrderStatus.Draft` → "Draft".
      if (e.refKind === "enum-value") {
        return JSON.stringify(e.name);
      }
    }
    // `currentUser.<field>` — row-level filter.  The repo
    // method receives a `currentUser: User` parameter; the renderer
    // emits a plain JS member access against it.  Drizzle infers
    // the column-side branded type and the User field's plain type
    // is structurally assignable.
    if (e.kind === "member" && e.receiver.kind === "ref" && e.receiver.refKind === "current-user") {
      return `currentUser.${e.member}`;
    }
    void ctx;
    return null;
  }
}
