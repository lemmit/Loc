// Repository find builder — read-side methods (findById / findManyByIds /
// findQueryMethod / runMethod) plus their structural helpers (TPH-aware
// table/kind scoping, containment bulk-loads, where-clause assembly).
//
// Cleanly separated from save: per the dependency audit, the hydrate
// family is only ever called from find paths, and projectXxx is only ever
// called from save paths.  This file owns the find half; the two leaves it
// builds on live alongside it:
//
//   - repository-find-hydrate.ts   — row → domain `_rehydrate(...)`
//   - repository-find-predicate.ts — `where` → Drizzle + capability filters
//
// Those leaves' externally-consumed symbols are re-exported below so this
// module stays the single import surface the sibling repository builders
// already reference.

import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  BoundedContextIR,
  ContainmentIR,
  CriterionIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EntityPartIR,
  FindIR,
  RetrievalIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, findUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { discriminatorValue, tableOwnerName } from "../../ir/util/inheritance.js";
import { valueCollectionsFor } from "../../ir/util/value-collections.js";
import { indent, lines } from "../../util/code-builder.js";
import { lowerFirst, plural, upperFirst } from "../../util/naming.js";
import { renderHonoStoreLogCall } from "../_obs/render-hono.js";
import { joinColumnName, joinTableConstName } from "./emit.js";
import { associationMapLines, associationsOf } from "./repository-associations-builder.js";
import {
  hydrateEntityExpr,
  hydrateRootExpr,
  hydrateRootForFindAllExpr,
  valueCollectionElementExpr,
} from "./repository-find-hydrate.js";
import {
  combinePredicate,
  contextFilterPredicate,
  criterionFnName,
  type FilterBypass,
  lowerToDrizzle,
  reifiableCriterion,
  renderCriterionArg,
} from "./repository-find-predicate.js";

/** The capability-filter predicate to AND into one read.  When the read
 *  carries an `ignoring` clause (`bypassAll` / `bypassCaps`), recompute the
 *  conjunction with the named capability origins dropped — otherwise reuse the
 *  repo-wide `filterPred` the caller already lowered.  The dropped predicate's
 *  Drizzle ops are a subset of the always-collected superset, so a throwaway
 *  ops set is fine here (the import narrower keys off the emitted body). */
function readFilterPred(
  agg: EnrichedAggregateIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
  filterPred: string | null,
  bypass: FilterBypass | undefined,
): string | null {
  if (!bypass || (!bypass.bypassAll && (bypass.bypassCaps ?? []).length === 0)) return filterPred;
  return contextFilterPredicate(agg, tableName, ctx, new Set<string>(), bypass);
}

// Re-export the leaf modules' externally-consumed surface so the sibling
// repository builders (and the queryable-subset-parity test) keep importing
// from "./repository-find-builder.js" unchanged.
export { hydrateConcreteFromSharedRow, hydrateRootExpr } from "./repository-find-hydrate.js";
export {
  contextFilterPredicate,
  lowerToDrizzle,
  nonPrincipalContextFilterEntries,
  nonPrincipalContextFilters,
} from "./repository-find-predicate.js";

/** The Drizzle table const a repository reads from for `agg` — the shared
 *  TPH base table for a TPH concrete, otherwise the aggregate's own table. */
