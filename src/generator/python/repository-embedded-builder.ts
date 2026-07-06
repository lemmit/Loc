import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  EnrichedEntityPartIR,
  FieldIR,
  RepositoryIR,
} from "../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { aggUsesPrincipalContextFilter, contextFilterPredicate } from "./find-predicate.js";
import { isRefCollectionField, isValueCollectionField, rowClassName } from "./py-columns.js";
import { wireHelperImport } from "./py-type-imports.js";
import {
  authUserImport,
  emittableFinds,
  hydrateField,
  partWireMethod,
  persistField,
  relationalFindMethod,
  rootWhere,
  toWireMethod,
} from "./repository-builder.js";
import { entityFromDoc, entityToDoc } from "./repository-document-builder.js";

// ---------------------------------------------------------------------------
// Embedded-children (`shape(embedded)`) repository for the Python backend.
//
// The root stays a normal queryable row — `id` plus its scalar / `X id`
// columns, exactly like the relational root, so finds run as real SQL
// (`relationalFindMethod`, hydrate reuses `hydrateField` / `persistField`).
// But each containment folds into a single jsonb column and reference
// collections fold into a jsonb id-array column — (de)serialised through
// the same `_<part>_to_doc` / `_<part>_from_doc` helpers the document
// repository uses.  No part tables, no join tables.
//
// `to_wire` is reused unchanged.
// ---------------------------------------------------------------------------

