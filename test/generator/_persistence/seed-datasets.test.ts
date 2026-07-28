import { describe, expect, it } from "vitest";
import {
  groupByDataset,
  usedAggregates,
} from "../../../src/generator/_persistence/seed-datasets.js";
import type { EnrichedBoundedContextIR, SeedIR } from "../../../src/ir/types/loom-ir.js";

// The shared seed-dataset spine (`_persistence/seed-datasets.ts`) groups a
// context's `SeedIR` rows identically across the three SQL backends
// (Hono/Drizzle, .NET/EF, FastAPI/SQLAlchemy).  It was byte-for-byte
// triplicated before extraction and has no direct test — M-T9.17 slice 1.
//
// `groupByDataset`/`usedAggregates` read only `ctx.seeds`, so a partial
// context cast suffices.

function ctxWith(seeds: SeedIR[]): EnrichedBoundedContextIR {
  return { seeds } as unknown as EnrichedBoundedContextIR;
}

const row = (aggregate: string): SeedIR["rows"][number] => ({ aggregate, fields: [] });

describe("groupByDataset", () => {
  it("groups rows by dataset name, preserving first-seen dataset order", () => {
    const datasets = groupByDataset(
      ctxWith([
        { dataset: "default", path: "domain", rows: [row("Order")] },
        { dataset: "demo", path: "domain", rows: [row("Customer")] },
        { dataset: "default", path: "domain", rows: [row("Product")] },
      ]),
    );

    // Order follows first appearance: default before demo (not alphabetical).
    expect(datasets.map((d) => d.name)).toEqual(["default", "demo"]);
    // Rows from the two `default` blocks merge into one dataset, in source order.
    expect(datasets[0].entries.map((e) => e.row.aggregate)).toEqual(["Order", "Product"]);
    expect(datasets[1].entries.map((e) => e.row.aggregate)).toEqual(["Customer"]);
  });

  it("preserves row order within a single seed block", () => {
    const [ds] = groupByDataset(
      ctxWith([{ dataset: "default", path: "domain", rows: [row("A"), row("B"), row("C")] }]),
    );
    expect(ds.entries.map((e) => e.row.aggregate)).toEqual(["A", "B", "C"]);
  });

  it("marks entries raw iff their seed block's path is `raw`", () => {
    const [ds] = groupByDataset(
      ctxWith([
        { dataset: "default", path: "raw", rows: [row("Ledger")] },
        { dataset: "default", path: "domain", rows: [row("Order")] },
      ]),
    );
    const byAgg = Object.fromEntries(ds.entries.map((e) => [e.row.aggregate, e.raw]));
    expect(byAgg).toEqual({ Ledger: true, Order: false });
  });

  it("returns no datasets when the context has no seeds", () => {
    expect(groupByDataset(ctxWith([]))).toEqual([]);
  });
});

describe("usedAggregates", () => {
  const datasets = groupByDataset(
    ctxWith([
      { dataset: "default", path: "domain", rows: [row("Order"), row("Order"), row("Customer")] },
      { dataset: "default", path: "raw", rows: [row("Ledger")] },
    ]),
  );

  it("returns the sorted, de-duplicated set of seedable non-raw aggregates", () => {
    const seedable = new Set(["Order", "Customer", "Ledger"]);
    // Order appears twice → de-duped; Ledger is raw → excluded (imports nothing).
    expect(usedAggregates(datasets, seedable)).toEqual(["Customer", "Order"]);
  });

  it("excludes aggregates absent from the seedable set", () => {
    // Customer not seedable (e.g. not an aggregate class) → dropped.
    expect(usedAggregates(datasets, new Set(["Order"]))).toEqual(["Order"]);
  });

  it("returns an empty list when nothing is both seedable and domain-pathed", () => {
    expect(usedAggregates(datasets, new Set(["Ledger"]))).toEqual([]);
  });
});
