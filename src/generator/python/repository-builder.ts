import { wireShapeFor } from "../../ir/enrich/enrichments.js";
import { forApiRead } from "../../ir/enrich/wire-projection.js";
import { pagedReturn } from "../../ir/stdlib/generics.js";
import {
  type AssociationIR,
  type ContainmentIR,
  type EnrichedAggregateIR,
  type EnrichedBoundedContextIR,
  type EnrichedEntityPartIR,
  type FieldIR,
  type FindIR,
  findUsesCurrentUser,
  type RepositoryIR,
  type RetrievalIR,
  type TypeIR,
  type ViewIR,
  type WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { aggHasAuditedTarget } from "../../ir/util/audit-capability.js";
import {
  baseOf,
  discriminatorValue,
  ownFieldsOf,
  tableOwnerName,
} from "../../ir/util/inheritance.js";
import { type ValueCollectionIR, valueCollectionsFor } from "../../ir/util/value-collections.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { provColumn, provenancedFieldsOf } from "./emit/provenance.js";
import {
  aggUsesPrincipalContextFilter,
  contextFilterPredicate,
  type FilterBypass,
  lowerToSqlAlchemy,
  type PyPredicate,
} from "./find-predicate.js";
import {
  columnsForFields,
  isRefCollectionField,
  isValueCollectionField,
  joinRowClassName,
  rowClassName,
  valueCollectionRowClassName,
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
  return (repo?.finds ?? []).filter((f) => f.name !== "all");
}

/** The `from app.auth.user import …` line for a repository module, or null when
 *  it references neither symbol.  `User` is needed for a per-find currentUser
 *  param; `require_current_user` is the ambient accessor a principal capability
 *  filter weaves into every root read (DEBT-02). */
function authUserImport(needsUser: boolean, needsAccessor: boolean): string | null {
  const names = [needsUser ? "User" : null, needsAccessor ? "require_current_user" : null]
    .filter((n): n is string => n != null)
    .sort();
  return names.length > 0 ? `from app.auth.user import ${names.join(", ")}` : null;
}

export function buildPyRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const aggVar = "aggregate";
  // TPH concretes share the base's table; everyone else owns theirs.
  const owner = tableOwnerName(agg, ctx.aggregates);
  const root = rowClassName(owner);
  const kind = discriminatorValue(agg, ctx.aggregates);
  const assocs = agg.associations ?? [];
  // The single AND-able capability-filter predicate for this aggregate
  // (null when it has no non-principal `filter`).  Conjoined into every
  // root-table read below via `rootWhere`; child/containment reads
  // (parent_id-keyed) are unaffected — the filter constrains root rows.
  // Principal-referencing filters are gated by the IR validator on python
  // (W1b), so only non-principal predicates reach here.
  const filterPred = contextFilterPredicate(agg, ctx);
  // Inline `Repo.findAll(<Criterion>) ignoring …` / `Repo.run(…) ignoring …`
  // call-sites lower to `run_<retrieval>(…)`; that method is SHARED across
  // sites, so its baked-in capability filter must OMIT the UNION of the caps
  // every inline site bypasses (named-filter-bypass.md §11.6 — the static
  // analogue of java's `inlineRunBypassesByRetrieval`).  Keyed by retrieval
  // name; empty when no inline read of this aggregate carries `ignoring`.
  const inlineRunBypasses = inlineRunBypassesByRetrieval(ctx, agg.name);
  // Pin the enriched element type — the AggregateIR ∩ Enriched
  // intersection's `.parts` otherwise infers the un-enriched element.
  const parts: EnrichedEntityPartIR[] = agg.parts;

  // `find_by_id` scopes by the id literal AND any kind / capability filter.
  // No filter: preserve the prior emission byte-for-byte — a kind concrete
  // uses comma-AND `.where(id, kind)`, a plain aggregate uses the cheap
  // primary-key `session.get`.  A capability filter forces a single
  // `rootWhere` so its predicate joins the id (and kind) scoping.
  const findByIdRead = filterPred
    ? `        row = (await self._session.execute(select(${root})${rootWhere(
        { expr: `${root}.id == id`, ops: new Set() },
        root,
        kind,
        filterPred,
      )})).scalars().first()`
    : kind
      ? `        row = (await self._session.execute(select(${root}).where(${root}.id == id, ${root}.kind == ${JSON.stringify(kind)}))).scalars().first()`
      : `        row = await self._session.get(${root}, id)`;

  const body = lines(
    `class ${agg.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: ${agg.name}Id) -> ${agg.name} | None:`,
    findByIdRead,
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
    `        rows = (await self._session.execute(select(${root})${rootWhere(null, root, kind, filterPred)})).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    ...emittableFinds(repo).flatMap((f) => ["", relationalFindMethod(agg, f, ctx, filterPred)]),
    "",
    `    async def find_many_by_ids(self, ids: list[${agg.name}Id]) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${root})${rootWhere(
      { expr: `${root}.id.in_(list(ids))`, ops: new Set() },
      root,
      undefined,
      filterPred,
    )})).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    ...aggregateViews(agg, ctx).flatMap((v) => ["", viewFindMethod(agg, v, ctx, filterPred)]),
    ...aggregateRetrievals(agg, ctx).flatMap((r) => [
      "",
      runMethod(agg, r, ctx, filterPred, inlineRunBypasses.get(r.name)),
    ]),
    "",
    saveMethod(agg, ctx, aggVar),
    agg.canonicalDestroy ? ["", deleteMethod(agg, ctx)] : null,
    "",
    hydrateMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partHydrateMethod(p, agg, ctx)]),
    "",
    toWireMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partWireMethod(p, ctx)]),
    aggHasAuditedTarget(agg) ? ["", recordAuditMethod()] : null,
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
        // Every id-typed field (own or part, singular or collection)
        // brands on hydrate — `order_ref=OrderId(row.order_ref)`.
        ...[agg, ...agg.parts].flatMap((holder) =>
          holder.fields
            .map(idFieldTarget)
            .filter((n): n is string => n != null)
            .map((n) => `${n}Id`),
        ),
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
    // Id-less value-collection child tables (own + part `<VO>[]` fields).
    ...[agg, ...agg.parts].flatMap((holder) =>
      valueCollectionsFor(holder).map((vc) => valueCollectionRowClassName(vc.childTable)),
    ),
  ]
    .filter(refersTo)
    .sort();
  const saNames = ["and_", "delete", "func", "not_", "or_", "select"].filter(refersTo);

  const hasProv = provenancedFieldsOf(agg).length > 0;
  const hasAudit = aggHasAuditedTarget(agg);
  // The obs.log RequestContext accessors are shared between provenance (which
  // also reads `actor_id`) and audit (correlation / scope / parent).  Union the
  // names so a single sorted import covers both without duplication.
  const obsAccessors = [
    ...new Set([
      ...(hasProv ? ["actor_id", "correlation_id", "parent_id", "scope_id"] : []),
      ...(hasAudit ? ["correlation_id", "parent_id", "scope_id"] : []),
    ]),
  ].sort();
  return lines(
    `"""${agg.name} repository.  Auto-generated."""`,
    "",
    hasProv || hasAudit ? "from datetime import UTC, datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    hasProv || hasAudit ? "from uuid import uuid4" : null,
    refersTo("Decimal") || hasProv || hasAudit ? "" : null,
    saNames.length > 0 ? `from sqlalchemy import ${saNames.join(", ")}` : null,
    refersTo("insert") ? "from sqlalchemy.dialects.postgresql import insert" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    // `User` rides in whenever a per-find `where` threads the principal as a
    // method param; `require_current_user` rides in when an always-on principal
    // capability filter weaves the ambient accessor into every root read
    // (DEBT-02).  One sorted import covers whichever (or both) apply.
    authUserImport(
      emittableFinds(repo).some(findUsesCurrentUser),
      aggUsesPrincipalContextFilter(agg),
    ),
    hasAudit ? "from app.db.audit import AuditRecordRow" : null,
    refersTo("PagedResult") ? "from app.db.paging import PagedResult" : null,
    hasProv ? "from app.db.provenance import ProvenanceRecord" : null,
    rowNames.length > 0 ? `from app.db.schema import ${rowNames.join(", ")}` : null,
    refersTo("iso") ? "from app.db.wire import iso" : null,
    "from app.domain.errors import AggregateNotFoundError",
    "from app.domain.events import DomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    domainNames.length > 0
      ? `from app.domain.${snake(agg.name)} import ${domainNames.join(", ")}`
      : null,
    hasProv ? "from app.domain.provenance import ProvLineage, drain" : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    obsAccessors.length > 0 ? `from app.obs.log import ${obsAccessors.join(", ")}` : null,
    "",
    "",
    body,
    "",
  );
}

