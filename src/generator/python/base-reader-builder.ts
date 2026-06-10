import type { EnrichedAggregateIR, EnrichedBoundedContextIR } from "../../ir/types/loom-ir.js";
import { isTpcBase, isTphBase, tpcConcretesOf, tphConcretesOf } from "../../ir/util/inheritance.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { rowClassName } from "./py-columns.js";

// ---------------------------------------------------------------------------
// Polymorphic base reader (aggregate-inheritance.md).
//
// An abstract base has no user repository, but the point of inheritance
// is polymorphic access — "query all Parties, dereference any
// `Party id`".  Two artifacts per abstract base:
//
//   app/domain/<base>.py                  — `Party = Customer | Supplier`
//   app/db/repositories/<base>_repository.py — read-only reader
//
// TPH: scan the shared table, dispatch hydration on `kind` by
// delegating to the concrete repository (loads parts/joins properly —
// a deliberate completeness>speed trade vs Hono's scalar-only shared-
// row hydrate).  TPC: union the concrete repositories' reads.
// ---------------------------------------------------------------------------

export function abstractBasesOf(ctx: EnrichedBoundedContextIR): EnrichedAggregateIR[] {
  return ctx.aggregates.filter((a) => isTphBase(a, ctx.aggregates) || isTpcBase(a, ctx.aggregates));
}

export function concretesOf(
  base: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): EnrichedAggregateIR[] {
  return (
    isTphBase(base, ctx.aggregates)
      ? tphConcretesOf(base, ctx.aggregates)
      : tpcConcretesOf(base, ctx.aggregates)
  ) as EnrichedAggregateIR[];
}

/** `app/domain/<snake(base)>.py` — the tagged union of concrete subtypes. */
export function buildPyBaseUnionFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
): string {
  return lines(
    `"""Polymorphic ${base.name} — the union of its concrete subtypes.  Auto-generated."""`,
    "",
    ...concretes.map((c) => `from app.domain.${snake(c.name)} import ${c.name}`),
    "",
    `${base.name} = ${concretes.map((c) => c.name).join(" | ")}`,
    "",
  );
}

/** Read-only `<Base>Repository` — `find_by_id` + `all` over the
 *  hierarchy, returning the union. */
export function buildPyBaseReaderFile(
  base: EnrichedAggregateIR,
  concretes: EnrichedAggregateIR[],
  ctx: EnrichedBoundedContextIR,
): string {
  const tph = isTphBase(base, ctx.aggregates);
  const body = tph ? tphReader(base, concretes) : tpcReader(base, concretes);
  return lines(
    `"""Read-only polymorphic ${base.name} reader.  Auto-generated."""`,
    "",
    tph ? "from sqlalchemy import select" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    tph ? `from app.db.schema import ${rowClassName(base.name)}` : null,
    ...concretes.map(
      (c) => `from app.db.repositories.${snake(c.name)}_repository import ${c.name}Repository`,
    ),
    `from app.domain.${snake(base.name)} import ${base.name}`,
    "from app.domain.events import DomainEventDispatcher",
    `from app.domain.ids import ${concretes.map((c) => `${c.name}Id`).join(", ")}`,
    "",
    "",
    body,
    "",
  );
}

function tphReader(base: EnrichedAggregateIR, concretes: EnrichedAggregateIR[]): string {
  const row = rowClassName(base.name);
  return lines(
    `class ${base.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: str) -> ${base.name} | None:`,
    `        row = await self._session.get(${row}, id)`,
    "        if row is None:",
    "            return None",
    "        return await self._dispatch(row)",
    "",
    `    async def all(self) -> list[${base.name}]:`,
    `        rows = (await self._session.execute(select(${row}))).scalars().all()`,
    "        return [await self._dispatch(row) for row in rows]",
    "",
    // Dispatch on the kind discriminator, delegating to the concrete
    // repository so contained parts / join tables hydrate fully.
    `    async def _dispatch(self, row: ${row}) -> ${base.name}:`,
    ...concretes.flatMap((c, i) => [
      `        ${i === 0 ? "if" : "elif"} row.kind == "${c.name}":`,
      `            return await ${c.name}Repository(self._session, self._events).get_by_id(${c.name}Id(row.id))`,
    ]),
    `        raise ValueError(f"unknown ${base.name} kind: {row.kind}")`,
  );
}

function tpcReader(base: EnrichedAggregateIR, concretes: EnrichedAggregateIR[]): string {
  return lines(
    `class ${base.name}Repository:`,
    "    def __init__(self, session: AsyncSession, events: DomainEventDispatcher) -> None:",
    "        self._session = session",
    "        self._events = events",
    "",
    `    async def find_by_id(self, id: str) -> ${base.name} | None:`,
    ...concretes.flatMap((c) => [
      `        ${snake(c.name)} = await ${c.name}Repository(self._session, self._events).find_by_id(${c.name}Id(id))`,
      `        if ${snake(c.name)} is not None:`,
      `            return ${snake(c.name)}`,
    ]),
    "        return None",
    "",
    `    async def all(self) -> list[${base.name}]:`,
    `        out: list[${base.name}] = []`,
    ...concretes.map(
      (c) => `        out.extend(await ${c.name}Repository(self._session, self._events).all())`,
    ),
    "        return out",
  );
}
