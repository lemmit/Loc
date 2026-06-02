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
