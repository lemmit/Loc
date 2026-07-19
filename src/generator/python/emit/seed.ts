import { createInputFields } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  SeedRowIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { snake } from "../../../util/naming.js";
import { type Entry, groupByDataset, usedAggregates } from "../../_persistence/seed-datasets.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { renderPyExpr } from "../render-expr.js";

// ---------------------------------------------------------------------------
// First-boot database seeding (database-seeding.md) — `app/db/seed.py`
// from the merged context's `SeedIR` list, the Python port of the Hono
// `db/seed.ts` emitter:
//
//   - Default path is **through the domain `create`** (D-SEED-PATH):
//     each row becomes `await <agg>_repo.save(<Agg>.create(field=…))`,
//     so constructor invariants run — a bad seed fails at boot instead
//     of writing a corrupt row.
//   - `raw` rows bypass the domain and emit the shared
//     `renderSeedRowInsert` INSERT verbatim (explicit ids + literal FK
//     columns per D-SEED-XREF), driver-executed so `:` in literals
//     can't be mistaken for bind params.
//   - **Ship-once per dataset** (D-SEED-IDEMPOTENCY): the `__loom_seed`
//     marker table records applied datasets; `default` always runs,
//     others opt in via LOOM_SEED (comma-separated).
//
// Boot order matches the other backends: migrations, then seeds (the
// lifespan calls `run_seeds()` right after `run_migrations()`); the
// module also runs out-of-band via `python -m app.db.seed`.
// ---------------------------------------------------------------------------

export function buildPySeedFile(
  ctx: EnrichedBoundedContextIR,
  schemaFor: (aggName: string) => string | undefined = () => undefined,
): string | null {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return null;

  // Only non-abstract aggregates have a `create` factory + repository.
  const seedableAggs = ctx.aggregates.filter((a) => !a.isAbstract);
  const seedable = new Set(seedableAggs.map((a) => a.name));
  const aggByName = new Map<string, EnrichedAggregateIR>(seedableAggs.map((a) => [a.name, a]));
  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  for (const ds of datasets) {
    const entries = ds.entries.filter((e) => seedable.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(renderDatasetFn(ds.name, entries, schemaFor, aggByName));
    callLines.push(`        await _seed_${snake(ds.name)}(session, requested)`);
  }
  if (callLines.length === 0) return null;

  const body = lines(...fnBlocks);
  const domainAggs = usedAggregates(datasets, seedable);
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]
    .filter(refersTo)
    .sort();
  const idNames = ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter(refersTo)
    .sort();

  return lines(
    `"""First-boot database seeding (database-seeding.md).  Auto-generated.`,
    "",
    "Ship-once per dataset via the __loom_seed marker; re-runs are no-ops.",
    "`default` always runs; other datasets opt in via LOOM_SEED.",
    `"""`,
    "",
    "import asyncio",
    refersTo("math") ? "import math" : null,
    "import os",
    // Seed rows coerce a datetime field via `datetime.fromisoformat(...)`; they
    // never construct `datetime.now(UTC)`, so importing `UTC` here trips ruff
    // F401 (imported but unused).
    refersTo("datetime") ? "from datetime import datetime" : null,
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    "",
    "from sqlalchemy import text",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    "from app.db.engine import session_factory",
    ...domainAggs.map(
      (a) => `from app.db.repositories.${snake(a)}_repository import ${a}Repository`,
    ),
    domainAggs.length > 0 ? "from app.domain.events import NoopDomainEventDispatcher" : null,
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    ...domainAggs.map((a) => `from app.domain.${snake(a)} import ${a}`),
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    "",
    "",
    "def _dataset_enabled(dataset: str, requested: set[str]) -> bool:",
    '    return dataset == "default" or dataset in requested',
    "",
    "",
    "async def _already_seeded(session: AsyncSession, dataset: str) -> bool:",
    "    r = await session.execute(",
    '        text("SELECT 1 FROM __loom_seed WHERE dataset = :d"), {"d": dataset}',
    "    )",
    "    return r.first() is not None",
    "",
    "",
    "async def _mark_seeded(session: AsyncSession, dataset: str) -> None:",
    '    await session.execute(text("INSERT INTO __loom_seed (dataset) VALUES (:d)"), {"d": dataset})',
    "",
    "",
    body,
    "",
    "async def run_seeds() -> None:",
    "    requested = {",
    '        s.strip() for s in os.environ.get("LOOM_SEED", "").split(",") if s.strip()',
    "    }",
    "    async with session_factory() as session:",
    "        await session.execute(",
    "            text(",
    '                "CREATE TABLE IF NOT EXISTS __loom_seed"',
    '                " (dataset text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"',
    "            )",
    "        )",
    ...callLines,
    "        await session.commit()",
    "",
    "",
    'if __name__ == "__main__":',
    "    asyncio.run(run_seeds())",
    "",
  );
}

