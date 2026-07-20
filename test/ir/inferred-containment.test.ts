// `contains` is optional sugar: a value field whose type resolves to a local
// `entity` part IS a containment (`line: OrderLine` ≡ `contains line: OrderLine`),
// because an entity part is owned by its aggregate root, never held by value.
// These tests pin that the inferred form lowers to the exact same IR as the
// explicit one — no scalar-column mis-classification (the pre-optional footgun).

import { describe, expect, it } from "vitest";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const src = (line: string) => `
  context C {
    aggregate Order {
      code: string
      ${line}
      entity OrderLine { sku: string }
    }
    repository Orders for Order { }
  }
`;

async function order(line: string) {
  const loom = await buildLoomModel(src(line));
  const agg = allAggregates(loom).find((a) => a.name === "Order");
  expect(agg, "Order aggregate").toBeDefined();
  return agg!;
}

describe("inferred containment (`contains` optional)", () => {
  it("a bare entity-typed collection field lowers identically to `contains`", async () => {
    const bare = await order("lines: OrderLine[]");
    const explicit = await order("contains lines: OrderLine[]");
    expect(bare.contains).toEqual(explicit.contains);
    expect(bare.contains).toEqual([{ name: "lines", partName: "OrderLine", collection: true }]);
    // …and it is NOT lowered as a value field.
    expect(bare.fields.map((f) => f.name)).not.toContain("lines");
    expect(bare.fields.map((f) => f.name)).toEqual(explicit.fields.map((f) => f.name));
  });

  it("a bare singular entity-typed field is a single (non-collection) containment", async () => {
    const bare = await order("single: OrderLine");
    expect(bare.contains).toEqual([{ name: "single", partName: "OrderLine", collection: false }]);
    expect(bare.fields.map((f) => f.name)).not.toContain("single");
  });

  it("a bare optional entity-typed field carries the optional flag", async () => {
    const bare = await order("single: OrderLine?");
    const explicit = await order("contains single: OrderLine?");
    expect(bare.contains).toEqual(explicit.contains);
    expect(bare.contains[0]).toMatchObject({ name: "single", collection: false, optional: true });
  });

  it("declaration order is preserved when mixing inferred and explicit forms", async () => {
    const agg = await order("a: OrderLine[]\n      contains b: OrderLine[]");
    expect(agg.contains.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("an `X id` reference is NOT reclassified as containment", async () => {
    const loom = await buildLoomModel(`
      context C {
        aggregate Order { code: string  buyer: Customer id }
        aggregate Customer { name: string }
        repository Orders for Order { }
      }
    `);
    const agg = allAggregates(loom).find((a) => a.name === "Order")!;
    expect(agg.contains).toEqual([]);
    expect(agg.fields.map((f) => f.name)).toContain("buyer");
  });
});
