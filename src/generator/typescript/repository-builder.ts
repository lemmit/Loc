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
import {
  findByIdMethod,
  findManyByIdsMethod,
  findQueryMethod,
  lowerToDrizzle,
} from "./repository-find-builder.js";
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

// Restore the co-located lineage so a fresh load (and any subsequent GET)
// surfaces it — without this the lineage would vanish after the request
// that wrote it.  The column is `$type`d ProvLineage, so no cast needed.

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
