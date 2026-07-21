import type {
  ContainmentIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { aggregateIsVersioned } from "../../ir/util/versioned-capability.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import {
  aggUsesPrincipalContextFilter,
  documentCapabilityBody,
  lowerToSqlAlchemy,
} from "./find-predicate.js";
import { rowClassName } from "./py-columns.js";
import { dtImportLine, wireHelperImport } from "./py-type-imports.js";
import { renderPyExpr, renderPyType } from "./render-expr.js";
import {
  authUserImport,
  emittableFinds,
  findExecutedLine,
  partWireMethod,
  toWireMethod,
  writeGuardAlias,
} from "./repository-builder.js";

// ---------------------------------------------------------------------------
// Document-shaped (`shape(document)`) repository for the Python backend —
// the SQLAlchemy/asyncpg counterpart of the Hono document emit.
//
// A document aggregate persists as ONE jsonb column (`(id, data,
// version)`) instead of the normalised table-per-entity tree.  The repo
// serialises the aggregate's public getters into a plain dict
// (`_<entity>_to_doc`) and rebuilds it through the same `_rehydrate(...)`
// factory the normalised hydrate uses (`_<entity>_from_doc`).  Contained
// parts nest; references ride as id strings; finds evaluate in-memory
// over the rehydrated documents.
//
// `to_wire` is reused unchanged — it reads the domain instance's getters,
// not the DB row, so the wire contract is identical to the normalised
// path (and to the other backends).
// ---------------------------------------------------------------------------