/** Target aggregate of an id-typed field — `Order id`, `Order id?`,
 *  or `Order id[]` — else `null`. */
function idFieldTarget(f: FieldIR): string | null {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "id") return t.targetName;
  if (t.kind === "array" && t.element.kind === "id") return t.element.targetName;
  return null;
}

// --- finds -------------------------------------------------------------------

/** One repository method per user-declared find.  A `where` clause
 *  lowers to a SQLAlchemy predicate; a clause-less find falls back to
 *  convention-matching its params to columns. */
export function relationalFindMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  ctx: EnrichedBoundedContextIR,
  filterPred: PyPredicate | null = null,
): string {
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  const kind = discriminatorValue(agg, ctx.aggregates);
  const params = find.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  // currentUser-scoped finds take the actor as the trailing parameter;
  // the predicate renders `current_user.<claim>` as a plain bind value.
  if (findUsesCurrentUser(find)) params.push("current_user: User");
  const pred = find.filter
    ? lowerToSqlAlchemy(find.filter, agg, ctx)
    : conventionPredicate(agg, find);
  // Per-find capability filter — a `find … ignoring <Cap>`/`ignoring *` OMITS
  // the named capability predicate(s) for this method only (the bypass is
  // baked in statically; no runtime param).  A non-bypassing find keeps the
  // shared, all-caps predicate.
  const methodFilterPred =
    find.bypassAll || (find.bypassCaps?.length ?? 0) > 0
      ? contextFilterPredicate(agg, ctx, {
          bypassAll: find.bypassAll,
          bypassCaps: find.bypassCaps,
        })
      : filterPred;
  const where = rootWhere(pred, root, kind, methodFilterPred);
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

/** Conjoin the predicate terms that scope a root read: an optional find/view/
 *  retrieval predicate, the TPH `kind` discriminator, and the (non-principal)
 *  capability-`filter` predicate (W1a).  Returns the `.where(...)` suffix, or
 *  empty when no term applies.  When more than one term is present they're
 *  AND-ed via `and_(...)` (NOT double-wrapped — every term contributes one
 *  conjunct). */
function rootWhere(
  pred: PyPredicate | null,
  root: string,
  kind: string | undefined,
  filterPred: PyPredicate | null,
): string {
  const terms: string[] = [];
  if (pred) terms.push(pred.expr);
  if (kind) terms.push(`${root}.kind == ${JSON.stringify(kind)}`);
  if (filterPred) terms.push(filterPred.expr);
  if (terms.length === 0) return "";
  if (terms.length === 1) return `.where(${terms[0]})`;
  return `.where(and_(${terms.join(", ")}))`;
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

/** The UNION bypass spec per retrieval name, drawn from the inline
 *  `Repo.findAll(<Criterion>) ignoring …` / `Repo.run(<Retrieval>(…)) ignoring …`
 *  call-sites in `ctx`'s workflows that hit `aggName`.  A retrieval's
 *  `run_<name>` impl method is SHARED across call-sites, so its baked-in
 *  bypass must cover EVERY site: `bypassAll` if any site bypasses all, else the
 *  union of the named caps.  Empty map when no inline read of `aggName` carries
 *  an `ignoring` clause.  Mirrors java's `inlineRunBypassesByRetrieval`. */
function inlineRunBypassesByRetrieval(
  ctx: EnrichedBoundedContextIR,
  aggName: string,
): Map<string, FilterBypass> {
  const acc = new Map<string, { bypassAll: boolean; caps: Set<string> }>();
  const collect = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (
        s.kind === "repo-run" &&
        s.aggName === aggName &&
        (s.bypassAll || (s.bypassCaps?.length ?? 0) > 0)
      ) {
        const cur = acc.get(s.retrievalName) ?? { bypassAll: false, caps: new Set<string>() };
        if (s.bypassAll) cur.bypassAll = true;
        for (const c of s.bypassCaps ?? []) cur.caps.add(c);
        acc.set(s.retrievalName, cur);
      }
      if (s.kind === "for-each") collect(s.body);
      if (s.kind === "if-let") {
        collect(s.thenBody);
        collect(s.elseBody ?? []);
      }
    }
  };
  for (const wf of ctx.workflows) {
    for (const c of wf.creates) collect(c.statements);
    for (const h of wf.handlers ?? []) collect(h.statements);
    for (const on of wf.subscriptions ?? []) collect(on.statements);
  }
  const out = new Map<string, FilterBypass>();
  for (const [name, v] of acc) {
    out.set(name, v.bypassAll ? { bypassAll: true } : { bypassCaps: [...v.caps] });
  }
  return out;
}

