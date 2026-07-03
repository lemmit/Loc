// Cross-backend render pin for variant-`match` (variant-match.md).
//
// A variant-`match` narrows a union-returning repository find, and every
// backend represents that find as its OPTIONAL TWIN — the success aggregate,
// with the error variant standing for absence (Hono/Python: a null/`type`
// check; .NET/Java: a `null`/type-pattern switch; Elixir: an
// `{:ok,…}`/`{:error,…}` tuple).  The `<Union>_<Variant>` carrier records are
// NOT emitted for a find, so the match dispatches on the twin, and the error
// arm carries no variant fields (there is no error object — the row is simply
// absent).  This constructs the lowered `match` ExprIR that
// `match outcome { A a => a.code, NF => "gone" }` over an `A or NF` find union
// lowers to, and asserts each backend renders its native shape.  Pure
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

const lit = (value: string): ExprIR => ({ kind: "literal", lit: "string", value });

// `match outcome { A a => a.code, NF => "gone" }` — NF is the `error`
// (absence) variant, so its arm binds nothing and reads no field.
const MATCH: ExprIR = {
  kind: "match",
  arms: [],
  subject: { kind: "ref", name: "outcome", refKind: "let" },
  subjectType: { kind: "union", variants: [A, NF] },
  variantArms: [
    { varType: A, binding: "a", value: fieldOf("a", "code"), isError: false },
    { varType: NF, binding: undefined, value: lit("gone"), isError: true },
  ],
  otherwise: undefined,
};

describe("variant-match — per-backend rendering", () => {
  it("TS: discriminated-union conditional, binding aliased to the scrutinee", () => {
    expect(renderTsExpr(MATCH)).toBe('(outcome.type === "A" ? outcome.code : "gone")');
  });

  it("Python: conditional on the tagged dict, cast subscript reads", () => {
    expect(renderPyExpr(MATCH)).toBe(
      '(cast(str, outcome["code"]) if outcome["type"] == "A" else "gone")',
    );
  });

  it("Java: null/type-pattern switch over the optional twin", () => {
    const out = renderJavaExpr(MATCH);
    expect(out).toContain("switch (outcome)");
    expect(out).toContain('case null -> "gone";');
    expect(out).toContain("case A a -> a.code();");
    // The find never emits the <Union>_<Variant> carriers.
    expect(out).not.toContain("AOrNF_");
  });

  it(".NET: null/type-pattern switch over the optional twin", () => {
    const out = renderCsExpr(MATCH);
    expect(out).toContain("outcome switch");
    expect(out).toContain("A a => a.Code,");
    expect(out).toContain('_ => "gone",');
    expect(out).not.toContain("AOrNF_");
  });

  it("Elixir: case over the asymmetric {:ok,…}/{:error,tag,…} tuple", () => {
    const out = renderElixirExpr(MATCH, { thisName: "record", contextModule: "MyApp" });
    expect(out).toContain("case outcome do");
    expect(out).toContain("{:ok, a} -> a.code");
    expect(out).toContain('{:error, "NF", _} -> "gone"');
  });

  it("Java: binderless success arm gets a named throwaway binder, never `_` (preview-only on JDK 21)", () => {
    const binderless: ExprIR = {
      ...MATCH,
      variantArms: [
        { varType: A, binding: undefined, value: lit("yes"), isError: false },
        { varType: NF, binding: undefined, value: lit("gone"), isError: true },
      ],
    };
    const out = renderJavaExpr(binderless);
    expect(out).toContain('case A __unused -> "yes";');
    expect(out).not.toMatch(/case _ /);
  });
});
