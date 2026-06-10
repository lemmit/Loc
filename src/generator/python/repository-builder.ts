import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead } from "../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../ir/stdlib/generics.js";
import type {
  AssociationIR,
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
  TypeIR,
  ViewIR,
} from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { plural, snake } from "../../util/naming.js";
import { lowerToSqlAlchemy, type PyPredicate } from "./find-predicate.js";
import {
  isRefCollectionField,
  isValueCollectionField,
  joinRowClassName,
  rowClassName,
} from "./py-columns.js";
import { renderPyType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Repository emission — `app/db/repositories/<snake(agg)>_repository.py`.
//
// Fixed shape (parity with the Hono/.NET repositories):
//   - `find_by_id(id)` loads root + every contained collection + every
//     reference-collection join table, hydrates the aggregate tree
//   - `get_by_id(id)` raises AggregateNotFoundError on missing
//   - `save(agg)` upserts the root row, diff-syncs each contained
//     collection (insert new / update existing / delete removed) AND
//     each reference-collection join table (ordinal-carrying), drains
//     events through the dispatcher, commits
//   - `all()` loads + hydrates every root
//   - `delete(id)` — only when the aggregate declares a canonical destroy
//   - `to_wire(root)` — domain → wire dict projection from
//     `agg.wireShape` (the canonical ordered field list)
//
// User-declared finds (`find byX(...) where …`) land in S8.
// ---------------------------------------------------------------------------

/** User-declared finds the v1 surface emits — the auto `all` is the
 *  dedicated method/route pair; paged + union returns land in S12. */
export function emittableFinds(repo: RepositoryIR | undefined): FindIR[] {
  return (repo?.finds ?? []).filter((f) => f.name !== "all" && f.returnType.kind !== "union");
}

export function buildPyRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const aggVar = "aggregate";
  const root = rowClassName(agg.name);
  const refColls = agg.fields.filter(isRefCollectionField);
  const assocs = agg.associations ?? [];
  // Pin the enriched element type — the AggregateIR ∩ Enriched
  // intersection's `.parts` otherwise infers the un-enriched element.
  const parts: EnrichedEntityPartIR[] = agg.parts;

  const body = lines(
    `class ${agg.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: ${agg.name}Id) -> ${agg.name} | None:`,
    `        row = await self._session.get(${root}, id)`,
    "        if row is None:",
    "            return None",
    "        return await self._hydrate(row)",
    "",
    `    async def get_by_id(self, id: ${agg.name}Id) -> ${agg.name}:`,
    "        found = await self.find_by_id(id)",
    "        if found is None:",
    `            raise AggregateNotFoundError(f"${agg.name} {id} not found")`,
    "        return found",
    "",
    `    async def all(self) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${root}))).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    ...emittableFinds(repo).flatMap((f) => ["", findMethod(agg, f, ctx)]),
    "",
    `    async def find_many_by_ids(self, ids: list[${agg.name}Id]) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${root}).where(${root}.id.in_(list(ids))))).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    ...aggregateViews(agg, ctx).flatMap((v) => ["", viewFindMethod(agg, v, ctx)]),
    ...aggregateRetrievals(agg, ctx).flatMap((r) => ["", runMethod(agg, r, ctx)]),
    "",
    saveMethod(agg, ctx, aggVar),
    agg.canonicalDestroy ? ["", deleteMethod(agg)] : null,
    "",
    hydrateMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partHydrateMethod(p, agg, ctx)]),
    "",
    toWireMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partWireMethod(p, ctx)]),
  );

  // Import narrowing via body scan (string literals stripped).
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const domainNames = [agg.name, ...agg.parts.map((p) => p.name)].filter(refersTo);
  const idNames = [
    ...new Set(
      [
        `${agg.name}Id`,
        ...agg.parts.map((p) => `${p.name}Id`),
        ...refColls.map((f) => `${refTarget(f)}Id`),
      ].filter(refersTo),
    ),
  ].sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const rowNames = [
    root,
    ...agg.parts.map((p) => rowClassName(p.name)),
    ...assocs.map(joinRowClassName),
  ]
    .filter(refersTo)
    .sort();
  const saNames = ["and_", "delete", "func", "not_", "or_", "select"].filter(refersTo);

  return lines(
    `"""${agg.name} repository.  Auto-generated."""`,
    "",
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("Decimal") ? "" : null,
    saNames.length > 0 ? `from sqlalchemy import ${saNames.join(", ")}` : null,
    refersTo("insert") ? "from sqlalchemy.dialects.postgresql import insert" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    refersTo("PagedResult") ? "from app.db.paging import PagedResult" : null,
    rowNames.length > 0 ? `from app.db.schema import ${rowNames.join(", ")}` : null,
    refersTo("iso") ? "from app.db.wire import iso" : null,
    "from app.domain.errors import AggregateNotFoundError",
    "from app.domain.events import DomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    domainNames.length > 0
      ? `from app.domain.${snake(agg.name)} import ${domainNames.join(", ")}`
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    "",
    body,
    "",
  );
}