function renderDatasetFn(
  dataset: string,
  entries: Entry[],
  schemaFor: (aggName: string) => string | undefined,
  aggByName: Map<string, EnrichedAggregateIR>,
): string {
  const domainAggs = [...new Set(entries.filter((e) => !e.raw).map((e) => e.row.aggregate))];
  const repoDecls = domainAggs.map(
    (a) => `    ${snake(a)}_repo = ${a}Repository(session, NoopDomainEventDispatcher())`,
  );
  const saveLines = entries.map((e) =>
    e.raw
      ? // raw path (D-SEED-XREF): driver-level INSERT with explicit ids,
        // schema-qualified to match the dataSource-routed table.
        `    await (await session.connection()).exec_driver_sql(${pyStr(qualifiedInsert(e.row, schemaFor(e.row.aggregate)))})`
      : `    await ${snake(e.row.aggregate)}_repo.save(${e.row.aggregate}.create(${renderInput(e.row, aggByName.get(e.row.aggregate)!)}))`,
  );
  return lines(
    `async def _seed_${snake(dataset)}(session: AsyncSession, requested: set[str]) -> None:`,
    `    if not _dataset_enabled(${pyStr(dataset)}, requested):`,
    "        return",
    `    if await _already_seeded(session, ${pyStr(dataset)}):`,
    "        return",
    ...repoDecls,
    ...saveLines,
    `    await _mark_seeded(session, ${pyStr(dataset)})`,
    "",
  );
}

/** The shared INSERT renderer emits an unqualified table name; the
 *  Python schema routes every aggregate table through its dataSource's
 *  Postgres schema, so the raw INSERT is qualified to match. */
function qualifiedInsert(row: SeedRowIR, schema: string | undefined): string {
  const sql = renderSeedRowInsert(row.aggregate, row.fields);
  if (!schema) return sql;
  return sql.replace(/^INSERT INTO "/, `INSERT INTO "${schema}"."`);
}

/** `field=<expr>, …` create-factory kwargs from a seed row.  Seed
 *  expressions never reference `this`; the default render context
 *  (literals / enum values / value-object ctors / money / now())
 *  suffices — except `datetime` fields, coerced below. */
function renderInput(row: SeedRowIR, agg: EnrichedAggregateIR): string {
  const typeByName = new Map(createInputFields(agg).map((f) => [f.name, f.type]));
  return row.fields
    .map((f) => `${snake(f.name)}=${renderField(f.value, typeByName.get(f.name))}`)
    .join(", ");
}

function renderField(value: ExprIR, type: TypeIR | undefined): string {
  return coerceSeedValue(type, renderPyExpr(value));
}

/** A seed row's `datetime` field is written as a string literal (`"2024-…Z"`),
 *  but the `create(...)` factory takes a `datetime` — coerce it via
 *  `datetime.fromisoformat` (Python 3.11+ accepts the trailing `Z`). */
function coerceSeedValue(type: TypeIR | undefined, rendered: string): string {
  const leaf = type?.kind === "optional" ? type.inner : type;
  if (leaf?.kind === "primitive" && leaf.name === "datetime") {
    return `datetime.fromisoformat(${rendered})`;
  }
  return rendered;
}

function pyStr(s: string): string {
  return JSON.stringify(s);
}
