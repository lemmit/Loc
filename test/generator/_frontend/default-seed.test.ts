import { describe, expect, it } from "vitest";
import { renderDefaultSeed } from "../../../src/generator/_frontend/default-seed.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// The closed client-evaluable default-seed renderer — the shared core behind
// the scaffolded create/operation form's `defaultValues`.  Constants + enum
// members always render; a `this.<field>` read renders only when a record
// variable is in scope (the per-target opt-in for operation-form seeding).
// ---------------------------------------------------------------------------

const lit = (l: string, value: string): ExprIR => ({ kind: "literal", lit: l, value }) as ExprIR;

describe("renderDefaultSeed — constant subset", () => {
  it("renders string / numeric / bool / null literals", () => {
    expect(renderDefaultSeed(lit("string", "draft"))).toBe('"draft"');
    expect(renderDefaultSeed(lit("int", "3"))).toBe("3");
    expect(renderDefaultSeed(lit("decimal", "1.5"))).toBe("1.5");
    expect(renderDefaultSeed(lit("bool", "true"))).toBe("true");
    expect(renderDefaultSeed(lit("null", "null"))).toBe("null");
  });

  it("renders an enum-member ref as its wire (member-name) string", () => {
    expect(renderDefaultSeed({ kind: "ref", name: "High", refKind: "enum-value" } as ExprIR)).toBe(
      '"High"',
    );
  });

  it("wraps paren / unary over a constant", () => {
    expect(renderDefaultSeed({ kind: "unary", op: "-", operand: lit("int", "1") } as ExprIR)).toBe(
      "-1",
    );
  });

  it("returns null for money / now / a plain ref (fall back to type-zero)", () => {
    expect(renderDefaultSeed(lit("money", "9.99"))).toBeNull();
    expect(renderDefaultSeed(lit("now", "now"))).toBeNull();
    expect(renderDefaultSeed({ kind: "ref", name: "x", refKind: "param" } as ExprIR)).toBeNull();
  });
});

describe("renderDefaultSeed — this-relative (record var)", () => {
  const thisEta: ExprIR = {
    kind: "member",
    member: "eta",
    receiver: { kind: "this" },
  } as ExprIR;

  it("renders this.<field> against the record var when one is in scope", () => {
    expect(renderDefaultSeed(thisEta, { recordVar: "data" })).toBe("data.eta");
  });

  it("falls back (null) for this.<field> with no record var in scope", () => {
    expect(renderDefaultSeed(thisEta)).toBeNull();
  });

  it("does not render a non-this member (e.g. a currentUser claim)", () => {
    const claim: ExprIR = {
      kind: "member",
      member: "tenantId",
      receiver: { kind: "ref", name: "currentUser", refKind: "current-user" },
    } as ExprIR;
    expect(renderDefaultSeed(claim, { recordVar: "data" })).toBeNull();
  });
});