function refTarget(f: FieldIR): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "array" && t.element.kind === "id") return t.element.targetName;
  return "";
}

// --- finds -------------------------------------------------------------------

/** One repository method per user-declared find.  A `where` clause
 *  lowers to a SQLAlchemy predicate; a clause-less find falls back to
 *  convention-matching its params to columns. */
function findMethod(agg: EnrichedAggregateIR, find: FindIR, ctx: EnrichedBoundedContextIR): string {
  const root = rowClassName(agg.name);
  const params = find.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  const pred = find.filter
    ? lowerToSqlAlchemy(find.filter, agg, ctx)
    : conventionPredicate(agg, find);
  const where = pred ? `.where(${pred.expr})` : "";
  const isList = find.returnType.kind === "array";
  // Paged find (P3b): count + limit/offset against the same predicate,
  // returning the shared PagedResult carrier (1-based page).
  if (pagedReturn(find.returnType)) {
    const sig = ["self", ...params, "page: int", "page_size: int"].join(", ");
    return lines(
      `    async def ${snake(find.name)}(${sig}) -> PagedResult[${agg.name}]:`,
      "        offset = (page - 1) * page_size",
      `        total = (`,
      `            await self._session.execute(select(func.count()).select_from(${root})${where})`,
      "        ).scalar_one()",
      "        total_pages = (total + page_size - 1) // page_size if page_size > 0 else 0",
      `        rows = (`,
      `            await self._session.execute(select(${root})${where}.limit(page_size).offset(offset))`,
      "        ).scalars().all()",
      "        items = [await self._hydrate(row) for row in rows]",
      "        return PagedResult(items=items, page=page, page_size=page_size, total=total, total_pages=total_pages)",
    );
  }
  const sig = ["self", ...params].join(", ");
  if (isList) {
    return lines(
      `    async def ${snake(find.name)}(${sig}) -> list[${agg.name}]:`,
      `        rows = (await self._session.execute(select(${root})${where})).scalars().all()`,
      "        return [await self._hydrate(row) for row in rows]",
    );
  }
  return lines(
    `    async def ${snake(find.name)}(${sig}) -> ${agg.name} | None:`,
    `        row = (await self._session.execute(select(${root})${where})).scalars().first()`,
    "        if row is None:",
    "            return None",
    "        return await self._hydrate(row)",
  );
}

/** Convention matching for clause-less finds: each param pairs with the
 *  column of the same name (or its `<field>Id` spelling). */
function conventionPredicate(agg: EnrichedAggregateIR, find: FindIR): PyPredicate | null {
  const root = rowClassName(agg.name);
  const clauses: string[] = [];
  for (const p of find.params) {
    const matched = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matched) clauses.push(`${root}.${snake(matched.name)} == ${snake(p.name)}`);
  }
  if (clauses.length === 0) return null;
  if (clauses.length === 1) return { expr: clauses[0]!, ops: new Set() };
  return { expr: `and_(${clauses.join(", ")})`, ops: new Set(["and_"]) };
}

// --- views + retrievals --------------------------------------------------------

/** Aggregate-sourced views over this aggregate (workflow views: S15). */
export function aggregateViews(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): ViewIR[] {
  return ctx.views.filter((v) => v.source.kind === "aggregate" && v.source.name === agg.name);
}

function aggregateRetrievals(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): RetrievalIR[] {
  return (ctx.retrievals ?? []).filter(
    (r) => r.targetType.kind === "entity" && r.targetType.name === agg.name,
  );
}

/** Per-view repository find — the lowered filter over the source
 *  aggregate (no filter → all).  The views router calls this. */
