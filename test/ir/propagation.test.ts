// `?` propagation operator (exception-less.md A2) — surface + lowering +
// type-inference + validation.  `expr?` short-circuits the enclosing function
// on an `error`-marked variant of the operand's `or`-union; emission is gated
// (`loom.propagate-unsupported`) until the per-backend render lands.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type ExprIR, type StmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SRC = (wrapReturn: string) => `
  context Shop {
    error NotFound { resource: string }
    aggregate Order ids guid {
      code: string
      operation reserve(): string or NotFound { return NotFound { resource: code } }
      operation wrap()${wrapReturn} {
        let x = reserve()?
        return x
      }
    }
  }
`;

async function lowerWrap(wrapReturn: string) {
  const { model } = await parseString(SRC(wrapReturn), { validate: false });
  return allContexts(lowerModel(model))
    .find((c) => c.name === "Shop")!
    .aggregates[0]!.operations.find((o) => o.name === "wrap")!;
}

const codes = async (wrapReturn: string): Promise<string[]> => {
  const { model } = await parseString(SRC(wrapReturn), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
};

describe("`?` propagation — surface + lowering", () => {
  it("parses `expr?` in a let-binding", async () => {
    const { errors } = await parseString(SRC(": string or NotFound"), { validate: false });
    expect(errors).toEqual([]);
  });

  it("lowers to a `propagate` ExprIR carrying the operand's error tags", async () => {
    const op = await lowerWrap(": string or NotFound");
    const letStmt = op.statements.find(
      (s): s is Extract<StmtIR, { kind: "let" }> => s.kind === "let",
    )!;
    expect(letStmt.expr.kind).toBe("propagate");
    expect((letStmt.expr as Extract<ExprIR, { kind: "propagate" }>).errorTags).toEqual([
      "NotFound",
    ]);
  });

  it("types the unwrapped binding as the non-error success type", async () => {
    const op = await lowerWrap(": string or NotFound");
    const letStmt = op.statements.find(
      (s): s is Extract<StmtIR, { kind: "let" }> => s.kind === "let",
    )!;
    // `string or NotFound` minus the NotFound error → `string`.
    expect(letStmt.type).toEqual({ kind: "primitive", name: "string" });
  });
});

describe("`?` propagation — validation", () => {
  it("gates emission with `loom.propagate-unsupported` (surface-first)", async () => {
    expect(await codes(": string or NotFound")).toContain("loom.propagate-unsupported");
  });

  it("flags `loom.propagate-incompatible-error` when the enclosing return omits the error", async () => {
    // `wrap()` has no return union, so it can't carry the propagated `NotFound`.
    expect(await codes("")).toContain("loom.propagate-incompatible-error");
  });

  it("does NOT flag incompatible-error when the enclosing return declares the error", async () => {
    // `wrap(): string or NotFound` carries `NotFound`, so propagation is legal
    // (only the surface-first emission gate remains).
    expect(await codes(": string or NotFound")).not.toContain("loom.propagate-incompatible-error");
  });
});
