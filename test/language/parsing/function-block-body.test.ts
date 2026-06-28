// Grammar coverage for the `function` declaration's two body forms
// (domain-services.md rev. 4 — "`function` — let it do a bit more"):
//   - expression form: `function f(p): T = Expression`
//   - block form:      `function f(p): T { Statement* }`
// `'='` vs `'{'` is the discriminator; the AST stays non-recursive.

import { describe, expect, it } from "vitest";
import {
  isAggregate,
  isBoundedContext,
  isFunctionDecl,
} from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

describe("parsing — function block body", () => {
  it("parses both the expression form and the block form on one aggregate", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        aggregate Cart {
          weight: decimal
          surcharge: decimal
          rate: decimal
          domestic: bool

          function lineTotal(): decimal = weight * rate
          function shippingFor(extra: decimal): decimal {
            let base = weight * rate
            precondition base >= 0
            return (domestic ? base : base + surcharge) + extra
          }
        }
        repository Carts for Cart { }
      }
    `);
    expect(errors).toEqual([]);

    const ctx = model.members.find(isBoundedContext)!;
    const cart = ctx.members.find(isAggregate)!;
    const fns = cart.members.filter(isFunctionDecl);
    expect(fns.map((f) => f.name)).toEqual(["lineTotal", "shippingFor"]);

    // Expression form: `body` set, `block` empty.
    const exprFn = fns.find((f) => f.name === "lineTotal")!;
    expect(exprFn.body).toBeDefined();
    expect(exprFn.block).toEqual([]);

    // Block form: `body` absent, `block` carries the statements.
    const blockFn = fns.find((f) => f.name === "shippingFor")!;
    expect(blockFn.body).toBeUndefined();
    expect(blockFn.block.length).toBe(3);
    expect(blockFn.block.map((s) => s.$type)).toEqual([
      "LetStmt",
      "PreconditionStmt",
      "ReturnStmt",
    ]);
  });
});