function viewFindMethod(
  agg: EnrichedAggregateIR,
  view: ViewIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const root = rowClassName(agg.name);
  const pred = view.filter ? lowerToSqlAlchemy(view.filter, agg, ctx) : null;
  const where = pred ? `.where(${pred.expr})` : "";
  return lines(
    `    async def ${snake(view.name)}(self) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${root})${where})).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
  );
}

/** Retrieval runner — `where` + `sort` + call-site offset/limit paging
 *  (retrieval.md: page is never part of the declaration).  The
 *  criterion is inlined (`where` carries the substituted predicate) —
 *  the IR contract explicitly supports non-reifying backends. */
function runMethod(
  agg: EnrichedAggregateIR,
  retrieval: RetrievalIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const root = rowClassName(agg.name);
  const pred = lowerToSqlAlchemy(retrieval.where, agg, ctx);
  if (!pred) {
    throw new Error(
      `internal: where-clause for retrieval '${retrieval.name}' on '${agg.name}' could not ` +
        "lower to SQLAlchemy, but validateRetrievals should have caught this.",
    );
  }
  const orderBy =
    retrieval.sort.length > 0
      ? `.order_by(${retrieval.sort
          .map((t) => `${root}.${snake(t.path[0]!.name)}.${t.direction}()`)
          .join(", ")})`
      : "";
  const params = [
    "self",
    ...retrieval.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`),
    "offset: int | None = None",
    "limit: int | None = None",
  ];
  return lines(
    `    async def run_${snake(retrieval.name)}(${params.join(", ")}) -> list[${agg.name}]:`,
    `        query = select(${root}).where(${pred.expr})${orderBy}`,
    "        if offset is not None:",
    "            query = query.offset(offset)",
    "        if limit is not None:",
    "            query = query.limit(limit)",
    "        rows = (await self._session.execute(query)).scalars().all()",
    "        return [await self._hydrate(row) for row in rows]",
  );
}

// --- hydration (row → domain) ----------------------------------------------

/** Row attribute → domain ctor kwarg conversion for one scalar column. */
function hydrateScalar(expr: string, t: TypeIR, optional: boolean): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = optional || t.kind === "optional";
  const wrap = (conv: string): string =>
    opt ? `(${conv} if ${expr} is not None else None)` : conv;
  if (inner.kind === "primitive" && inner.name === "decimal") return wrap(`float(${expr})`);
  if (inner.kind === "enum") return wrap(`${inner.name}(${expr})`);
  if (inner.kind === "id") return wrap(`${inner.targetName}Id(${expr})`);
  if (inner.kind === "array") {
    if (inner.element.kind === "enum") {
      return wrap(`[${inner.element.name}(__v) for __v in ${expr}]`);
    }
    if (inner.element.kind === "primitive" && inner.element.name === "decimal") {
      return wrap(`[float(__v) for __v in ${expr}]`);
    }
    return wrap(`list(${expr})`);
  }
  return expr;
}

/** Domain ctor kwarg for one declared field, reading flattened columns
 *  off `rowVar`.  Ref collections are passed in as pre-loaded locals. */
function hydrateField(rowVar: string, f: FieldIR, ctx: EnrichedBoundedContextIR): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  const opt = f.optional || f.type.kind === "optional";
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      const args = vo.fields
        .map((vf) => hydrateScalar(`${rowVar}.${snake(`${f.name}_${vf.name}`)}`, vf.type, false))
        .join(", ");
      const ctor = `${t.name}(${args})`;
      if (opt) {
        const probe = `${rowVar}.${snake(`${f.name}_${vo.fields[0]!.name}`)}`;
        return `(${ctor} if ${probe} is not None else None)`;
      }
      return ctor;
    }
  }
  return hydrateScalar(`${rowVar}.${snake(f.name)}`, f.type, f.optional);
}

function hydrateMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const root = rowClassName(agg.name);
  const out: string[] = [`    async def _hydrate(self, row: ${root}) -> ${agg.name}:`];
  // Load contained collections…
  for (const c of agg.contains) {
    const partRow = rowClassName(c.partName);
    const v = snake(c.name);
    out.push(
      `        ${v}_rows = (`,
      "            await self._session.execute(",
      `                select(${partRow}).where(${partRow}.parent_id == row.id)`,
      "            )",
      "        ).scalars().all()",
    );
  }
  // …and reference-collection join rows (ordinal-ordered).
  for (const f of agg.fields.filter(isRefCollectionField)) {
    const assoc = assocFor(agg, f.name);
    if (!assoc) continue;
    const joinRow = joinRowClassName(assoc);
    const v = snake(f.name);
    out.push(
      `        ${v}_rows = (`,
      "            await self._session.execute(",
      `                select(${joinRow})`,
      `                .where(${joinRow}.${assoc.ownerFk} == row.id)`,
      `                .order_by(${joinRow}.ordinal)`,
      "            )",
      "        ).scalars().all()",
    );
  }
  const kwargs: string[] = [`id=${agg.name}Id(row.id)`];
  for (const f of agg.fields) {
    if (isValueCollectionField(f)) continue; // deferred — see schema emitter
    if (isRefCollectionField(f)) {
      const assoc = assocFor(agg, f.name);
      if (!assoc) continue;
      kwargs.push(
        `${snake(f.name)}=[${assoc.targetAgg}Id(__r.${assoc.targetFk}) for __r in ${snake(f.name)}_rows]`,
      );
      continue;
    }
    kwargs.push(`${snake(f.name)}=${hydrateField("row", f, ctx)}`);
  }
  for (const c of agg.contains) {
    const v = snake(c.name);
    const hydrateOne = `self._hydrate_${snake(c.partName)}`;
    kwargs.push(
      c.collection
        ? `${v}=[${hydrateOne}(__r) for __r in ${v}_rows]`
        : `${v}=(${hydrateOne}(${v}_rows[0]) if ${v}_rows else None)`,
    );
  }
  out.push(`        return ${agg.name}._create(`);
  out.push(...kwargs.map((k) => `            ${k},`));
  out.push("        )");
  return out.join("\n");
}

function partHydrateMethod(
  p: EnrichedEntityPartIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const partRow = rowClassName(p.name);
  const kwargs = [
    `id=${p.name}Id(row.id)`,
    `parent_id=${agg.name}Id(row.parent_id)`,
    ...p.fields
      .filter((f) => !isRefCollectionField(f) && !isValueCollectionField(f))
      .map((f) => `${snake(f.name)}=${hydrateField("row", f, ctx)}`),
    ...p.contains.map((c) => `${snake(c.name)}=${c.collection ? "[]" : "None"}`),
  ];
  return lines(
    `    def _hydrate_${snake(p.name)}(self, row: ${partRow}) -> ${p.name}:`,
    `        return ${p.name}._create(`,
    kwargs.map((k) => `            ${k},`),
    "        )",
  );
}

// --- persistence (domain → row) ---------------------------------------------

function persistScalar(expr: string, t: TypeIR, optional: boolean): string {
  const inner = t.kind === "optional" ? t.inner : t;
  const opt = optional || t.kind === "optional";
  const wrap = (conv: string): string =>
    opt ? `(${conv} if ${expr} is not None else None)` : conv;
  // asyncpg binds NUMERIC parameters as Decimal — coerce the float-typed
  // `decimal` domain values through a str round-trip (no float artifacts).
  if (inner.kind === "primitive" && inner.name === "decimal") {
    return wrap(`Decimal(str(${expr}))`);
  }
  if (inner.kind === "array") {
    if (inner.element.kind === "primitive" && inner.element.name === "decimal") {
      return wrap(`[Decimal(str(__v)) for __v in ${expr}]`);
    }
    return wrap(`list(${expr})`);
  }
  return expr;
}

/** `(sql column attr, value expr)` pairs for one declared field. */
function persistField(
  ownerExpr: string,
  f: FieldIR,
  ctx: EnrichedBoundedContextIR,
): Array<[string, string]> {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  const opt = f.optional || f.type.kind === "optional";
  const access = `${ownerExpr}.${snake(f.name)}`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (vo) {
      return vo.fields.map((vf) => {
        const sub = persistScalar(`${access}.${snake(vf.name)}`, vf.type, false);
        const value = opt ? `(${sub} if ${access} is not None else None)` : sub;
        return [snake(`${f.name}_${vf.name}`), value];
      });
    }
  }
  return [[snake(f.name), persistScalar(access, f.type, f.optional)]];
}

