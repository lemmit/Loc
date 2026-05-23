import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  addContextSource,
  addOperationSource,
} from "../../web/src/builder/system-v2/add-extra.js";
import { parseRaw as parse } from "../_helpers/index.js";

const SRC = `system S {
  module Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
}`;

describe("v2 add helpers — addContextSource / addOperationSource", () => {
  it("adds a context to the named module", () => {
    const next = addContextSource(SRC, "Sales")!;
    expect(next).not.toBeNull();
    expect(next).toContain("context Context1 {");
    // Containing module should still be intact.
    expect(next).toMatch(/module Sales \{[\s\S]*context Orders[\s\S]*context Context1[\s\S]*\}/);
  });

  it("returns null for an unknown module", () => {
    expect(addContextSource(SRC, "Nope")).toBeNull();
  });

  it("adds an operation to the named aggregate", () => {
    const next = addOperationSource(SRC, "Order")!;
    expect(next).not.toBeNull();
    expect(next).toContain("operation op1()");
    // The new op lives inside Order's block.
    const ast = parse(next);
    let foundUnderOrder = false;
    for (const n of AstUtils.streamAst(ast)) {
      if (n.$type === "Operation" && (n as { name: string }).name === "op1") {
        let p = n.$container;
        while (p) {
          if (p.$type === "Aggregate" && (p as { name?: string }).name === "Order") {
            foundUnderOrder = true;
            break;
          }
          p = p.$container;
        }
      }
    }
    expect(foundUnderOrder).toBe(true);
  });

  it("returns null for an unknown aggregate", () => {
    expect(addOperationSource(SRC, "Nope")).toBeNull();
  });
});
