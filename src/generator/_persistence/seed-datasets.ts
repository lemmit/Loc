// ---------------------------------------------------------------------------
// Shared seed-dataset spine — the first `_persistence/` seam (M-T9.2).
//
// First-boot seeding (database-seeding.md) groups a context's `SeedIR`
// rows into datasets and derives which aggregates the domain path imports,
// identically across the SQL-relational backends (Hono/Drizzle, .NET/EF,
// FastAPI/SQLAlchemy).  `groupByDataset` and the `Entry`/`Dataset` model
// were byte-for-byte triplicated in each backend's `seed` emitter; this is
// their single home.  The per-backend `renderDatasetFn` framing (the
// `save`/`INSERT` call shape, imports, datetime coercion) stays in each
// emitter — the divergent leaf.
//
// Pure structural derivation over the shared IR (no target-backend IR, no
// upward import): lives at the generator layer, imported *down* by each
// `src/generator/<platform>/emit/seed.ts` — see docs/new-plan/missions/
// M-T9.2-persistence-seam-design.md §Slice 3.
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR, SeedRowIR } from "../../ir/types/loom-ir.js";

/** A seed row plus its block's path (domain create vs raw insert). */
export interface Entry {
  row: SeedRowIR;
  raw: boolean;
}

/** One dataset's merged entries (across all `seed <dataset>` blocks). */
export interface Dataset {
  name: string;
  entries: Entry[];
}

/** Group every `SeedIR` row by dataset, preserving source order + path. */
export function groupByDataset(ctx: EnrichedBoundedContextIR): Dataset[] {
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
export function usedAggregates(datasets: Dataset[], seedable: Set<string>): string[] {
  const used = new Set<string>();
  for (const ds of datasets) {
    for (const e of ds.entries) {
      if (!e.raw && seedable.has(e.row.aggregate)) used.add(e.row.aggregate);
    }
  }
  return [...used].sort();
}