function assocFor(agg: EnrichedAggregateIR, fieldName: string): AssociationIR | undefined {
  return (agg.associations ?? []).find((a) => a.fieldName === fieldName);
}

function saveMethod(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  aggVar: string,
): string {
  const root = rowClassName(agg.name);
  const out: string[] = [`    async def save(self, ${aggVar}: ${agg.name}) -> None:`];
  const rootPairs: Array<[string, string]> = [["id", `${aggVar}.id`]];
  for (const f of agg.fields) {
    if (isRefCollectionField(f) || isValueCollectionField(f)) continue;
    rootPairs.push(...persistField(aggVar, f, ctx));
  }
  out.push("        root = {");
  out.push(...rootPairs.map(([k, v]) => `            "${k}": ${v},`));
  out.push("        }");
  out.push("        await self._session.execute(");
  out.push(
    `            insert(${root}).values(**root).on_conflict_do_update(index_elements=["id"], set_=root)`,
  );
  out.push("        )");

  // Diff-sync each contained collection.
  for (const c of agg.contains) {
    out.push(...syncContainment(agg, c, ctx, aggVar));
  }
  // Diff-sync each reference-collection join table.
  for (const f of agg.fields.filter(isRefCollectionField)) {
    const assoc = assocFor(agg, f.name);
    if (assoc) out.push(...syncJoinTable(assoc, f, aggVar));
  }
  out.push("        for event in aggregate.pull_events():");
  out.push("            await self._events.dispatch(event)");
  out.push("        await self._session.commit()");
  return out.join("\n");
}

function syncContainment(
  agg: EnrichedAggregateIR,
  c: ContainmentIR,
  ctx: EnrichedBoundedContextIR,
  aggVar: string,
): string[] {
  const partRow = rowClassName(c.partName);
  const part = agg.parts.find((p) => p.name === c.partName);
  const v = snake(c.name);
  const childPairs: Array<[string, string]> = [
    ["id", "child.id"],
    [`${snake(agg.name)}_id`, "child.parent_id"],
  ];
  for (const f of part?.fields ?? []) {
    if (isRefCollectionField(f) || isValueCollectionField(f)) continue;
    childPairs.push(...persistField("child", f, ctx));
  }
  const children = c.collection ? `${aggVar}.${v}` : `__${v}_items`;
  const out: string[] = [];
  if (!c.collection) {
    out.push(`        __${v}_items = [${aggVar}.${v}] if ${aggVar}.${v} is not None else []`);
  }
  out.push(
    `        ${v}_existing = (`,
    "            await self._session.execute(",
    `                select(${partRow}.id).where(${partRow}.parent_id == ${aggVar}.id)`,
    "            )",
    "        ).scalars().all()",
    `        ${v}_current = {child.id for child in ${children}}`,
    `        ${v}_stale = [__id for __id in ${v}_existing if __id not in ${v}_current]`,
    `        if ${v}_stale:`,
    "            await self._session.execute(",
    `                delete(${partRow}).where(${partRow}.id.in_(${v}_stale))`,
    "            )",
    `        for child in ${children}:`,
    "            child_row = {",
    ...childPairs.map(([k, val]) => `                "${k}": ${val},`),
    "            }",
    "            await self._session.execute(",
    `                insert(${partRow}).values(**child_row).on_conflict_do_update(index_elements=["id"], set_=child_row)`,
    "            )",
  );
  return out;
}

function syncJoinTable(assoc: AssociationIR, f: FieldIR, aggVar: string): string[] {
  const joinRow = joinRowClassName(assoc);
  const v = snake(f.name);
  return [
    `        ${v}_current = [str(__t) for __t in ${aggVar}.${v}]`,
    `        ${v}_existing = (`,
    "            await self._session.execute(",
    `                select(${joinRow}.${assoc.targetFk}).where(${joinRow}.${assoc.ownerFk} == ${aggVar}.id)`,
    "            )",
    "        ).scalars().all()",
    `        ${v}_stale = [__t for __t in ${v}_existing if __t not in ${v}_current]`,
    `        if ${v}_stale:`,
    "            await self._session.execute(",
    `                delete(${joinRow}).where(`,
    `                    ${joinRow}.${assoc.ownerFk} == ${aggVar}.id, ${joinRow}.${assoc.targetFk}.in_(${v}_stale)`,
    "                )",
    "            )",
    `        for __i, __t in enumerate(${v}_current):`,
    `            pair = {"${assoc.ownerFk}": ${aggVar}.id, "${assoc.targetFk}": __t, "ordinal": __i}`,
    "            await self._session.execute(",
    `                insert(${joinRow}).values(**pair).on_conflict_do_update(`,
    `                    index_elements=["${assoc.ownerFk}", "${assoc.targetFk}"], set_={"ordinal": __i}`,
    "                )",
    "            )",
  ];
}