export function buildPyDocumentRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassName(agg.name);
  const parts: EnrichedEntityPartIR[] = agg.parts;
  const versioned = aggregateIsVersioned(agg);
  // `delete(id)` is emitted under the same reachable-`destroy` gate the
  // relational builder + routes-builder use — the destroy route calls
  // `repo.delete(id)` regardless of saving shape.  No cascade rows: contained
  // parts / references live inside the jsonb document, so one row is deleted.
  const emitsDelete = !!agg.canonicalDestroy;
  const findUser = emittableFinds(repo).some(findUsesCurrentUser);
  // Capability `filter` on a document aggregate (DEBT-02 tail): the jsonb blob
  // isn't per-field queryable, so the predicate is evaluated IN-APP over the
  // rehydrated instance, mirroring node's `documentCapabilityBody` `.filter`.
  // `capRec`/`capX` differ only in the bound variable name (`rec` for the
  // single-row `find_by_id`, `x` for the list comprehensions).  Null when the
  // aggregate has no capability filter — every read stays byte-identical to the
  // pre-DEBT-02 document repository.  A principal-referencing predicate renders
  // `current_user.<claim>`, with `current_user = require_current_user()` bound
  // once before the read (the ambient accessor — no read-method parameter).
  const capRec = documentCapabilityBody(agg, "rec");
  const capX = documentCapabilityBody(agg, "x");
  const usesPrincipal = aggUsesPrincipalContextFilter(agg);
  const principalBind = usesPrincipal ? ["        current_user = require_current_user()"] : [];
  const fromDoc = `_${snake(agg.name)}_from_doc`;
  // A versioned root rehydrates its `version` from the authoritative column, so
  // every root load threads `<row>.version` alongside the jsonb blob.
  const fromDocCall = (rowVar: string): string =>
    versioned ? `${fromDoc}(${rowVar}.data, ${rowVar}.version)` : `${fromDoc}(${rowVar}.data)`;

  const body = lines(
    `class ${agg.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: ${agg.name}Id) -> ${agg.name} | None:`,
    `        row = await self._session.get(${row}, id)`,
    "        if row is None:",
    "            return None",
    ...(capRec
      ? [
          ...principalBind,
          `        rec = ${fromDocCall("row")}`,
          `        if not (${capRec.expr}):`,
          "            return None",
          "        return rec",
        ]
      : [`        return ${fromDocCall("row")}`]),
    "",
    `    async def get_by_id(self, id: ${agg.name}Id) -> ${agg.name}:`,
    "        found = await self.find_by_id(id)",
    `        log("debug", "aggregate_loaded", aggregate=${JSON.stringify(agg.name)}, id=str(id), found=found is not None)`,
    "        if found is None:",
    `            raise AggregateNotFoundError(f"${agg.name} {id} not found")`,
    "        return found",
    ...writeGuardAlias(agg),
    "",
    `    async def all(self) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${row}))).scalars().all()`,
    ...(capX
      ? [
          ...principalBind,
          `        return [x for x in (${fromDocCall("r")} for r in rows) if (${capX.expr})]`,
        ]
      : [`        return [${fromDocCall("r")} for r in rows]`]),
    "",
    `    async def find_many_by_ids(self, ids: list[${agg.name}Id]) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${row}).where(${row}.id.in_(list(ids))))).scalars().all()`,
    ...(capX
      ? [
          ...principalBind,
          `        return [x for x in (${fromDocCall("r")} for r in rows) if (${capX.expr})]`,
        ]
      : [`        return [${fromDocCall("r")} for r in rows]`]),
    ...emittableFinds(repo).flatMap((f) => ["", findMethod(agg, f, ctx, capX != null)]),
    "",
    versioned
      ? `    async def save(self, aggregate: ${agg.name}, expected_version: int | None = None) -> None:`
      : `    async def save(self, aggregate: ${agg.name}) -> None:`,
    `        data = _${snake(agg.name)}_to_doc(aggregate)`,
    // Optimistic-concurrency guard (default-on `versioned`), byte-for-byte the
    // relational/embedded guarded upsert over the `(id, data, version)` row: a
    // fresh INSERT seeds the row at the aggregate's own version (the shared 0
    // create-default), and an INSERT-conflict only overwrites when the stored
    // `version` still equals the caller's expected value, bumping it by one.  A
    // stale write matches no row, so `RETURNING id` is empty → ConcurrencyError.
    // The `version` COLUMN is authoritative (the blob copy lags a write and is
    // ignored on load — see `entityFromDoc`), so the loaded aggregate's version
    // is the write-time expectation when no `If-Match` was sent.
    ...(versioned
      ? [
          "        _expected = aggregate.version if expected_version is None else expected_version",
          "        _guarded = await self._session.execute(",
          `            insert(${row})`,
          "            .values(id=aggregate.id, data=data, version=aggregate.version)",
          "            .on_conflict_do_update(",
          '                index_elements=["id"],',
          `                set_={"data": data, "version": ${row}.version + 1},`,
          `                where=${row}.version == _expected,`,
          "            )",
          `            .returning(${row}.id)`,
          "        )",
          "        if _guarded.first() is None:",
          `            raise ConcurrencyError(f"${agg.name} {aggregate.id} was modified concurrently")`,
        ]
      : [
          `        existing = await self._session.get(${row}, aggregate.id)`,
          "        if existing is None:",
          `            self._session.add(${row}(id=aggregate.id, data=data, version=1))`,
          "        else:",
          "            existing.data = data",
          "            existing.version += 1",
        ]),
    "        await self._session.flush()",
    `        log("debug", "repository_save", aggregate=${JSON.stringify(agg.name)}, id=str(aggregate.id))`,
    ...(ctx.events.length > 0
      ? [
          "        for event in aggregate.pull_events():",
          "            await self._events.dispatch(event)",
        ]
      : []),
    ...(emitsDelete
      ? [
          "",
          `    async def delete(self, id: ${agg.name}Id) -> None:`,
          `        await self._session.execute(delete(${row}).where(${row}.id == id))`,
          "        await self._session.flush()",
        ]
      : []),
    "",
    toWireMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partWireMethod(p, ctx)]),
  );

  const serializers = lines(
    ...[agg, ...parts].flatMap((e) => [entityToDoc(e, agg, ctx), "", ""]),
    ...[agg, ...parts].flatMap((e) => [entityFromDoc(e, e === agg, agg, ctx), "", ""]),
  );

  const scan = `${body}\n${serializers}`.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const idNames = [
    ...new Set(
      [agg, ...parts].flatMap((e) => [
        `${e.name}Id`,
        ...e.fields.flatMap((f) => {
          const t = f.type.kind === "optional" ? f.type.inner : f.type;
          if (t.kind === "id") return [`${t.targetName}Id`];
          if (t.kind === "array" && t.element.kind === "id") return [`${t.element.targetName}Id`];
          return [];
        }),
      ]),
    ),
  ]
    .filter(refersTo)
    .sort();
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const domainNames = [agg.name, ...parts.map((p) => p.name)].filter(refersTo);

  return lines(
    `"""${agg.name} document repository (shape(document)).  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    // In-app filters render domain expressions (A5 temporal included), so
    // `UTC` (`now()`) and `timedelta` (absolute durations) ride in on use.
    dtImportLine(refersTo),
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("math") || refersTo("datetime") || refersTo("timedelta") || refersTo("Decimal")
      ? ""
      : null,
    refersTo("cast") ? "from typing import cast" : null,
    "",
    emitsDelete ? "from sqlalchemy import delete, select" : "from sqlalchemy import select",
    versioned ? "from sqlalchemy.dialects.postgresql import insert" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    // `User` for a per-find `where` principal param; `require_current_user` for
    // an always-on principal capability filter (DEBT-02 tail) — one sorted import.
    authUserImport(findUser, usesPrincipal),
    `from app.db.schema import ${row}`,
    wireHelperImport(refersTo),
    versioned
      ? "from app.domain.errors import AggregateNotFoundError, ConcurrencyError"
      : "from app.domain.errors import AggregateNotFoundError",
    refersTo("DomainEvent")
      ? "from app.domain.events import DomainEvent, DomainEventDispatcher"
      : "from app.domain.events import DomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    domainNames.length > 0
      ? `from app.domain.${snake(agg.name)} import ${domainNames.join(", ")}`
      : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    // `log` for the mechanism-debug trio (aggregate_loaded / repository_save /
    // find_executed) — always emitted now (S5).
    "from app.obs.log import log",
    "",
    "",
    body,
    "",
    "",
    serializers,
  );
}

function findMethod(
  agg: EnrichedAggregateIR,
  find: FindIR,
  _ctx: EnrichedBoundedContextIR,
  aggHasCapFilter: boolean,
): string {
  // Document finds evaluate in-memory over the rehydrated aggregates —
  // the JSONB blob isn't queryable per-field the way a relational table
  // is.  `where` predicates re-render against a domain instance (`x`),
  // reusing the SQLAlchemy lowering's structural walk only for shape.
  void lowerToSqlAlchemy;
  const params = find.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  const usesUser = findUsesCurrentUser(find);
  if (usesUser) params.push("current_user: User");
  const sig = ["self", ...params].join(", ");
  const pred = find.filter
    ? `lambda x: ${renderPyExpr(find.filter, { thisName: "x" })}`
    : conventionPredicate(agg, find);
  const isList = find.returnType.kind === "array";
  const isOptional = find.returnType.kind === "optional";
  const ret = isList ? `list[${agg.name}]` : isOptional ? `${agg.name} | None` : agg.name;

  // When the aggregate carries a capability `filter` (DEBT-02 tail), a find
  // must apply the capability predicate too — but it reads a RAW load (not the
  // already-filtered `all()`) so an `ignoring` clause on the find can drop the
  // named capability conjunct.  Both the (bypass-adjusted) capability predicate
  // and the find's own `where` are AND-ed inline over `x`.  Without a capability
  // filter the find stays byte-identical: it reuses `self.all()` and the
  // `(lambda)(x)` form.
  let out: string[];
  if (aggHasCapFilter) {
    const cap = documentCapabilityBody(agg, "x", {
      bypassAll: find.bypassAll,
      bypassCaps: find.bypassCaps,
    });
    // Bind the ambient principal only when this find's surviving capability
    // predicate references it AND the find doesn't already take `current_user`
    // as a `where` param (mirrors node's `&& !usesUser`).
    const bindPrincipal = cap?.usesPrincipal && !usesUser;
    const findCond = find.filter
      ? renderPyExpr(find.filter, { thisName: "x" })
      : conventionInline(agg, find);
    const conds = [cap?.expr, findCond].filter((c): c is string => c != null).map((c) => `(${c})`);
    const filtered = conds.length > 0 ? `[x for x in items if ${conds.join(" and ")}]` : "items";
    out = [
      `    async def ${snake(find.name)}(${sig}) -> ${ret}:`,
      `        rows = (await self._session.execute(select(${rowClassName(agg.name)}))).scalars().all()`,
      ...(bindPrincipal ? ["        current_user = require_current_user()"] : []),
      aggregateIsVersioned(agg)
        ? `        items = [_${snake(agg.name)}_from_doc(r.data, r.version) for r in rows]`
        : `        items = [_${snake(agg.name)}_from_doc(r.data) for r in rows]`,
    ];
    if (isList) {
      out.push(`        result = ${filtered}`);
      out.push(findExecutedLine(agg, find.name, "len(result)"));
      out.push("        return result");
    } else {
      out.push(`        matches = ${filtered}`);
      out.push(findExecutedLine(agg, find.name, "len(matches)"));
      out.push(
        isOptional ? "        return matches[0] if matches else None" : "        return matches[0]",
      );
    }
    return out.join("\n");
  }

  const filtered = pred ? `[x for x in items if (${pred})(x)]` : "items";
  out = [
    `    async def ${snake(find.name)}(${sig}) -> ${ret}:`,
    "        items = await self.all()",
  ];
  if (isList) {
    out.push(`        result = ${filtered}`);
    out.push(findExecutedLine(agg, find.name, "len(result)"));
    out.push("        return result");
  } else {
    out.push(`        matches = ${filtered}`);
    out.push(findExecutedLine(agg, find.name, "len(matches)"));
    out.push(
      isOptional ? "        return matches[0] if matches else None" : "        return matches[0]",
    );
  }
  return out.join("\n");
}

function conventionPredicate(agg: EnrichedAggregateIR, find: FindIR): string | undefined {
  const inline = conventionInline(agg, find);
  return inline ? `lambda x: ${inline}` : undefined;
}

/** The convention-find clause (param-name → matching-field equality) WITHOUT
 *  the `lambda x:` wrapper — used inline by the capability-scoped find path,
 *  where the find condition is AND-ed with the capability predicate over `x`. */
function conventionInline(agg: EnrichedAggregateIR, find: FindIR): string | undefined {
  const clauses: string[] = [];
  for (const p of find.params) {
    const matched = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matched) clauses.push(`x.${snake(matched.name)} == ${snake(p.name)}`);
  }
  return clauses.length > 0 ? clauses.join(" and ") : undefined;
}

// --- (de)serialisers --------------------------------------------------------

function containsType(c: ContainmentIR): boolean {
  return c.collection;
}

export function entityToDoc(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  root: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const isRoot = entity === root;
  const entries: string[] = ['"id": str(a.id)'];
  if (!isRoot) entries.push('"parent_id": str(a.parent_id)');
  for (const f of entity.fields) {
    entries.push(`"${snake(f.name)}": ${serialize(f.type, `a.${snake(f.name)}`, ctx)}`);
  }
  for (const c of entity.contains) {
    const toDoc = `_${snake(c.partName)}_to_doc`;
    const acc = `a.${snake(c.name)}`;
    entries.push(
      containsType(c)
        ? `"${snake(c.name)}": [${toDoc}(e) for e in ${acc}]`
        : c.optional
          ? `"${snake(c.name)}": (None if ${acc} is None else ${toDoc}(${acc}))`
          : `"${snake(c.name)}": ${toDoc}(${acc})`,
    );
  }
  return lines(
    `def _${snake(entity.name)}_to_doc(a: ${entity.name}) -> dict[str, object]:`,
    `    return {${entries.join(", ")}}`,
  );
}

export function entityFromDoc(
  entity: EnrichedAggregateIR | EnrichedEntityPartIR,
  isRoot: boolean,
  root: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): string {
  // Default-on versioning: the `version` token is server-owned and lives in the
  // authoritative `version` COLUMN, not the jsonb blob (the blob's copy lags a
  // write, since the guarded upsert bumps the column but re-stores the loaded
  // aggregate's data).  Rehydrate it from the column — threaded in as a `version`
  // parameter — so a loaded aggregate's `version` always reflects the stored row
  // (the same single-source-of-truth the relational path gets for free from its
  // column read).  Parts carry no version.
  const rootVersioned = isRoot && aggregateIsVersioned(entity as EnrichedAggregateIR);
  const entries: string[] = [`id=${entity.name}Id(cast(str, d["id"]))`];
  if (!isRoot) entries.push(`parent_id=${root.name}Id(cast(str, d["parent_id"]))`);
  for (const f of entity.fields) {
    if (rootVersioned && f.name === "version") {
      entries.push("version=version");
      continue;
    }
    entries.push(`${snake(f.name)}=${deserialize(f.type, `d["${snake(f.name)}"]`, ctx)}`);
  }
  for (const c of entity.contains) {
    const fromDoc = `_${snake(c.partName)}_from_doc`;
    const acc = `d["${snake(c.name)}"]`;
    entries.push(
      containsType(c)
        ? `${snake(c.name)}=[${fromDoc}(x) for x in cast(list[object], ${acc})]`
        : c.optional
          ? `${snake(c.name)}=(None if ${acc} is None else ${fromDoc}(${acc}))`
          : `${snake(c.name)}=${fromDoc}(${acc})`,
    );
  }
  // The JSONB column types as `object`; cast each access to the doc dict.
  return lines(
    rootVersioned
      ? `def _${snake(entity.name)}_from_doc(raw: object, version: int) -> ${entity.name}:`
      : `def _${snake(entity.name)}_from_doc(raw: object) -> ${entity.name}:`,
    "    d = cast(dict[str, object], raw)",
    `    return ${entity.name}._rehydrate(${entries.join(", ")})`,
  );
}

function serialize(t: TypeIR, acc: string, ctx: EnrichedBoundedContextIR): string {
  if (t.kind === "optional") {
    return `(None if ${acc} is None else ${serialize(t.inner, acc, ctx)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "money") return `str(${acc})`;
    if (t.name === "datetime") return `${acc}.isoformat()`;
    return acc;
  }
  if (t.kind === "id") return `str(${acc})`;
  if (t.kind === "enum") return `${acc}.value`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return acc;
    const fields = vo.fields
      .map((vf) => `"${snake(vf.name)}": ${serialize(vf.type, `${acc}.${snake(vf.name)}`, ctx)}`)
      .join(", ");
    return `{${fields}}`;
  }
  if (t.kind === "array") {
    if (t.element.kind === "id") return `[str(x) for x in ${acc}]`;
    return `[${serialize(t.element, "x", ctx)} for x in ${acc}]`;
  }
  return acc;
}

