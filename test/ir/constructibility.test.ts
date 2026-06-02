// Constructibility gate (Stage 4) — pins the invariant-satisfiability
// rule that decides whether an aggregate with no declared create gets a
// create at all.  An aggregate is constructible iff every invariant can be
// satisfied from the create input alone; an invariant that reaches outside
// the create payload (managed field, derived getter, helper, post-create
// state) makes it non-constructible.  This replaces the old defaults-based
// `isSynthesizedCreate` gate.  See `satisfiableAtConstruction`
// (`src/ir/validate/invariant-classify.ts`) and `isConstructible`
// (`src/ir/enrich/wire-projection.ts`).

import { describe, expect, it } from "vitest";
import { isConstructible } from "../../src/ir/enrich/wire-projection.js";
import type {
  AggregateIR,
  ExprIR,
  FieldAccess,
  FieldIR,
  InvariantIR,
  OperationIR,
  RefKind,
  TypeIR,
} from "../../src/ir/types/loom-ir.js";
import { satisfiableAtConstruction } from "../../src/ir/validate/invariant-classify.js";

const INT: TypeIR = { kind: "primitive", name: "int" };
const STRING: TypeIR = { kind: "primitive", name: "string" };

const ref = (refKind: RefKind, name: string): ExprIR => ({ kind: "ref", refKind, name }) as ExprIR;
const lit = (l: string, v: string): ExprIR => ({ kind: "literal", lit: l, value: v }) as ExprIR;
const bin = (op: string, left: ExprIR, right: ExprIR): ExprIR =>
  ({ kind: "binary", op, left, right }) as ExprIR;
const mem = (receiver: ExprIR, member: string): ExprIR =>
  ({ kind: "member", receiver, member }) as ExprIR;
const inv = (expr: ExprIR, guard?: ExprIR): InvariantIR => ({ expr, guard, source: "test" });

describe("satisfiableAtConstruction", () => {
  const available = new Set(["qty", "name"]);

  it("holds when every reference is a create-input field", () => {
    expect(
      satisfiableAtConstruction(
        inv(bin(">=", ref("this-prop", "qty"), lit("int", "1"))),
        available,
      ),
    ).toBe(true);
    // `name.length >= 3` — member access on an in-input field.
    expect(
      satisfiableAtConstruction(
        inv(bin(">=", mem(ref("this-prop", "name"), "length"), lit("int", "3"))),
        available,
      ),
    ).toBe(true);
  });

  it("fails when a reference is outside the create input", () => {
    expect(
      satisfiableAtConstruction(
        inv(bin(">=", ref("this-prop", "balance"), lit("int", "0"))),
        available,
      ),
    ).toBe(false);
  });

  it("gates derived getters, helpers, bare this, id, and resources", () => {
    expect(satisfiableAtConstruction(inv(ref("this-derived", "display")), available)).toBe(false);
    expect(satisfiableAtConstruction(inv(ref("helper-fn", "compute")), available)).toBe(false);
    expect(satisfiableAtConstruction(inv(ref("resource", "files")), available)).toBe(false);
    expect(satisfiableAtConstruction(inv({ kind: "this" } as ExprIR), available)).toBe(false);
    expect(satisfiableAtConstruction(inv({ kind: "id" } as ExprIR), available)).toBe(false);
  });

  it("allows values the factory already holds server-side", () => {
    // money operand — fine at construction (Decimal in hand), unlike wire.
    expect(
      satisfiableAtConstruction(
        inv(bin(">=", ref("this-prop", "qty"), lit("money", "0"))),
        available,
      ),
    ).toBe(true);
    expect(satisfiableAtConstruction(inv(lit("now", "now()")), available)).toBe(true);
    expect(satisfiableAtConstruction(inv(ref("current-user", "user")), available)).toBe(true);
    expect(satisfiableAtConstruction(inv(ref("enum-value", "Active")), available)).toBe(true);
  });

  it("fails the whole invariant when its guard is unsatisfiable", () => {
    expect(
      satisfiableAtConstruction(
        inv(bin(">=", ref("this-prop", "qty"), lit("int", "1")), ref("this-derived", "x")),
        available,
      ),
    ).toBe(false);
  });
});

function field(name: string, type: TypeIR, access: FieldAccess = "editable"): FieldIR {
  return { name, type, optional: false, access } as FieldIR;
}
const agg = (over: Partial<AggregateIR>): AggregateIR => over as AggregateIR;

describe("isConstructible", () => {
  it("a declared create wins regardless of invariants", () => {
    expect(
      isConstructible(
        agg({
          canonicalCreate: {} as OperationIR,
          fields: [],
          invariants: [inv(ref("this-derived", "x"))],
        }),
      ),
    ).toBe(true);
  });

  it("no create + no invariants → constructible (vacuous)", () => {
    expect(
      isConstructible(
        agg({ canonicalCreate: null, fields: [field("name", STRING)], invariants: [] }),
      ),
    ).toBe(true);
  });

  it("no create + invariant over a create-input field → constructible", () => {
    expect(
      isConstructible(
        agg({
          canonicalCreate: null,
          fields: [field("qty", INT)],
          invariants: [inv(bin(">=", ref("this-prop", "qty"), lit("int", "1")))],
        }),
      ),
    ).toBe(true);
  });

  it("no create + invariant over a managed (non-input) field → not constructible", () => {
    expect(
      isConstructible(
        agg({
          canonicalCreate: null,
          fields: [field("balance", INT, "managed")],
          invariants: [inv(bin(">=", ref("this-prop", "balance"), lit("int", "0")))],
        }),
      ),
    ).toBe(false);
  });
});
