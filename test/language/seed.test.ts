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

describe("seed — @handle cross-row references", () => {
  const base = `
    aggregate Customer with crudish { name: string }
    aggregate Order with crudish { customerId: Customer id status: string }
    repository Customers for Customer { }
    repository Orders for Order { }
  `;

  it("parses a `@handle` binding and a forward `@ref` (topo-resolved)", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Order { customerId: @acme, status: "new" }
          Customer @acme { name: "Acme" }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("flags an unresolved `@ref`", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Order { customerId: @ghost, status: "new" }
          Customer @acme { name: "Acme" }
        }
      `),
    );
    expect(errors.some((e) => /'@ghost' does not match any '@handle'/.test(e))).toBe(true);
  });

  it("flags a duplicate `@handle`", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Customer @acme { name: "A" }
          Customer @acme { name: "B" }
        }
      `),
    );
    expect(errors.some((e) => /Duplicate seed handle '@acme'/.test(e))).toBe(true);
  });

  it("flags a `@handle` reference cycle", async () => {
    const { errors } = await parseString(
      wrap(`${base}
        seed demo {
          Customer @a { name: "A" }
          Order @b { customerId: @a, status: "x" }
          Customer @c { name: @b }
        }
      `).replace('Customer @a { name: "A" }', "Customer @a { name: @c }"),
    );
    expect(errors.some((e) => /reference cycle/.test(e))).toBe(true);
  });
});
