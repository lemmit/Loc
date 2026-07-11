// Operation-call return typing (exception-less.md A2 prerequisite).  A call to
// an operation that declares a return type infers that type — including an
// `or`-union for an exception-less op — instead of the `string` placeholder the
// best-effort inferrer used to fall back to.  This is what lets `let x =
// reserve()` type as `string or NotFound`, the operand the `?` propagation
// operator consumes.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type StmtIR, type TypeIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

async function letType(src: string): Promise<TypeIR> {
  const { model } = await parseString(src, { validate: false });
  const op = allContexts(lowerModel(model))
    .find((c) => c.name === "Shop")!
    .aggregates[0]!.operations.find((o) => o.name === "wrap")!;
  const stmt = op.statements.find((s): s is Extract<StmtIR, { kind: "let" }> => s.kind === "let")!;
  return stmt.type;
}

describe("operation-call return typing (A2 prerequisite)", () => {
  it("types a union-returning operation call as its `or`-union", async () => {
    const t = await letType(`
      context Shop {
        error NotFound { resource: string }
        aggregate Order {
          code: string
          operation reserve(): string or NotFound { return NotFound { resource: code } }
          operation wrap() { let x = reserve() }
        }
      }
    `);
    expect(t).toEqual({
      kind: "union",
      variants: [
        { kind: "primitive", name: "string" },
        { kind: "entity", name: "NotFound" },
      ],
    });
  });

  it("types a plain-typed operation call as its declared return type", async () => {
    const t = await letType(`
      context Shop {
        aggregate Order {
          code: string
          operation label(): string { return code }
          operation wrap() { let x = label() }
        }
      }
    `);
    expect(t).toEqual({ kind: "primitive", name: "string" });
  });
});
