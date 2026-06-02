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
    // Value-object object-literal field lowers to a `kind: "object"` expr.
    expect(first.fields[1].value).toMatchObject({ kind: "object" });
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

describe("seed — @handle topological lowering", () => {
  const HANDLE_SRC = `
    system S { subdomain M {
      context Sales {
        aggregate Customer with crudish { name: string }
        aggregate Order with crudish { customerId: Customer id status: string }
        repository Customers for Customer { }
        repository Orders for Order { }
        seed demo {
          Order { customerId: @acme, status: "new" }
          Customer @acme { name: "Acme" }
        }
      }
    }}
  `;

  it("reorders rows so a @handle binding precedes its reference, and lowers @ref to seed-ref", async () => {
    const loom = await buildLoomModel(HANDLE_SRC);
    const seed = allContexts(loom).find((c) => c.name === "Sales")!.seeds[0];

    // Topo: the Customer @acme row (written second) is emitted first.
    expect(seed.rows.map((r) => r.aggregate)).toEqual(["Customer", "Order"]);
    expect(seed.rows[0].handle).toBe("acme");

    // The Order row's customerId references the handle via a seed-ref ExprIR.
    const order = seed.rows[1];
    const customerId = order.fields.find((f) => f.name === "customerId")!;
    expect(customerId.value).toMatchObject({ kind: "seed-ref", handle: "acme" });
  });
});