function deleteMethod(agg: EnrichedAggregateIR): string {
  const out: string[] = [`    async def delete(self, id: ${agg.name}Id) -> None:`];
  for (const c of agg.contains) {
    const partRow = rowClassName(c.partName);
    out.push(
      `        await self._session.execute(delete(${partRow}).where(${partRow}.parent_id == id))`,
    );
  }
  for (const assoc of agg.associations ?? []) {
    const joinRow = joinRowClassName(assoc);
    out.push(
      `        await self._session.execute(delete(${joinRow}).where(${joinRow}.${assoc.ownerFk} == id))`,
    );
  }
  const root = rowClassName(agg.name);
  out.push(`        await self._session.execute(delete(${root}).where(${root}.id == id))`);
  out.push("        await self._session.commit()");
  return out.join("\n");
}

// --- wire projection ----------------------------------------------------------

function wireValue(
  expr: string,
  t: TypeIR,
  ctx: EnrichedBoundedContextIR,
  optional: boolean,
): string {
  if (t.kind === "optional") {
    return `(None if ${expr} is None else ${wireValue(expr, t.inner, ctx, false)})`;
  }
  if (t.kind === "primitive" && t.name === "datetime") {
    return optional ? `(None if ${expr} is None else iso(${expr}))` : `iso(${expr})`;
  }
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return expr;
    const fields = vo.fields
      .map((vf) => `"${vf.name}": ${wireValue(`${expr}.${snake(vf.name)}`, vf.type, ctx, false)}`)
      .join(", ");
    const obj = `{${fields}}`;
    return optional ? `(None if ${expr} is None else ${obj})` : obj;
  }
  if (t.kind === "array") {
    const inner = wireValue("__e", t.element, ctx, false);
    const comp = inner === "__e" ? `list(${expr})` : `[${inner} for __e in ${expr}]`;
    return optional ? `(None if ${expr} is None else ${comp})` : comp;
  }
  if (optional && t.kind === "primitive") {
    return expr;
  }
  return expr;
}

function wireProjection(
  ent: EnrichedAggregateIR | EnrichedEntityPartIR,
  varExpr: string,
  ctx: EnrichedBoundedContextIR,
): string[] {
  const fields = forApiRead(wireShapeFor(ent));
  const pairs: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      pairs.push(`"id": ${varExpr}.id`);
      continue;
    }
    if (wf.source === "containment") {
      const partName =
        wf.type.kind === "array" && wf.type.element.kind === "entity"
          ? wf.type.element.name
          : wf.type.kind === "entity"
            ? wf.type.name
            : "";
      if (!partName) continue;
      const helper = `self._wire_${snake(partName)}`;
      const access = `${varExpr}.${snake(wf.name)}`;
      pairs.push(
        wf.type.kind === "array"
          ? `"${wf.name}": [${helper}(__e) for __e in ${access}]`
          : `"${wf.name}": (None if ${access} is None else ${helper}(${access}))`,
      );
      continue;
    }
    pairs.push(
      `"${wf.name}": ${wireValue(`${varExpr}.${snake(wf.name)}`, wf.type, ctx, wf.optional)}`,
    );
  }
  return pairs;
}

function toWireMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  return lines(
    `    def to_wire(self, root: ${agg.name}) -> dict[str, object]:`,
    "        return {",
    wireProjection(agg, "root", ctx).map((p) => `            ${p},`),
    "        }",
  );
}

function partWireMethod(p: EnrichedEntityPartIR, ctx: EnrichedBoundedContextIR): string {
  return lines(
    `    def _wire_${snake(p.name)}(self, e: ${p.name}) -> dict[str, object]:`,
    "        return {",
    wireProjection(p, "e", ctx).map((pair) => `            ${pair},`),
    "        }",
  );
}