function deserialize(t: TypeIR, acc: string, ctx: EnrichedBoundedContextIR): string {
  if (t.kind === "optional") {
    return `(None if ${acc} is None else ${deserialize(t.inner, acc, ctx)})`;
  }
  if (t.kind === "primitive") {
    if (t.name === "money") return `Decimal(cast(str, ${acc}))`;
    if (t.name === "datetime") return `datetime.fromisoformat(cast(str, ${acc}))`;
    if (t.name === "decimal") return `float(cast(float, ${acc}))`;
    return `cast(${primitivePy(t.name)}, ${acc})`;
  }
  if (t.kind === "id") return `${t.targetName}Id(cast(str, ${acc}))`;
  if (t.kind === "enum") return `${t.name}(cast(str, ${acc}))`;
  if (t.kind === "valueobject") {
    const vo = ctx.valueObjects.find((v) => v.name === t.name);
    if (!vo) return acc;
    const m = `cast(dict[str, object], ${acc})`;
    const args = vo.fields
      .map((vf) => deserialize(vf.type, `${m}["${snake(vf.name)}"]`, ctx))
      .join(", ");
    return `${vo.name}(${args})`;
  }
  if (t.kind === "array") {
    const list = `cast(list[object], ${acc})`;
    if (t.element.kind === "id")
      return `[${t.element.targetName}Id(cast(str, x)) for x in ${list}]`;
    return `[${deserialize(t.element, "x", ctx)} for x in ${list}]`;
  }
  return acc;
}

function primitivePy(name: string): string {
  switch (name) {
    case "int":
    case "long":
      return "int";
    case "bool":
      return "bool";
    case "decimal":
      return "float";
    default:
      return "str";
  }
}

/** Field-import helper kept exported for the schema's document model to
 *  share the id-typing decision. */
export function documentFields(agg: EnrichedAggregateIR): FieldIR[] {
  return agg.fields;
}
