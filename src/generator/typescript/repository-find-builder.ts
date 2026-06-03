// Repository find builder — read-side methods (findById / findManyByIds /
// findQueryMethod) plus their helpers: the hydrate family (row → domain),
// the where-clause lowerer (lowerToDrizzle), and shared find utilities.
//
// Cleanly separated from save: per the dependency audit, hydrate* is
// only ever called from find paths, and projectXxx is only ever called
// from save paths.  This file owns the find half.

import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  BoundedContextIR,
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  EntityPartIR,
  ExprIR,
  FieldIR,
  FindIR,
  RetrievalIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, findUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import { indent, lines } from "../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { joinColumnName, joinTableConstName, valueObjectColumnNames } from "./emit.js";
import {
  associationMapLines,
  associationsOf,
  isRefCollection,
} from "./repository-associations-builder.js";
import { discriminatorValue, isTphConcrete, tableOwnerName } from "./tph.js";

/** The Drizzle table const a repository reads from for `agg` — the shared
 *  TPH base table for a TPH concrete, otherwise the aggregate's own table. */
function repoTableName(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string {
  return lowerFirst(plural(tableOwnerName(agg, ctx.aggregates)));
}

/** A `kind` discriminator predicate scoping reads to this concrete's rows in
 *  the shared TPH table, or null when `agg` is not a TPH concrete. */
function kindPredicate(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  tableName: string,
): string | null {
  const kind = discriminatorValue(agg, ctx.aggregates);
  return kind ? `eq(schema.${tableName}.kind, ${JSON.stringify(kind)})` : null;
}

/** Combine an id/param filter with the optional `kind` predicate. */
function withKind(filter: string, kindPred: string | null): string {
  return kindPred ? `and(${filter}, ${kindPred})` : filter;
}

/** `agg`'s `contains` children paired with their resolved entity part,
 *  dropping any containment whose part can't be found (defensive — the
 *  IR guarantees they exist).  Both array-returning read paths derive
 *  this set identically before bulk-loading. */
function eagerContainsOf(agg: EnrichedAggregateIR): { c: ContainmentIR; part: EntityPartIR }[] {
  return agg.contains
    .map((c) => ({ c, part: agg.parts.find((p) => p.name === c.partName) }))
    .filter((x): x is { c: ContainmentIR; part: EntityPartIR } => !!x.part);
}

/** Bulk-load every containment (collection + singular) into a per-parent
 *  `Map` keyed off the already-loaded `rootIds`, emitted at 4-space
 *  indent against `this.db`.  Shared verbatim by the two array-returning
 *  read paths (`findManyByIds` and the array-returning `find`); a
 *  collection accumulates into a `T[]` list, a singular is first-row-wins
 *  into a single `T`. */
function bulkLoadContainmentLines(
  eagerContains: { c: ContainmentIR; part: EntityPartIR }[],
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
): string[] {
  return eagerContains.flatMap(({ c, part }) => {
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
    // enforce that, but the aggregate boundary does).  First-row-wins
    // on duplicates.
    return [
      head,
      `    const ${c.name}ByParent = new Map<string, ${part.name}>();`,
      `    for (const r of ${c.name}Rows) {`,
      `      if (${c.name}ByParent.has(r.parentId)) continue;`,
      `      ${c.name}ByParent.set(r.parentId, ${hydrateEntityExpr(part, "r", agg, ctx)});`,
      `    }`,
    ];
  });
}

export function findManyByIdsMethod(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  filterPred: string | null = null,
): string {
  const tableName = repoTableName(agg, ctx);
  // Compose the capability filter onto the TPH-aware id/kind base.
  const rootWhere = combinePredicate(
    withKind(`inArray(schema.${tableName}.id, ids)`, kindPredicate(agg, ctx, tableName)),
    filterPred,
  );
  // Bulk-load every containment (collections + singulars) into per-
  // parent maps; mirrors the array-return path of findQueryMethod.
  const eagerContains = eagerContainsOf(agg);
  const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
  return lines(
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const rootRows = await this.db.select().from(schema.${tableName}).where(${rootWhere});`,
    `    if (rootRows.length === 0) return [];`,
    needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
    ...bulkLoadContainmentLines(eagerContains, agg, ctx),
    associationMapLines(agg, "this.db", "    "),
    `    return rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
    `  }`,
  );
}

export function findByIdMethod(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  emitTrace = false,
  filterPred: string | null = null,
): string {
  // Inner body of the `db.transaction(async (tx) => { … })` callback.
  // Built at 6-space indent so we can wrap it differently for --trace
  // (which needs an outer try/catch + tx_begin/commit/rollback logs)
  // without duplicating the body across both variants.
  const body = txCallbackBody(agg, ctx, filterPred);
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
          ...indent(2, body),
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

/** Inner body of the findById db.transaction callback at 6-space indent.
 *  Extracted so the trace-on variant can re-indent and wrap it with the
 *  outer try/catch + tx_* logs. */
function txCallbackBody(
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  filterPred: string | null = null,
): string[] {
  const tableName = repoTableName(agg, ctx);
  const rootWhere = combinePredicate(
    withKind(`eq(schema.${tableName}.id, id)`, kindPredicate(agg, ctx, tableName)),
    filterPred,
  );
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
    `      const rootRows = await tx.select().from(schema.${tableName}).where(${rootWhere});`,
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

export function hydrateRootExpr(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  // A TPH concrete reads from the shared table, where its own (non-base)
  // columns are nullable (only this `kind`'s rows populate them). The `kind`
  // filter on every read guarantees they're present, so assert non-null on
  // hydrate — otherwise `string | null` columns fail the domain `_create`
  // signature under strict tsc.
  const forceNonNull = isTphConcrete(agg, ctx.aggregates);
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      // Loaded into a local const from the join table (see findByIdMethod).
      fields.push(`${f.name}`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, forceNonNull)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    fields.push(`${c.name}`);
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

/** Hydrate a TPH concrete directly from a shared-table row — used by the
 *  polymorphic base reader (`PartyRepository`), which scans the shared table
 *  and dispatches on `kind`.  Reads scalar / value-object / enum / id columns
 *  with the non-null assertion (the row is known to be this concrete's
 *  `kind`).  Contained parts and `X id[]` reference collections aren't eagerly
 *  loaded by the base read (the per-concrete repository loads those fully) —
 *  they default to empty/null here so the `_create` stays strictly typed;
 *  v1 TPH concretes are expected to be flat (aggregate-inheritance.md). */
export function hydrateConcreteFromSharedRow(
  agg: EnrichedAggregateIR,
  rowVar: string,
  ctx: BoundedContextIR,
): string {
  const fields: string[] = [`id: Ids.${agg.name}Id(${rowVar}.id)`];
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      fields.push(`${f.name}: []`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, true)}`);
    }
  }
  fields.push(...provHydrateEntries(agg.fields, rowVar));
  for (const c of agg.contains) {
    fields.push(`${c.name}: ${c.collection ? "[]" : "null"}`);
  }
  return `${agg.name}._create({ ${fields.join(", ")} })`;
}

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

function hydrateFieldExpr(
  f: FieldIR,
  rowVar: string,
  ctx: BoundedContextIR,
  forceNonNull = false,
): string {
  return hydrateValueExpr(f.name, f.type, rowVar, ctx, f.optional, forceNonNull);
}

function hydrateValueExpr(
  fieldName: string,
  t: TypeIR,
  rowVar: string,
  ctx: BoundedContextIR,
  optional: boolean,
  forceNonNull = false,
): string {
  // For a TPH concrete's required column (nullable in the shared table, but
  // guaranteed present by the `kind` filter), assert non-null on read.
  // Optional fields keep their own `== null` guard, so no bang there.
  const bang = forceNonNull && !optional ? "!" : "";
  const colExpr = `${rowVar}.${fieldName}${bang}`;
  if (t.kind === "optional") {
    return `(${rowVar}.${fieldName} == null ? null : ${hydrateValueExpr(fieldName, t.inner, rowVar, ctx, true, forceNonNull)})`;
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
      .map((c) => primitiveColumnRead(`${rowVar}.${c.columnName}${bang}`, c.type))
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

export function findQueryMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
  filterPred: string | null = null,
): string {
  const tableName = repoTableName(agg, ctx);
  // When the find's `where` references currentUser, the method gains a
  // trailing `currentUser: User` parameter that the closure-captured
  // Drizzle predicate reads from.  Hono routes / workflow handlers
  // thread the user from `c.get("currentUser")` into the call.
  const usesUser = findUsesCurrentUser(find);
  const baseParams = find.params.map((p) => `${p.name}: ${tsTypeForReturn(p.type)}`);
  const params = (usesUser ? [...baseParams, "currentUser: User"] : baseParams).join(", ");
  const whereClause = buildFindWhereClause(agg, find, tableName, ctx, filterPred);

  // Paged return (`find x(): <Agg> paged`, P3b): the method gains trailing
  // `page` / `pageSize` controls, runs a count query + a `limit`/`offset`
  // page query, hydrates the page rows the same way the array branch does,
  // and returns the wrapped `{ items, page, pageSize, total, totalPages }`
  // shape.  1-based page; `items` are domain instances (the route maps them
  // through `toWire`).
  if (pagedReturn(find.returnType)) {
    const eagerContains = eagerContainsOf(agg);
    const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
    const pagedParams = [...baseParams, "page: number", "pageSize: number"];
    const pagedAll = (usesUser ? [...pagedParams, "currentUser: User"] : pagedParams).join(", ");
    const ret = `{ items: ${agg.name}[]; page: number; pageSize: number; total: number; totalPages: number }`;
    return lines(
      `  async ${find.name}(${pagedAll}): Promise<${ret}> {`,
      `    const offset = (page - 1) * pageSize;`,
      `    const countRows = await this.db.select({ value: count() }).from(schema.${tableName})${whereClause};`,
      `    const total = Number(countRows[0]?.value ?? 0);`,
      `    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;`,
      `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause}.limit(pageSize).offset(offset);`,
      `    if (rootRows.length === 0) {`,
      `      ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: 0`)}`,
      `      return { items: [], page, pageSize, total, totalPages };`,
      `    }`,
      needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
      ...bulkLoadContainmentLines(eagerContains, agg, ctx),
      associationMapLines(agg, "this.db", "    "),
      `    const items = rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
      `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: items.length`)}`,
      `    return { items, page, pageSize, total, totalPages };`,
      `  }`,
    );
  }

  if (find.returnType.kind === "array") {
    // Bulk-load every containment (collections + singulars).  Earlier
    // versions of this code only handled a SINGLE collection
    // containment per find — anything else was silently dropped, so a
    // `find ...(): Order[]` against an aggregate with `contains
    // shipping: Address` (singular) emitted code referencing an
    // undefined `shipping` variable.  Now we load each containment
    // into a per-parent Map and use a hydrate helper that reads from
    // those maps.
    const eagerContains = eagerContainsOf(agg);
    const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
    return lines(
      `  async ${find.name}(${params}): Promise<${agg.name}[]> {`,
      `    const rootRows = await this.db.select().from(schema.${tableName})${whereClause};`,
      `    if (rootRows.length === 0) {`,
      `      ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: 0`)}`,
      `      return [];`,
      `    }`,
      needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
      ...bulkLoadContainmentLines(eagerContains, agg, ctx),
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

/** Emit a `run<Name>(...)` repository method from a `RetrievalIR` — the
 *  named query bundle (retrieval.md).  Mirrors the array-returning
 *  `findQueryMethod` path (same bulk-load + hydrate), adding the
 *  retrieval's `sort` (→ `.orderBy(asc/desc(col))`) and a call-site
 *  `page` (→ `.limit().offset()`).  The `where` predicate lowers through
 *  the same `lowerToDrizzle` oracle a find filter does; the IR validator
 *  (`validateRetrievals`) guarantees it lowers cleanly.  Honours only the
 *  default-whole load plan in v1 (explicit `loads` deferred to PR6). */
export function runMethod(
  agg: EnrichedAggregateIR,
  retrieval: RetrievalIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const tableName = repoTableName(agg, ctx);
  const methodName = `run${upperFirst(retrieval.name)}`;
  // Retrieval params + an optional call-site page argument.  `page` is
  // never part of the declaration (retrieval.md) — it rides here.
  const baseParams = retrieval.params.map((p) => `${p.name}: ${tsTypeForReturn(p.type)}`);
  const params = [...baseParams, "page?: { offset?: number; limit?: number }"].join(", ");

  // `where` → Drizzle predicate, AND-ed with the TPH `kind` scope.
  const kindPred = kindPredicate(agg, ctx, tableName);
  const lowered = lowerToDrizzle(retrieval.where, tableName, ctx);
  if (!lowered) {
    throw new Error(
      `internal: where-clause for retrieval '${retrieval.name}' on '${agg.name}' ` +
        "could not lower to Drizzle, but validateRetrievals should have caught this. " +
        "Please file a bug.",
    );
  }
  const whereClause = `.where(${withKind(lowered.expr, kindPred)})`;

  // `sort` → `.orderBy(asc(col), desc(col), …)`.  Only the first path
  // segment is used in v1 (a direct column); nested / collection sort
  // paths are a v2 concern, already gated by validateRetrievals.
  const orderByClause =
    retrieval.sort.length > 0
      ? `.orderBy(${retrieval.sort
          .map((s) => `${s.direction}(schema.${tableName}.${s.path[0]!.name})`)
          .join(", ")})`
      : "";

  const eagerContains = eagerContainsOf(agg);
  const needsIdsLocal = eagerContains.length > 0 || associationsOf(agg).length > 0;
  return lines(
    `  async ${methodName}(${params}): Promise<${agg.name}[]> {`,
    // `page` is optional — apply limit / offset only when supplied.
    `    let query = this.db.select().from(schema.${tableName})${whereClause}${orderByClause}.$dynamic();`,
    `    if (page?.limit !== undefined) query = query.limit(page.limit);`,
    `    if (page?.offset !== undefined) query = query.offset(page.offset);`,
    `    const rootRows = await query;`,
    `    if (rootRows.length === 0) {`,
    `      ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${methodName}", rows: 0`)}`,
    `      return [];`,
    `    }`,
    needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
    ...bulkLoadContainmentLines(eagerContains, agg, ctx),
    associationMapLines(agg, "this.db", "    "),
    `    const result = rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${methodName}", rows: result.length`)}`,
    `    return result;`,
    `  }`,
  );
}

export function buildFindWhereClause(
  agg: EnrichedAggregateIR,
  find: FindIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
  filterPred: string | null = null,
): string {
  // Under TPH every read of this concrete is scoped to its `kind` rows in the
  // shared table (null for non-TPH aggregates → byte-identical output).
  const kindPred = kindPredicate(agg, ctx, tableName);
  if (find.filter) {
    // The IR validator (Layer ②) rejects any `where` clause that can't
    // lower to Drizzle's queryable subset, so by the time we get here
    // lowering always succeeds.  See validateLoomModel +
    // firstNonQueryableNode in src/ir/validate/validate.ts.
    const lowered = lowerToDrizzle(find.filter, tableName, ctx);
    if (!lowered) {
      throw new Error(
        `internal: where-clause for find '${find.name}' on '${agg.name}' ` +
          "could not lower to Drizzle, but the validator should have caught this. " +
          "Please file a bug.",
      );
    }
    return `.where(${combinePredicate(withKind(lowered.expr, kindPred), filterPred)})`;
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
  // TPH `kind` scope joins the convention-matched param conditions.
  if (kindPred) conditions.push(kindPred);
  if (conditions.length === 0) {
    // No find-level / kind predicate — but a capability filter still
    // applies to every root read, so emit it alone when present.
    return filterPred ? `.where(${filterPred})` : "";
  }
  const findPred = conditions.length === 1 ? conditions[0]! : `and(${conditions.join(", ")})`;
  return `.where(${combinePredicate(findPred, filterPred)})`;
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
  // See hydrateRootExpr: TPH concrete own columns are nullable in the shared
  // table but present for this `kind`, so assert non-null on read.
  const forceNonNull = isTphConcrete(agg, ctx.aggregates);
  const fields: string[] = [];
  fields.push(`id: Ids.${agg.name}Id(${rowVar}.id)`);
  for (const f of agg.fields) {
    if (isRefCollection(f.type)) {
      fields.push(`${f.name}: ${f.name}ByOwner.get(${rowVar}.id) ?? []`);
    } else {
      fields.push(`${f.name}: ${hydrateFieldExpr(f, rowVar, ctx, forceNonNull)}`);
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

export function lowerToDrizzle(
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
      // A bare boolean column under `!` — `!this.isDeleted` — has no
      // comparison to lower, so normalise it to `not(eq(col, true))`.
      // (The same column standing alone in a boolean position is handled
      // by the bare-boolean fallback at the end of this function.)
      const col = booleanColumnRef(e.operand);
      if (col) {
        ops.add("not");
        ops.add("eq");
        return `not(eq(${col}, true))`;
      }
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
    // Bare boolean column standing alone in a boolean position
    // (`filter this.isActive`) — lower to `eq(col, true)`.
    const boolCol = booleanColumnRef(e);
    if (boolCol) {
      ops.add("eq");
      return `eq(${boolCol}, true)`;
    }
    return null;
  }

  /** A `this.<field>` (or bare `this-prop` ref) whose type is the
   *  primitive `bool`, rendered as its schema column — else null.  Lets
   *  the lowerer treat a bare boolean column as `eq(col, true)` in a
   *  boolean position (`filter this.isActive` / `filter !this.isDeleted`).
   *  Non-boolean columns return null so a bare non-bool column in a
   *  boolean slot stays a (correctly rejected) non-queryable shape. */
  function booleanColumnRef(e: import("../../ir/types/loom-ir.js").ExprIR): string | null {
    if (e.kind === "paren") return booleanColumnRef(e.inner);
    const isBool = (t: TypeIR | undefined): boolean => t?.kind === "primitive" && t.name === "bool";
    if (e.kind === "member" && e.receiver.kind === "this" && isBool(e.memberType)) {
      return `schema.${tableName}.${e.member}`;
    }
    if (e.kind === "ref" && e.refKind === "this-prop" && isBool(e.type)) {
      return `schema.${tableName}.${e.name}`;
    }
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

// ---------------------------------------------------------------------------
// Capability filters (`filter <expr>` → AggregateIR.contextFilters).
//
// EF Core installs these once via `HasQueryFilter` and applies them to
// every query automatically.  Drizzle has no global query filter, so the
// generated repository must AND each predicate into every root-table read
// site (findById / findManyByIds / find* / view finds).  Principal-
// referencing filters (tenancy: `currentUser.tenantId`) are deferred —
// the IR validator (`validatePrincipalContextFilterSupport`) rejects them
// on Hono — so only non-principal predicates reach codegen here.
// ---------------------------------------------------------------------------

/** The non-principal capability-filter predicates for an aggregate, in
 *  declaration order.  Principal-referencing predicates are filtered out
 *  (the validator has already rejected them on Hono), so what remains
 *  always lowers to a closed Drizzle expression. */
export function nonPrincipalContextFilters(agg: EnrichedAggregateIR): ExprIR[] {
  return (agg.contextFilters ?? []).filter((p) => !exprUsesCurrentUser(p));
}

/** Lower an aggregate's capability filters to a single Drizzle predicate
 *  string (conjoined with `and(...)` when there is more than one), or
 *  null when the aggregate has none.  Adds the Drizzle ops it uses to
 *  `ops` so the import-narrowing in the repository builders pulls them
 *  in.  Returns null (rather than throwing) on a non-lowerable predicate
 *  — the validator guarantees selectability, so that path is unreachable
 *  for valid models. */
export function contextFilterPredicate(
  agg: EnrichedAggregateIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
  ops: Set<string>,
): string | null {
  const predicates = nonPrincipalContextFilters(agg);
  if (predicates.length === 0) return null;
  const lowered: string[] = [];
  for (const p of predicates) {
    const l = lowerToDrizzle(p, tableName, ctx);
    if (!l) return null;
    for (const op of l.ops) ops.add(op);
    lowered.push(l.expr);
  }
  if (lowered.length === 1) return lowered[0]!;
  ops.add("and");
  return `and(${lowered.join(", ")})`;
}

/** Combine a capability-filter predicate with an existing read predicate.
 *  `existing` is a raw Drizzle predicate expression (the argument that
 *  would go inside `.where(...)`), e.g. `eq(schema.docs.id, id)`.  When a
 *  capability filter is present both are wrapped in `and(...)`.  `and` is
 *  always in the repository's default Drizzle-op set, and the filter
 *  predicate's own ops were collected when it was lowered, so no ops set
 *  is threaded here — the import narrower keys off the emitted body. */
export function combinePredicate(existing: string, filterPred: string | null): string {
  if (!filterPred) return existing;
  return `and(${existing}, ${filterPred})`;
}
