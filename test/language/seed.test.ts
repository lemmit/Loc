import { describe, expect, it } from "vitest";
import { parseString } from "../_helpers/index.js";

const wrap = (body: string) =>
  `system S { subdomain M { context C {
    ${body}
  }}}`;

describe("seed — parsing", () => {
  it("parses a named declarative seed dataset", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed demo {
          Product { sku: "DEMO-1" }
          Product { sku: "DEMO-2" }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("parses an anonymous (default-dataset) seed and the `raw` modifier", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed raw {
          Product { sku: "A" }
        }
      `),
    );
    expect(errors).toEqual([]);
  });
});

describe("seed — validation (negative)", () => {
  it("flags a duplicate field within one row", async () => {
    const { errors } = await parseString(
      wrap(`
        aggregate Product { sku: string = "x" }
        repository Products for Product { }
        seed demo {
          Product { sku: "A", sku: "B" }
        }
      `),
    );
    expect(errors.some((e) => /Duplicate field 'sku'/.test(e))).toBe(true);
  });

  it("flags a seed row that references an aggregate from another context", async () => {
    const { errors } = await parseString(
      `system S { subdomain M {
        context Other {
          aggregate Widget { name: string = "x" }
          repository Widgets for Widget { }
        }
        context Home {
          aggregate Thing { name: string = "x" }
          repository Things for Thing { }
          seed demo {
            Widget { name: "nope" }
          }
        }
      }}`,
    );
    expect(errors.some((e) => /may only populate aggregates of its own context/.test(e))).toBe(
      true,
    );
  });
});

describe("seed — raw explicit-id path", () => {
  const base = `
    enum St { Draft, Done }
    aggregate Customer with crudish { name: string }
    aggregate Order with crudish { customerId: Customer id status: St }
    repository Customers for Customer { }
    repository Orders for Order { }
  `;

  it("parses a `raw` dataset with explicit id + literal FK columns", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed reference raw {
          Customer { id: "c1", name: "Acme" }
          Order { id: "o1", customerId: "c1", status: Draft }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("flags an explicit `id` on the (non-raw) domain path", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Customer { id: "c1", name: "Acme" }
        }
      `),
    );
    expect(errors.some((e) => /explicit `id` requires `seed raw/.test(e))).toBe(true);
  });

  it("flags a value-object column on a raw row", async () => {
    const { errors } = await parseString(
      wrap(`
        valueobject Money { amount: decimal  currency: string }
        aggregate Product with crudish { price: Money }
        repository Products for Product { }
        seed reference raw {
          Product { id: "p1", price: Money { amount: 1.0, currency: "USD" } }
        }
      `),
    );
    expect(errors.some((e) => /raw rows\s+support scalar/.test(e))).toBe(true);
  });
});