export function repoTableName(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string {
  return lowerFirst(plural(tableOwnerName(agg, ctx.aggregates)));
}

// ---------------------------------------------------------------------------
// Reified criteria (Hono).  A `retrieval`/`find` whose `where` is exactly a
// named criterion consumes a module-level predicate function — the functional
// analog of .NET's `Criterion<T>`.  Provenance is `criterionRef` (set by
// lowering); the function body is the criterion's own predicate lowered to
// Drizzle.  Behaviour-identical to the inline form (so conformance parity
// holds) — composition is just function calls.
// ---------------------------------------------------------------------------

// criterionFnName / reifiableCriterion / renderCriterionArg moved to
// repository-find-predicate.ts (the lower layer — the capability-filter
// predicate builder reifies through them too); re-exported here so the
// existing import sites (repository-builder.ts) keep working.
export { criterionFnName, reifiableCriterion, renderCriterionArg };

/** `const <name>Criterion = (params) => <drizzle predicate>;` — the criterion's
 *  own body (its parameters in scope), lowered against the candidate table.
 *
 *  The fn is module-level, so a `currentUser.<field>` reference (a tenancy
 *  criterion used by a find/retrieval) has no `currentUser` in scope — binding
 *  it to the bare name emits an unbound reference that fails `tsc`. Resolve it
 *  through the ambient `requireCurrentUser()` accessor instead — the same one
 *  the capability-`filter` query-face uses — so the backend has one principal
 *  source and the fn compiles (the Drizzle analogue of the .NET reified spec
 *  reading `RequestContext.Current!.CurrentUser!`). */
export function renderCriterionFn(
  c: CriterionIR,
  tableName: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const lowered = lowerToDrizzle(
    c.body,
    tableName,
    ctx,
    exprUsesCurrentUser(c.body) ? { principalAccessor: "requireCurrentUser()" } : undefined,
  )!;
  const params = c.params.map((p) => `${p.name}: ${tsTypeForReturn(p.type)}`).join(", ");
  return `const ${criterionFnName(c.name)} = (${params}) => ${lowered.expr};`;
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

/** Single-row read path (findById, inside the `tx` callback): load each
 *  value-object collection by the owner id, ordered, into a `const
 *  <field>` the root `_create` references by shorthand. */
function valueCollectionLoadLinesById(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string[] {
  return valueCollectionsFor(agg).flatMap((vc) => [
    `      const ${vc.fieldName}Rows = await tx.select().from(schema.${vc.tableConst}).where(eq(schema.${vc.tableConst}.parentId, id)).orderBy(schema.${vc.tableConst}.ordinal);`,
    `      const ${vc.fieldName} = ${vc.fieldName}Rows.map((r) => ${valueCollectionElementExpr(vc, "r", ctx)});`,
  ]);
}

/** Array read path (findManyByIds / find*): bulk-load each value-object
 *  collection across `rootIds` into a per-parent `Map`, ordered. */
function bulkLoadValueCollectionLines(agg: EnrichedAggregateIR, ctx: BoundedContextIR): string[] {
  return valueCollectionsFor(agg).flatMap((vc) => [
    `    const ${vc.fieldName}Rows = await this.db.select().from(schema.${vc.tableConst}).where(inArray(schema.${vc.tableConst}.parentId, rootIds)).orderBy(schema.${vc.tableConst}.ordinal);`,
    `    const ${vc.fieldName}ByParent = new Map<string, ${vc.voName}[]>();`,
    `    for (const r of ${vc.fieldName}Rows) {`,
    `      const list = ${vc.fieldName}ByParent.get(r.parentId) ?? [];`,
    `      list.push(${valueCollectionElementExpr(vc, "r", ctx)});`,
    `      ${vc.fieldName}ByParent.set(r.parentId, list);`,
    `    }`,
  ]);
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
  const needsIdsLocal =
    eagerContains.length > 0 ||
    associationsOf(agg).length > 0 ||
    valueCollectionsFor(agg).length > 0;
  return lines(
    `  async findManyByIds(ids: Ids.${agg.name}Id[]): Promise<${agg.name}[]> {`,
    `    if (ids.length === 0) return [];`,
    `    const rootRows = await this.db.select().from(schema.${tableName}).where(${rootWhere});`,
    `    if (rootRows.length === 0) return [];`,
    needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
    ...bulkLoadContainmentLines(eagerContains, agg, ctx),
    associationMapLines(agg, "this.db", "    "),
    ...bulkLoadValueCollectionLines(agg, ctx),
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
      `      const ${assoc.fieldName}Rows = await tx.select({ t: schema.${joinConst}.${targetCol} }).from(schema.${joinConst}).where(eq(schema.${joinConst}.${ownerCol}, id)).orderBy(schema.${joinConst}.${targetCol});`,
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
    ...valueCollectionLoadLinesById(agg, ctx),
    // Hydrate root.  Bind to a local so the load-success log line can
    // fire BEFORE returning — keeping the debug record adjacent to the
    // row read.
    `      const loaded = ${hydrateRootExpr(agg, "root", ctx)};`,
    `      ${renderHonoStoreLogCall("aggregateLoaded", `aggregate: "${agg.name}", id: id as string, found: true`)}`,
    `      return loaded;`,
  ];
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
  // An `ignoring <Cap>` / `ignoring *` on this find drops the named
  // capability filters from its `where` conjunction (other finds keep them).
  const readPred = readFilterPred(agg, tableName, ctx, filterPred, find);
  const whereClause = buildFindWhereClause(agg, find, tableName, ctx, readPred);

  // Paged return (`find x(): <Agg> paged`, P3b): the method gains trailing
  // `page` / `pageSize` controls, runs a count query + a `limit`/`offset`
  // page query, hydrates the page rows the same way the array branch does,
  // and returns the wrapped `{ items, page, pageSize, total, totalPages }`
  // shape.  1-based page; `items` are domain instances (the route maps them
  // through `toWire`).
  if (pagedReturn(find.returnType)) {
    const eagerContains = eagerContainsOf(agg);
    const needsIdsLocal =
      eagerContains.length > 0 ||
      associationsOf(agg).length > 0 ||
      valueCollectionsFor(agg).length > 0;
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
      ...bulkLoadValueCollectionLines(agg, ctx),
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
    const needsIdsLocal =
      eagerContains.length > 0 ||
      associationsOf(agg).length > 0 ||
      valueCollectionsFor(agg).length > 0;
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
      ...bulkLoadValueCollectionLines(agg, ctx),
      `    const result = rootRows.map((root) => ${hydrateRootForFindAllExpr(agg, "root", ctx)});`,
      `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: result.length`)}`,
      `    return result;`,
      `  }`,
    );
  }

  // Optional / single result variants.  A union find (`Agg or NotFound` /
  // `Agg option`, validator-pinned to the absence shape) is the optional
  // single-row select — the route maps `null` to the absent variant
  // (ProblemDetails / 404) and tags the found row on the wire.
  // Single-row hydrate from the row we already selected — mirrors the array /
  // paged branches (bulk-load children off `rootRows`, then
  // `hydrateRootForFindAllExpr`).  Earlier this re-fetched the SAME root via
  // `findById(rootRows[0].id)`, a redundant round-trip on every find-by-field
  // call; hydrating the row in hand drops that query (and closes the tiny race
  // window where the row could vanish between the two selects).
  const optional = find.returnType.kind === "optional" || find.returnType.kind === "union";
  const eagerContains = eagerContainsOf(agg);
  const needsIdsLocal =
    eagerContains.length > 0 ||
    associationsOf(agg).length > 0 ||
    valueCollectionsFor(agg).length > 0;
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
    needsIdsLocal && `    const rootIds = rootRows.map((r) => r.id);`,
    ...bulkLoadContainmentLines(eagerContains, agg, ctx),
    associationMapLines(agg, "this.db", "    "),
    ...bulkLoadValueCollectionLines(agg, ctx),
    `    const result = ${hydrateRootForFindAllExpr(agg, "rootRows[0]!", ctx)};`,
    `    ${renderHonoStoreLogCall("findExecuted", `aggregate: "${agg.name}", find: "${find.name}", rows: 1`)}`,
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
 *  (`validateRetrievals`) guarantees it lowers cleanly.
 *
 *  The retrieval's `loadPlan` is a deliberate no-op here, like on EF
 *  Core.  `eagerContainsOf` bulk-loads *every* owned containment and the
 *  hydrate folds them all into the returned aggregate — so `whole(T)` is
 *  satisfied, and an explicit `loads:` can't narrow them out: owned
 *  containments are part of the aggregate's `wireShape`, and the
 *  cross-backend parity invariant requires the same wire shape from every
 *  backend, so dropping a part here would diverge Hono from .NET/Phoenix.
 *  (Phoenix differs only because its relational containments are separate
 *  `has_many`s outside the Jason wire shape, so its `load:` affects
 *  in-process access, not the payload.)  Cross-aggregate eager-fetch
 *  (`self.lines[].product`) is the separate v2 hydration concern.  The
 *  regression guard in retrieval-emit.test.ts pins that whole and an
 *  explicit-`loads` retrieval emit the identical body. */
export function runMethod(
  agg: EnrichedAggregateIR,
  retrieval: RetrievalIR,
  ctx: EnrichedBoundedContextIR,
  filterPred: string | null = null,
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
  // When the `where` is exactly a named criterion, call its reified predicate
  // function instead of inlining (behaviour-identical; the function is emitted
  // module-level by repository-builder).
  const reified = reifiableCriterion(retrieval.criterionRef, ctx, tableName);
  const whereInner = reified
    ? `${criterionFnName(reified.name)}(${(retrieval.criterionRef?.args ?? [])
        .map(renderCriterionArg)
        .join(", ")})`
    : lowered.expr;
  // A capability `filter` is always-on for every root read — including
  // criterion retrievals.  AND it into the retrieval's own `where` exactly as
  // the find path does (buildFindWhereClause); retrievals carry no `ignoring`
  // bypass, so the full predicate applies.  Omitting it leaked soft-deleted /
  // other-tenant rows through `run<Name>` (silent gap).
  const whereClause = `.where(${combinePredicate(withKind(whereInner, kindPred), filterPred)})`;

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
  const needsIdsLocal =
    eagerContains.length > 0 ||
    associationsOf(agg).length > 0 ||
    valueCollectionsFor(agg).length > 0;
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
    ...bulkLoadValueCollectionLines(agg, ctx),
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
    // When the `where` is exactly a named criterion, call its reified predicate
    // function (emitted module-level by repository-builder) instead of inlining
    // — behaviour-identical, matching the retrieval path.
    const reified = reifiableCriterion(find.criterionRef, ctx, tableName);
    const whereInner = reified
      ? `${criterionFnName(reified.name)}(${(find.criterionRef?.args ?? [])
          .map(renderCriterionArg)
          .join(", ")})`
      : lowered.expr;
    return `.where(${combinePredicate(withKind(whereInner, kindPred), filterPred)})`;
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