export function buildPyEmbeddedRepositoryFile(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
): string {
  const row = rowClassName(agg.name);
  const parts: EnrichedEntityPartIR[] = agg.parts;
  const findUser = emittableFinds(repo).some(findUsesCurrentUser);
  // An embedded aggregate's root scalars are real columns, so a capability
  // `filter` AND-s into every root read exactly like the relational path
  // (DEBT-02 tail).  Non-principal AND principal predicates are wired — the
  // latter renders `current_user.<claim>` against the ambient
  // `require_current_user()` accessor (`contextFilterPredicate` is shape-agnostic).
  // `document` shapes never reach here (gated by `validateContextFilterSupport`).
  // Null when the aggregate has no capability filter — emission stays
  // byte-identical (`rootWhere(null, …)` → no `.where(...)`).
  const filterPred = contextFilterPredicate(agg, ctx);

  const body = lines(
    `class ${agg.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: ${agg.name}Id) -> ${agg.name} | None:`,
    filterPred
      ? `        row = (await self._session.execute(select(${row})${rootWhere(
          { expr: `${row}.id == id`, ops: new Set() },
          row,
          undefined,
          filterPred,
        )})).scalars().first()`
      : `        row = await self._session.get(${row}, id)`,
    "        if row is None:",
    "            return None",
    "        return await self._hydrate(row)",
    "",
    `    async def get_by_id(self, id: ${agg.name}Id) -> ${agg.name}:`,
    "        found = await self.find_by_id(id)",
    `        log("debug", "aggregate_loaded", aggregate=${JSON.stringify(agg.name)}, id=str(id), found=found is not None)`,
    "        if found is None:",
    `            raise AggregateNotFoundError(f"${agg.name} {id} not found")`,
    "        return found",
    "",
    `    async def all(self) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${row})${rootWhere(null, row, undefined, filterPred)})).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    // `false`: the embedded repo loads the whole aggregate from one jsonb column
    // (no per-row child SELECT), so it emits no `_hydrate_many` — find methods
    // must stay on the per-row `_hydrate` comprehension.
    ...emittableFinds(repo).flatMap((f) => [
      "",
      relationalFindMethod(agg, f, ctx, filterPred, false),
    ]),
    "",
    `    async def find_many_by_ids(self, ids: list[${agg.name}Id]) -> list[${agg.name}]:`,
    `        rows = (await self._session.execute(select(${row})${rootWhere(
      { expr: `${row}.id.in_(list(ids))`, ops: new Set() },
      row,
      undefined,
      filterPred,
    )})).scalars().all()`,
    "        return [await self._hydrate(row) for row in rows]",
    "",
    saveMethod(agg, ctx),
    "",
    hydrateMethod(agg, ctx),
    "",
    toWireMethod(agg, ctx),
    ...parts.flatMap((p) => ["", partWireMethod(p, ctx)]),
  );

  const serializers = lines(
    ...parts.flatMap((p) => [entityToDoc(p, agg, ctx), "", ""]),
    ...parts.flatMap((p) => [entityFromDoc(p, false, agg, ctx), "", ""]),
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
  // `and_`/`or_`/`not_` ride in when a capability filter lowers to them; `func`
  // for a paged find's count; `select` for the reads + membership EXISTS.
  // (`insert` is the separate `sqlalchemy.dialects.postgresql` import below.)
  const saNames = ["and_", "func", "not_", "or_", "select"].filter(refersTo);

  return lines(
    `"""${agg.name} embedded repository (shape(embedded)).  Auto-generated."""`,
    "",
    refersTo("math") ? "import math" : null,
    refersTo("datetime") ? "from datetime import datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("math") || refersTo("datetime") || refersTo("Decimal") ? "" : null,
    refersTo("cast") ? "from typing import cast" : null,
    "",
    saNames.length > 0 ? `from sqlalchemy import ${saNames.join(", ")}` : null,
    refersTo("insert") ? "from sqlalchemy.dialects.postgresql import insert" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    // `User` for a per-find `where` principal param; `require_current_user` for
    // an always-on principal capability filter (DEBT-02 tail) — one sorted import.
    authUserImport(findUser, aggUsesPrincipalContextFilter(agg)),
    `from app.db.schema import ${row}`,
    wireHelperImport(refersTo),
    "from app.domain.errors import AggregateNotFoundError",
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
    // `log` for the mechanism-debug trio (aggregate_loaded / repository_save;
    // find_executed rides the shared relationalFindMethod) — always emitted (S5).
    "from app.obs.log import log",
    "",
    "",
    body,
    "",
    "",
    serializers,
  );
}

function hydrateMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const row = rowClassName(agg.name);
  const kwargs: string[] = [`id=${agg.name}Id(row.id)`];
  for (const f of agg.fields) {
    if (isValueCollectionField(f)) continue;
    if (isRefCollectionField(f)) {
      const target = refTarget(f);
      kwargs.push(
        `${snake(f.name)}=[${target}Id(cast(str, __x)) for __x in cast(list[object], row.${snake(f.name)})]`,
      );
      continue;
    }
    kwargs.push(`${snake(f.name)}=${hydrateField("row", f, ctx)}`);
  }
  for (const c of agg.contains) {
    const fromDoc = `_${snake(c.partName)}_from_doc`;
    kwargs.push(
      c.collection
        ? `${snake(c.name)}=[${fromDoc}(__x) for __x in cast(list[object], row.${snake(c.name)})]`
        : `${snake(c.name)}=(None if row.${snake(c.name)} is None else ${fromDoc}(row.${snake(c.name)}))`,
    );
  }
  return lines(
    `    async def _hydrate(self, row: ${row}) -> ${agg.name}:`,
    `        return ${agg.name}._rehydrate(`,
    kwargs.map((k) => `            ${k},`),
    "        )",
  );
}

function saveMethod(agg: EnrichedAggregateIR, ctx: EnrichedBoundedContextIR): string {
  const row = rowClassName(agg.name);
  const pairs: Array<[string, string]> = [["id", "aggregate.id"]];
  for (const f of agg.fields) {
    if (isValueCollectionField(f)) continue;
    if (isRefCollectionField(f)) {
      pairs.push([snake(f.name), `[str(__x) for __x in aggregate.${snake(f.name)}]`]);
      continue;
    }
    pairs.push(...persistField("aggregate", f, ctx));
  }
  for (const c of agg.contains) {
    const toDoc = `_${snake(c.partName)}_to_doc`;
    pairs.push([
      snake(c.name),
      c.collection
        ? `[${toDoc}(__e) for __e in aggregate.${snake(c.name)}]`
        : `(None if aggregate.${snake(c.name)} is None else ${toDoc}(aggregate.${snake(c.name)}))`,
    ]);
  }
  const out: string[] = [
    `    async def save(self, aggregate: ${agg.name}) -> None:`,
    "        root = {",
    ...pairs.map(([k, v]) => `            "${k}": ${v},`),
    "        }",
    "        await self._session.execute(",
    `            insert(${row}).values(**root).on_conflict_do_update(index_elements=["id"], set_=root)`,
    "        )",
    "        await self._session.flush()",
    `        log("debug", "repository_save", aggregate=${JSON.stringify(agg.name)}, id=str(aggregate.id))`,
  ];
  if (ctx.events.length > 0) {
    out.push("        for event in aggregate.pull_events():");
    out.push("            await self._events.dispatch(event)");
  }
  return out.join("\n");
}

function refTarget(f: FieldIR): string {
  const t = f.type.kind === "optional" ? f.type.inner : f.type;
  if (t.kind === "array" && t.element.kind === "id") return t.element.targetName;
  return "";
}