/** Per-view repository find — the lowered filter over the source
 *  aggregate (no filter → all).  The views router calls this. */
function viewFindMethod(
  agg: EnrichedAggregateIR,
  view: ViewIR,
  ctx: EnrichedBoundedContextIR,
  filterPred: PyPredicate | null = null,
): string {
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  const kind = discriminatorValue(agg, ctx.aggregates);
  const pred = view.filter ? lowerToSqlAlchemy(view.filter, agg, ctx) : null;
  // A `view … ignoring <Cap>`/`ignoring *` OMITS the named capability
  // predicate(s) for this view read only (baked in statically).
  const methodFilterPred =
    view.bypassAll || (view.bypassCaps?.length ?? 0) > 0
      ? contextFilterPredicate(agg, ctx, {
          bypassAll: view.bypassAll,
          bypassCaps: view.bypassCaps,
        })
      : filterPred;
  const where = rootWhere(pred, root, kind, methodFilterPred);
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
  filterPred: PyPredicate | null = null,
  bypass?: FilterBypass,
): string {
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  const kind = discriminatorValue(agg, ctx.aggregates);
  // When an inline `ignoring` call-site reaches this retrieval, OMIT the
  // bypassed capability predicate(s) (the union across sites — baked in).
  const methodFilterPred = bypass ? contextFilterPredicate(agg, ctx, bypass) : filterPred;
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
    `        query = select(${root})${rootWhere(pred, root, kind, methodFilterPred)}${orderBy}`,
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
export function hydrateField(rowVar: string, f: FieldIR, ctx: EnrichedBoundedContextIR): string {
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

/** Reconstruct a value-object-collection list from its loaded child rows
 *  (`<field>_rows`).  Each row → the VO ctor over its flattened columns,
 *  read with the same `hydrateScalar` conversions as a single VO field; the
 *  ctor re-checks the VO invariant.  Elements are identity-less, so the list
 *  is rebuilt wholesale (ordinal order preserved by the SELECT's order_by). */
export function hydrateValueCollection(
  vc: ValueCollectionIR,
  rowVar: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const vo = ctx.valueObjects.find((v) => v.name === vc.voName);
  const args = (vo?.fields ?? [])
    .map((vf) => hydrateScalar(`${rowVar}.${snake(vf.name)}`, vf.type, false))
    .join(", ");
  return `[${vc.voName}(${args}) for ${rowVar} in ${snake(vc.fieldName)}_rows]`;
}

function hydrateMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  const out: string[] = [`    async def _hydrate(self, row: ${root}) -> ${agg.name}:`];
  // TPH concrete: its OWN columns are nullable on the shared table (only
  // rows of this kind populate them) — assert-narrow before hydration so
  // the non-optional domain fields type-check.
  if (discriminatorValue(agg, ctx.aggregates)) {
    const base = baseOf(agg, ctx.aggregates);
    const own = base ? ownFieldsOf(agg, base) : [];
    for (const f of own) {
      if (f.optional || f.type.kind === "optional") continue;
      if (isRefCollectionField(f) || isValueCollectionField(f)) continue;
      for (const col of columnsForFields([f], ctx)) {
        out.push(`        assert row.${col.attr} is not None`);
      }
    }
  }
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
  // …and value-object-collection child rows (ordinal-ordered → VO list).
  for (const vc of valueCollectionsFor(agg)) {
    const vcRow = valueCollectionRowClassName(vc.childTable);
    const v = snake(vc.fieldName);
    out.push(
      `        ${v}_rows = (`,
      "            await self._session.execute(",
      `                select(${vcRow})`,
      `                .where(${vcRow}.${vc.parentFk} == row.id)`,
      `                .order_by(${vcRow}.ordinal)`,
      "            )",
      "        ).scalars().all()",
    );
  }
  const kwargs: string[] = [`id=${agg.name}Id(row.id)`];
  for (const f of agg.fields) {
    if (isValueCollectionField(f)) {
      const vc = valueCollectionsFor(agg).find((c) => c.fieldName === f.name);
      if (vc) kwargs.push(`${snake(f.name)}=${hydrateValueCollection(vc, "__r", ctx)}`);
      continue;
    }
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
  // Restore co-located provenance lineage from the row's jsonb column —
  // bind the instance so the backing fields can be set after construction
  // (the full-state ctor doesn't take provenance).
  const provFields = provenancedFieldsOf(agg);
  if (provFields.length > 0) {
    out.push(`        __agg = ${agg.name}._create(`);
    out.push(...kwargs.map((k) => `            ${k},`));
    out.push("        )");
    for (const f of provFields) {
      const col = provColumn(f.name);
      out.push(
        `        __agg._${col} = (`,
        `            ProvLineage.from_wire(row.${col}) if row.${col} is not None else None`,
        "        )",
      );
    }
    out.push("        return __agg");
    return out.join("\n");
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
export function persistField(
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
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  const kind = discriminatorValue(agg, ctx.aggregates);
  const provFields = provenancedFieldsOf(agg);
  const out: string[] = [`    async def save(self, ${aggVar}: ${agg.name}) -> None:`];
  const rootPairs: Array<[string, string]> = [["id", `${aggVar}.id`]];
  if (kind) rootPairs.push(["kind", JSON.stringify(kind)]);
  for (const f of agg.fields) {
    if (isRefCollectionField(f) || isValueCollectionField(f)) continue;
    rootPairs.push(...persistField(aggVar, f, ctx));
  }
  // Co-located provenance lineage (provenance.md): the current `<field>_provenance`
  // jsonb column, serialised from the `ProvLineage` dataclass.
  for (const f of provFields) {
    rootPairs.push([
      provColumn(f.name),
      `(${aggVar}.${provColumn(f.name)}.to_wire() if ${aggVar}.${provColumn(f.name)} is not None else None)`,
    ]);
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
  // Replace each value-object collection wholesale: the elements are
  // identity-less, so there is nothing to diff on.  Delete every child row
  // for this owner, then re-insert the current list with its ordinals.
  for (const vc of valueCollectionsFor(agg)) {
    out.push(...syncValueCollection(vc, ctx, aggVar));
  }
  if (ctx.events.length > 0) {
    out.push("        for event in aggregate.pull_events():");
    out.push("            await self._events.dispatch(event)");
  }
  // Provenance flush (provenance.md): drain the per-request trace buffer and
  // insert one `provenance_records` row per write, stamped with the ambient
  // request-context ids.  Done BEFORE the save `flush()` (no nested
  // transaction) so the history commits atomically with the aggregate in the
  // request-scoped session — the Python mirror of the .NET `DrainProv()`
  // pre-SaveChanges insert / the elixir-vanilla `flush(Repo)`.
  if (provFields.length > 0) {
    out.push("        __traces = drain()");
    out.push("        if __traces:");
    out.push("            await self._session.execute(");
    out.push("                insert(ProvenanceRecord),");
    out.push("                [");
    out.push("                    {");
    out.push('                        "trace_id": str(uuid4()),');
    out.push('                        "snapshot_id": __lin.snapshot_id,');
    out.push('                        "target_type": __lin.target.type,');
    out.push('                        "field": __lin.target.field,');
    out.push(
      '                        "inputs": [{"path": __i.path, "value": __i.value} for __i in __lin.inputs],',
    );
    out.push('                        "computed_value": __lin.computed_value,');
    out.push('                        "at": datetime.now(UTC),');
    out.push('                        "correlation_id": correlation_id(),');
    out.push('                        "scope_id": scope_id(),');
    out.push('                        "actor_id": actor_id(),');
    out.push('                        "parent_id": parent_id(),');
    out.push("                    }");
    out.push("                    for __lin in __traces");
    out.push("                ],");
    out.push("            )");
  }
  // One transaction per request: the session dependency commits.
  out.push("        await self._session.flush()");
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
    [`${snake(tableOwnerName(agg, ctx.aggregates))}_id`, "child.parent_id"],
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

/** Persist a value-object collection (`<VO>[]`) to its id-less child table.
 *  The elements are identity-less, so the list is replaced wholesale: delete
 *  every child row for the owner, then insert the current list ordered by
 *  ordinal.  Each row is the owner FK + ordinal + the value object's flattened
 *  columns (bare VO field names), persisted with the same `persistScalar`
 *  conversions a single VO field uses.  An optional field (`<VO>[]?`) that is
 *  None reduces to the empty list (parity with node's `?? []`). */
function syncValueCollection(
  vc: ValueCollectionIR,
  ctx: EnrichedBoundedContextIR,
  aggVar: string,
): string[] {
  const vcRow = valueCollectionRowClassName(vc.childTable);
  const vo = ctx.valueObjects.find((v) => v.name === vc.voName);
  const v = snake(vc.fieldName);
  // Flattened VO column kwargs: `amount=Decimal(str(__e.amount)), …`.
  const voKwargs = (vo?.fields ?? []).map(
    (vf) => `${snake(vf.name)}=${persistScalar(`__e.${snake(vf.name)}`, vf.type, false)}`,
  );
  return [
    "        await self._session.execute(",
    `            delete(${vcRow}).where(${vcRow}.${vc.parentFk} == ${aggVar}.id)`,
    "        )",
    `        for __i, __e in enumerate(${aggVar}.${v} or []):`,
    "            await self._session.execute(",
    `                insert(${vcRow}).values(`,
    `                    ${vc.parentFk}=${aggVar}.id,`,
    "                    ordinal=__i,",
    ...voKwargs.map((p) => `                    ${p},`),
    "                )",
    "            )",
  ];
}

/** The per-operation audit insert — staged in the request's own session so
 *  the audit row commits in the SAME transaction as the aggregate save
 *  (atomic).  before/after are the wire-DTO snapshots the route captures
 *  either side of the mutation; the actor + correlation / scope / parent ids
 *  are the ambient RequestContext slices.  Parity with the .NET IAuditWriter
 *  staging + the Java service insert. */
function recordAuditMethod(): string {
  return lines(
    "    async def record_audit(",
    "        self,",
    "        *,",
    "        operation_id: str,",
    "        action: str,",
    "        target_type: str,",
    "        target_id: str,",
    // `before` / `after` are the wire-DTO snapshots either side of the mutation.
    // A lifecycle action passes `JSON.NULL` on the asymmetric side (create → no
    // before, destroy → no after): it stores the JSON `null` literal, satisfying
    // the NOT NULL jsonb column (parity with the Hono route's `before: null`).
    "        before: object,",
    "        after: object,",
    "        actor: object | None = None,",
    '        status: str = "ok",',
    "    ) -> None:",
    "        self._session.add(",
    "            AuditRecordRow(",
    "                audit_id=uuid4().hex,",
    "                operation_id=operation_id,",
    "                action=action,",
    "                target_type=target_type,",
    "                target_id=target_id,",
    "                actor=actor,",
    "                before=before,",
    "                after=after,",
    "                at=datetime.now(UTC),",
    "                status=status,",
    "                correlation_id=correlation_id(),",
    "                scope_id=scope_id(),",
    "                parent_id=parent_id(),",
    "            )",
    "        )",
    "        await self._session.flush()",
  );
}

function deleteMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
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
  const root = rowClassName(tableOwnerName(agg, ctx.aggregates));
  out.push(`        await self._session.execute(delete(${root}).where(${root}.id == id))`);
  out.push("        await self._session.flush()");
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

export function toWireMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  // Co-located provenance lineage rides the wire DTO so any GET surfaces the
  // current lineage (`<field>_provenance`), mirroring the Hono / .NET DTO.
  const provPairs = provenancedFieldsOf(agg).map((f) => {
    const col = provColumn(f.name);
    return `"${col}": (root.${col}.to_wire() if root.${col} is not None else None)`;
  });
  return lines(
    `    def to_wire(self, root: ${agg.name}) -> dict[str, object]:`,
    "        return {",
    [...wireProjection(agg, "root", ctx), ...provPairs].map((p) => `            ${p},`),
    "        }",
  );
}

export function partWireMethod(p: EnrichedEntityPartIR, ctx: EnrichedBoundedContextIR): string {
  return lines(
    `    def _wire_${snake(p.name)}(self, e: ${p.name}) -> dict[str, object]:`,
    "        return {",
    wireProjection(p, "e", ctx).map((pair) => `            ${pair},`),
    "        }",
  );
}
