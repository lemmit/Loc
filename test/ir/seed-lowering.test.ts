import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  system S { subdomain M {
    context Catalog {
      enum Status { Draft, Active }
      valueobject Money { amount: decimal  currency: string }
      aggregate Product {
        sku: string
        price: Money
        status: Status
      }
      repository Products for Product { }
      seed demo {
        Product { sku: "DEMO-1", price: { amount: 9.99, currency: "USD" }, status: Draft }
        Product { sku: "DEMO-2", price: { amount: 19.99, currency: "USD" }, status: Active }
      }
    }
  }}
`;

describe("seed — lowering", () => {
  it("lowers a declarative seed dataset onto the context IR", async () => {
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Catalog")!;

    expect(ctx.seeds).toHaveLength(1);
    const seed = ctx.seeds[0];
    expect(seed.dataset).toBe("demo");
    expect(seed.path).toBe("domain");
    expect(seed.rows.map((r) => r.aggregate)).toEqual(["Product", "Product"]);

    const first = seed.rows[0];
    expect(first.fields.map((f) => f.name)).toEqual(["sku", "price", "status"]);

    // String literal field.
    expect(first.fields[0].value).toMatchObject({
      kind: "literal",
      lit: "string",
      value: "DEMO-1",
    });
    // A bare object literal in a value-object-typed create field coerces to a
    // value-object ctor call (not a plain `kind: "object"` expr, which isn't
    // assignable to the VO class) — field-ordered, ready for `new Money(…)`.
    expect(first.fields[1].value).toMatchObject({
      kind: "call",
      callKind: "value-object-ctor",
      name: "Money",
      argNames: ["amount", "currency"],
    });
  });

  it("defaults the dataset name and records the `raw` path", async () => {
    const loom = await buildLoomModel(`
      system S { subdomain M {
        context Catalog {
          aggregate Product { sku: string = "x" }
          repository Products for Product { }
          seed raw {
            Product { sku: "A" }
          }
        }
      }}
    `);
    const ctx = allContexts(loom).find((c) => c.name === "Catalog")!;
    expect(ctx.seeds[0].dataset).toBe("default");
    expect(ctx.seeds[0].path).toBe("raw");
  });
});

describe("seed — raw path lowering", () => {
  it("marks a `raw` block's SeedIR with path: raw", async () => {
    const loom = await buildLoomModel(`
      system S { subdomain M { context C {
        aggregate Widget with crudish { name: string }
        repository Widgets for Widget { }
        seed reference raw { Widget { id: "w1", name: "Alpha" } }
      }}}
    `);
    const seed = allContexts(loom).find((c) => c.name === "C")!.seeds[0];
    expect(seed.path).toBe("raw");
    expect(seed.rows[0].fields.map((f) => f.name)).toEqual(["id", "name"]);
  });
});
