// Cross-backend render pin for variant-`match` (variant-match.md).
//
// Constructs the lowered `match` ExprIR a `match outcome { A a => a.code,
// NF n => n.detail }` over an `A or NF` union lowers to, and asserts each
// backend renders its native discriminated-dispatch shape.  These are pure
// string-emission unit tests (no IO) — the lowest altitude that catches a
// per-backend variant-match regression.  Mirrors render-expr-kinds.test.ts.

import { describe, expect, it } from "vitest";
import { renderCsExpr } from "../../src/generator/dotnet/render-expr.js";
import { renderExpr as renderElixirExpr } from "../../src/generator/elixir/render-expr.js";
import { renderJavaExpr } from "../../src/generator/java/render-expr.js";
import { renderPyExpr } from "../../src/generator/python/render-expr.js";
import { renderTsExpr } from "../../src/generator/typescript/render-expr.js";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };
const A: TypeIR = { kind: "entity", name: "A" };
const NF: TypeIR = { kind: "entity", name: "NF" };

// `<binding>.<field>` where the receiver is the variant binding.
const fieldOf = (binding: string, field: string): ExprIR => ({
  kind: "member",
  receiver: { kind: "ref", name: binding, refKind: "match-binding" },
  member: field,
  receiverType: A,
  memberType: STRING,
});

// `match outcome { A a => a.code, NF n => n.detail }` (NF is an `error`).
const MATCH: ExprIR = {
  kind: "match",
  arms: [],
  subject: { kind: "ref", name: "outcome", refKind: "let" },
  subjectType: { kind: "union", variants: [A, NF] },
  variantArms: [
    { varType: A, binding: "a", value: fieldOf("a", "code"), isError: false },
    { varType: NF, binding: "n", value: fieldOf("n", "detail"), isError: true },
  ],
  otherwise: undefined,
};

describe("variant-match — per-backend rendering", () => {
  it("TS: discriminated-union conditional, binding aliased to the scrutinee", () => {
    expect(renderTsExpr(MATCH)).toBe('(outcome.type === "A" ? outcome.code : outcome.detail)');
  });

  it("Python: conditional on the tagged dict, cast subscript reads", () => {
    expect(renderPyExpr(MATCH)).toBe(
      '(cast(str, outcome["code"]) if outcome["type"] == "A" else cast(str, outcome["detail"]))',
    );
  });

  it("Java: sealed-union switch expression with record-pattern bindings", () => {
    const out = renderJavaExpr(MATCH);
    expect(out).toContain("switch (outcome)");
    expect(out).toContain("case AOrNF_A a -> a.code();");
    expect(out).toContain("case AOrNF_NF n -> n.detail();");
    expect(out).toContain("default -> null;");
  });

  it(".NET: switch expression with type patterns, throwing discard arm", () => {
    const out = renderCsExpr(MATCH);
    expect(out).toContain("outcome switch");
    expect(out).toContain("AOrNF_A a => a.Code,");
    expect(out).toContain("AOrNF_NF n => n.Detail,");
    expect(out).toContain("_ => throw");
  });

  it("Elixir: case over the asymmetric {:ok,…}/{:error,tag,…} tuple", () => {
    const out = renderElixirExpr(MATCH, { thisName: "record", contextModule: "MyApp" });
    expect(out).toContain("case outcome do");
    expect(out).toContain("{:ok, a} -> a.code");
    expect(out).toContain('{:error, "NF", n} -> n.detail');
  });

  it("Java: binderless arm gets a named throwaway binder, never `_` (preview-only on JDK 21)", () => {
    const binderless: ExprIR = {
      ...MATCH,
      variantArms: [
        {
          varType: A,
          binding: undefined,
          value: { kind: "literal", lit: "string", value: "yes" },
          isError: false,
        },
        { varType: NF, binding: "n", value: fieldOf("n", "detail"), isError: true },
      ],
    };
    const out = renderJavaExpr(binderless);
    expect(out).toContain('case AOrNF_A __unused -> "yes";');
    expect(out).not.toMatch(/ _ ->/);
  });
});
