// First-boot database seeding for the Hono backend (database-seeding.md,
// Phase 2).  Emits `db/seed.ts` from the context's `SeedIR` list.
//
// Per D-SEED-PATH the default path is **through the domain `create`**: each
// row becomes `await <agg>Repo.save(<Agg>.create({ … }))`, so the aggregate's
// constructor invariants run (a bad seed throws at boot rather than writing a
// corrupt row).  Field values are rendered by the shared `renderTsExpr`, so
// value objects (`Money { … }` → `new Money(…)`), enum refs (`OrderStatus.Draft`),
// `money("…")` (→ `new Decimal("…")`) and `now()` all render correctly.
//
// Per D-SEED-IDEMPOTENCY v1 is **ship-once per dataset**: a `__loom_seed`
// marker table holds one row per applied dataset; `runSeeds` skips a dataset
// whose marker is present.  `default` always runs; other datasets run only
// when named in `LOOM_SEED` (comma-separated).
//
// The `raw` table-insert path is wired too: `raw` rows bypass the domain
// `create` and emit a direct `db.execute(sql.raw(INSERT …))` via the shared
// `renderSeedRowInsert`.  Cross-row references use explicit ids per
// D-SEED-XREF (an `@handle` indirection was considered and not adopted).
// Not yet handled (later slices): create-shape validation.

import { forCreateInput } from "../../../ir/enrich/wire-projection.js";
import type {
  EnrichedBoundedContextIR,
  ExprIR,
  SeedRowIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { type Entry, groupByDataset, usedAggregates } from "../../_persistence/seed-datasets.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { renderTsExpr } from "../render-expr.js";

export function emitTypescriptSeeds(ctx: EnrichedBoundedContextIR, out: Map<string, string>): void {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return;

  // Only non-abstract aggregates have a `create` factory + repository.
  const seedable = new Set(ctx.aggregates.filter((a) => !a.isAbstract).map((a) => a.name));

  // Create-input field types per aggregate, so a seed literal can coerce to
  // its declared type (datetime string → `new Date(…)`).
  const typesByAgg = new Map<string, Map<string, TypeIR>>(
    ctx.aggregates.map((a) => [
      a.name,
      new Map(forCreateInput(a.fields).map((f) => [f.name, f.type] as const)),
    ]),
  );

  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  for (const ds of datasets) {
    const entries = ds.entries.filter((e) => seedable.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(renderDatasetFn(ds.name, entries, typesByAgg));
    callLines.push(`  await seed${upperFirst(ds.name)}(db, requested);`);
  }
  if (callLines.length === 0) return;

  const body = lines(...fnBlocks);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  out.set(
    "db/seed.ts",
    renderSeedFile(body, callLines, usedAggregates(datasets, seedable), voEnumNames),
  );
  out.set("db/seed-cli.ts", renderSeedCliFile());
}

/** Render one `async function seed<Dataset>(db, requested)`. */
function renderDatasetFn(
  dataset: string,
  entries: Entry[],
  typesByAgg: Map<string, Map<string, TypeIR>>,
): string {
  // One repository instance per distinct aggregate used on the domain path.
  const domainAggs = [...new Set(entries.filter((e) => !e.raw).map((e) => e.row.aggregate))];
  const repoDecls = domainAggs.map(
    (a) => `  const ${repoVar(a)} = new ${a}Repository(db, NoopDomainEventDispatcher);`,
  );
  const saveLines = entries.map((e) =>
    e.raw
      ? // raw path (D-SEED-XREF): direct INSERT with explicit id + FK columns.
        `  await db.execute(sql.raw(${JSON.stringify(renderSeedRowInsert(e.row.aggregate, e.row.fields))}));`
      : `  await ${repoVar(e.row.aggregate)}.save(${e.row.aggregate}.create(${renderInput(e.row, typesByAgg.get(e.row.aggregate))}));`,
  );
  return lines(
    `async function seed${upperFirst(dataset)}(db: Db, requested: Set<string>): Promise<void> {`,
    `  if (!datasetEnabled(${JSON.stringify(dataset)}, requested)) return;`,
    `  if (await alreadySeeded(db, ${JSON.stringify(dataset)})) return;`,
    ...repoDecls,
    ...saveLines,
    `  await markSeeded(db, ${JSON.stringify(dataset)});`,
    `}`,
    "",
  );
}

/** `{ field: <expr>, … }` create-input literal from a seed row. */
function renderInput(row: SeedRowIR, types: Map<string, TypeIR> | undefined): string {
  if (row.fields.length === 0) return "{}";
  const entries = row.fields.map((f) => `${f.name}: ${renderField(f.value, types?.get(f.name))}`);
  return `{ ${entries.join(", ")} }`;
}

function renderField(value: ExprIR, type: TypeIR | undefined): string {
  // Seed expressions never reference `this` — the default render context
  // (literals / enum-value / value-object-ctor / money / now()) suffices.
  // A datetime-typed string literal coerces through the Date ctor: the domain
  // `create` takes `createdAt: Date`, not the ISO string.
  const inner = type?.kind === "optional" ? type.inner : type;
  if (
    inner?.kind === "primitive" &&
    inner.name === "datetime" &&
    value.kind === "literal" &&
    value.lit === "string"
  ) {
    return `new Date(${renderTsExpr(value)})`;
  }
  return renderTsExpr(value);
}

function repoVar(agg: string): string {
  return `${lowerFirst(agg)}Repo`;
}

/** Assemble the full `db/seed.ts`, narrowing imports to what the body uses. */
function renderSeedFile(
  body: string,
  callLines: string[],
  aggs: string[],
  voEnumNames: string[],
): string {
  // Strip string/template contents so symbols mentioned only in SQL literals
  // (e.g. the dataset names) don't count as references for import narrowing.
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/`(?:\\.|[^`\\])*`/g, "``");
  const usesDecimal = /\bnew Decimal\(/.test(scan);
  // Value objects + enums live in domain/value-objects.  Intersect the
  // context's declared names against the rendered body so the import is
  // exactly what's used (and never an aggregate/repository class).
  const voEnum = [...new Set(voEnumNames)]
    .filter((n) => new RegExp(`\\b${n}\\b`).test(scan))
    .sort();

  const header = lines(
    "// Auto-generated.  Do not edit by hand.",
    usesDecimal && `import Decimal from "decimal.js";`,
    `import { sql } from "drizzle-orm";`,
    `import type { NodePgDatabase } from "drizzle-orm/node-postgres";`,
    `import * as schema from "./schema";`,
    `import { NoopDomainEventDispatcher } from "../domain/events";`,
    ...aggs.map((a) => `import { ${a} } from "../domain/${lowerFirst(a)}";`),
    ...aggs.map(
      (a) => `import { ${a}Repository } from "./repositories/${lowerFirst(a)}-repository";`,
    ),
    voEnum.length > 0 && `import { ${voEnum.join(", ")} } from "../domain/value-objects";`,
  );

  return (
    lines(
      header,
      "",
      `type Db = NodePgDatabase<typeof schema>;`,
      "",
      "// `default` always runs; other datasets opt in via LOOM_SEED (comma-separated).",
      "function datasetEnabled(dataset: string, requested: Set<string>): boolean {",
      `  return dataset === "default" || requested.has(dataset);`,
      "}",
      "",
      "async function alreadySeeded(db: Db, dataset: string): Promise<boolean> {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${dataset} is a drizzle sql-template parameter in the emitted source
      '  const r = await db.execute(sql`SELECT 1 FROM "__loom_seed" WHERE "dataset" = ${dataset}`);',
      "  return r.rows.length > 0;",
      "}",
      "",
      "async function markSeeded(db: Db, dataset: string): Promise<void> {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${dataset} is a drizzle sql-template parameter in the emitted source
      '  await db.execute(sql`INSERT INTO "__loom_seed" ("dataset") VALUES (${dataset})`);',
      "}",
      "",
      "/** First-boot seed data (database-seeding.md).  Ship-once per dataset via",
      " *  the __loom_seed marker (D-SEED-IDEMPOTENCY); re-runs are no-ops. */",
      "export async function runSeeds(db: Db): Promise<void> {",
      "  await db.execute(",
      '    sql`CREATE TABLE IF NOT EXISTS "__loom_seed" ("dataset" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,',
      "  );",
      "  const requested = new Set(",
      '    (process.env.LOOM_SEED ?? "")',
      '      .split(",")',
      "      .map((s) => s.trim())",
      "      .filter(Boolean),",
      "  );",
      ...callLines,
      "}",
      "",
      body,
    ) + "\n"
  );
}

