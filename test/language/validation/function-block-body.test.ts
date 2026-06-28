// Validator coverage for the `function` block body (domain-services.md rev. 4).
// The AST-layer checks type the block's pure statement subset (let bindings,
// precondition / requires bool gates) and validate each `return`'s value
// against the declared return type; a block with no `return` is rejected
// (loom.function-block-no-return).  The IR-layer purity / non-queryability
// gate (loom.function-block-impure, loom.find-where-not-queryable) is covered
// in test/ir/function-block-body.test.ts.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const ctx = (fn: string) => `
  context Sales {
    aggregate Cart {
      weight: decimal
      surcharge: decimal
      domestic: bool
      ${fn}
    }
    repository Carts for Cart { }
  }
`;

describe("validator — function block body", () => {
  it("accepts a well-typed pure block body", async () => {
    const { errors } = await parseString(
      ctx(`
        function shippingFor(extra: decimal): decimal {
          let base = weight
          precondition base >= 0
          return (domestic ? base : base + surcharge) + extra
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a block body whose `return` mismatches the declared type", async () => {
    const { errors } = await parseString(
      ctx(`
        function bad(): decimal {
          return domestic
        }
      `),
    );
    expect(errors.join("\n")).toMatch(/returns 'bool' but is declared to return 'decimal'/);
  });

  it("rejects a non-bool precondition in a block body", async () => {
    const { errors } = await parseString(
      ctx(`
        function bad(): decimal {
          precondition weight
          return weight
        }
      `),
    );
    expect(errors.join("\n")).toMatch(/'precondition' must be of type 'bool'/);
  });

  it("rejects a block body with no `return`", async () => {
    const { errors } = await parseString(
      ctx(`
        function bad(): decimal {
          let base = weight
        }
      `),
    );
    expect(errors.join("\n")).toMatch(/must 'return' a value/);
  });
});
