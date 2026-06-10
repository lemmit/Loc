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

import type { EnrichedBoundedContextIR, ExprIR, SeedRowIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, upperFirst } from "../../../util/naming.js";
import { renderSeedRowInsert } from "../../sql-pg.js";
import { renderTsExpr } from "../render-expr.js";

/** A seed row plus its block's path (domain create vs raw insert). */
interface Entry {
  row: SeedRowIR;
  raw: boolean;
}

/** One dataset's merged entries (across all `seed <dataset>` blocks). */
interface Dataset {
  name: string;
  entries: Entry[];
}

export function emitTypescriptSeeds(ctx: EnrichedBoundedContextIR, out: Map<string, string>): void {
  const datasets = groupByDataset(ctx);
  if (datasets.length === 0) return;

  // Only non-abstract aggregates have a `create` factory + repository.
  const seedable = new Set(ctx.aggregates.filter((a) => !a.isAbstract).map((a) => a.name));

  const fnBlocks: string[] = [];
  const callLines: string[] = [];
  for (const ds of datasets) {
    const entries = ds.entries.filter((e) => seedable.has(e.row.aggregate));
    if (entries.length === 0) continue;
    fnBlocks.push(renderDatasetFn(ds.name, entries));
    callLines.push(`  await seed${upperFirst(ds.name)}(db, requested);`);
  }
  if (callLines.length === 0) return;

  const body = lines(...fnBlocks);
  const voEnumNames = [...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)];
  out.set(
    "db/seed.ts",
    renderSeedFile(body, callLines, usedAggregates(datasets, seedable), voEnumNames),
  );
}

/** Group every `SeedIR` row by dataset, preserving source order + path. */
function groupByDataset(ctx: EnrichedBoundedContextIR): Dataset[] {
  const byName = new Map<string, Dataset>();
  const order: string[] = [];
  for (const seed of ctx.seeds) {
    let ds = byName.get(seed.dataset);
    if (!ds) {
      ds = { name: seed.dataset, entries: [] };
      byName.set(seed.dataset, ds);
      order.push(seed.dataset);
    }
    for (const row of seed.rows) ds.entries.push({ row, raw: seed.path === "raw" });
  }
  return order.map((n) => byName.get(n)!);
}

/** Aggregate names whose domain class/repository are imported — `raw` rows
 *  emit pure SQL and import nothing. */
function usedAggregates(datasets: Dataset[], seedable: Set<string>): string[] {
  const used = new Set<string>();
  for (const ds of datasets) {
    for (const e of ds.entries) {
      if (!e.raw && seedable.has(e.row.aggregate)) used.add(e.row.aggregate);
    }
  }
  return [...used].sort();
}

/** Render one `async function seed<Dataset>(db, requested)`. */
function renderDatasetFn(dataset: string, entries: Entry[]): string {
  // One repository instance per distinct aggregate used on the domain path.
  const domainAggs = [...new Set(entries.filter((e) => !e.raw).map((e) => e.row.aggregate))];
  const repoDecls = domainAggs.map(
    (a) => `  const ${repoVar(a)} = new ${a}Repository(db, NoopDomainEventDispatcher);`,
  );
  const saveLines = entries.map((e) =>
    e.raw
      ? // raw path (D-SEED-XREF): direct INSERT with explicit id + FK columns.
        `  await db.execute(sql.raw(${JSON.stringify(renderSeedRowInsert(e.row.aggregate, e.row.fields))}));`
      : `  await ${repoVar(e.row.aggregate)}.save(${e.row.aggregate}.create(${renderInput(e.row)}));`,
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
function renderInput(row: SeedRowIR): string {
  if (row.fields.length === 0) return "{}";
  const entries = row.fields.map((f) => `${f.name}: ${renderField(f.value)}`);
  return `{ ${entries.join(", ")} }`;
}

function renderField(value: ExprIR): string {
  // Seed expressions never reference `this` — the default render context
  // (literals / enum-value / value-object-ctor / money / now()) suffices.
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
    `import { drizzle } from "drizzle-orm/node-postgres";`,
    `import pg from "pg";`,
    `import { pathToFileURL } from "node:url";`,
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
      "// When run directly (`npm run db:seed`) connect and seed; when imported by",
      "// index.ts the exported `runSeeds(db)` is called against the live pool.",
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
      "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
      "  void main();",
      "}",
    ) + "\n"
  );
}
