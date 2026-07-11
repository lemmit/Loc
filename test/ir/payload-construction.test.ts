// Payload construction lowers to a structural object literal
// (exception-less.md, producer).  A payload is a record, not a class, so
// `NotFound { resource: … }` lowers to an `object` ExprIR (not a constructor
// `call`) and renders as a plain object literal — which lets a tagged
// `return <Error> { … }` emit valid, compiling code.

import { describe, expect, it } from "vitest";
import { renderTsStatements } from "../../src/generator/typescript/render-stmt.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type ExprIR, type StmtIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order {
      code: string
      operation lookup(): string or NotFound {
        return NotFound { resource: code }
      }
    }
  }
`;

async function returnValue(): Promise<ExprIR> {
  const { model } = await parseString(SRC, { validate: false });
  const op = allContexts(lowerModel(model))
    .find((c) => c.name === "Shop")!
    .aggregates.find((a) => a.name === "Order")!
    .operations.find((o) => o.name === "lookup")!;
  const ret = op.statements.find(
    (s): s is Extract<StmtIR, { kind: "return" }> => s.kind === "return",
  )!;
  return ret.value;
}

describe("payload construction — structural object (exception-less producer)", () => {
  it("lowers a payload construction to an `object` ExprIR, not a constructor call", async () => {
    const v = await returnValue();
    expect(v.kind).toBe("object");
    expect((v as Extract<ExprIR, { kind: "object" }>).fields.map((f) => f.name)).toEqual([
      "resource",
    ]);
  });

  it("renders the tagged record return as a plain object literal", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const op = allContexts(lowerModel(model))
      .find((c) => c.name === "Shop")!
      .aggregates.find((a) => a.name === "Order")!
      .operations.find((o) => o.name === "lookup")!;
    const ts = renderTsStatements(op.statements);
    expect(ts).toContain('return { type: "NotFound", ...(({ resource: this._code })) };');
  });
});