/** The standalone `npm run db:seed` entry, emitted as its OWN file so the
 *  importable `db/seed.ts` module carries no self-executing code.  The
 *  previous in-module `import.meta.url === pathToFileURL(process.argv[1])`
 *  guard misfired once tsup bundled seed.ts into dist/index.js — there the
 *  module's `import.meta.url` IS the entrypoint, so seeds ran at module
 *  load, BEFORE the top-level migrate, and first boot died on
 *  `relation ... does not exist` (caught live by conformance-parity). */
function renderSeedCliFile(): string {
  return (
    lines(
      "// Auto-generated.  Do not edit by hand.",
      `import { drizzle } from "drizzle-orm/node-postgres";`,
      `import pg from "pg";`,
      `import * as schema from "./schema";`,
      `import { runSeeds } from "./seed";`,
      "",
      "// Standalone seeding (`npm run db:seed`) — the server boot path calls",
      "// the exported `runSeeds(db)` from index.ts instead, after migrations.",
      "async function main(): Promise<void> {",
      "  if (!process.env.DATABASE_URL) {",
      '    throw new Error("DATABASE_URL is required to run seeds.");',
      "  }",
      "  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });",
      "  const db = drizzle(pool, { schema });",
      "  try {",
      "    await runSeeds(db);",
      "  } finally {",
      "    await pool.end();",
      "  }",
      "}",
      "",
      "void main();",
    ) + "\n"
  );
}
