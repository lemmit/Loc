// A single-result find (`find x(): T?`) hydrates the row it already selected
// instead of re-fetching it via `findById(rootRows[0].id)` — dropping a
// redundant root round-trip on every find-by-field call.  Mirrors the
// array/paged branches, which already hydrate straight from `rootRows`.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Inventory {
    aggregate Warehouse ids guid {
      code: string
      region: string
      contains bays: Bay[]
      entity Bay { label: string }
    }
    aggregate Sku ids guid { name: string }
    repository Warehouses for Warehouse {
      find byCode(code: string): Warehouse? where this.code == code
    }
    repository Skus for Sku {
      find byName(name: string): Sku? where this.name == name
    }
  }
`;

describe("typescript generator — single-result find hydrates in place", () => {
  it("does NOT re-fetch via findById; hydrates from the selected row", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);

    const warehouses = files.get("db/repositories/warehouse-repository.ts")!;
    // The redundant re-fetch is gone.
    expect(warehouses).not.toContain("await this.findById(rootRows[0]!.id");
    // The row in hand is hydrated directly, and its containment is bulk-loaded
    // off the same rows (mirroring the array branch).
    expect(warehouses).toContain("const rootIds = rootRows.map((r) => r.id);");
    expect(warehouses).toMatch(/const result = Warehouse\._rehydrate\(\{[\s\S]*rootRows\[0\]!/);
    expect(warehouses).toContain('find: "byCode", rows: 1');

    // A child-less aggregate becomes a single query (no rootIds / bulk-load).
    const skus = files.get("db/repositories/sku-repository.ts")!;
    expect(skus).not.toContain("await this.findById(rootRows[0]!.id");
    expect(skus).toMatch(/const result = Sku\._rehydrate\(\{[\s\S]*rootRows\[0\]!/);
    expect(skus).not.toContain("const rootIds");
  });
});
