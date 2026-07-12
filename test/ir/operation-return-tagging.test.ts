// Variant-tagging on `return` in a union-returning operation (exception-less.md,
// producer).  Lowering matches each returned value's type to one of the
// operation's `or`-union variants and tags the `return` StmtIR with the wire
// discriminator + shape; the TS renderer emits the tagged value the route will
// dispatch on (`{ type: "NotFound", … }` / `{ type: "String", value: … }`).

import { describe, expect, it } from "vitest";
import { renderTsStatements } from "../../src/generator/typescript/render-stmt.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type StmtIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
  context Shop {
    error NotFound { resource: string }
    aggregate Order {
      code: string
      operation lookup(): string or NotFound {
        return NotFound { resource: code }
        return code
      }
    }
  }
`;

async function returnStmts(): Promise<Extract<StmtIR, { kind: "return" }>[]> {
  const { model } = await parseString(SRC, { validate: false });
  const op = allContexts(lowerModel(model))
    .find((c) => c.name === "Shop")!
    .aggregates.find((a) => a.name === "Order")!
    .operations.find((o) => o.name === "lookup")!;
  return op.statements.filter((s): s is Extract<StmtIR, { kind: "return" }> => s.kind === "return");
}

describe("operation returns — variant tagging (exception-less producer)", () => {
  it("tags an `error`-payload return as a record variant", async () => {
    const [err] = await returnStmts();
    expect(err!.variantTag).toBe("NotFound");
    expect(err!.variantShape).toBe("record");
  });

  it("tags a primitive success return as a scalar variant", async () => {
    const [, ok] = await returnStmts();
    // The wire discriminator for a primitive variant is its type name.
    expect(ok!.variantTag).toBe("string");
    expect(ok!.variantShape).toBe("scalar");
  });

  it("renders the tagged wire shape in TS (record flattens, scalar wraps `value`)", async () => {
    const ts = renderTsStatements(await returnStmts());
    // A record variant flattens its value beside `type` (the value's own
    // construction rendering — payload-as-object emission is a follow-up).
    expect(ts).toContain('return { type: "NotFound", ...(');
    // A scalar variant wraps the value under `value`.
    expect(ts).toContain('return { type: "string", value: this._code };');
  });
});
