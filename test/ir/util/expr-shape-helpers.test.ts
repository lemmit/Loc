import { describe, expect, it } from "vitest";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../../src/ir/util/ref-collection.js";
import { durationCtorOperand, isDatetimeTypedIR } from "../../../src/ir/util/temporal.js";

// Two small structural probes over lowered `ExprIR`, both shared by a validator
// gate AND the backends that emit from the shape the gate admitted.  M-T9.17
// slice 5 — no test calls any of the three exports.
//
// That pairing is what makes them worth pinning: when a gate and an emitter
// disagree about which shapes qualify, the model passes validation and then
// the emitter renders something else (or throws mid-generate).  Both modules
// exist precisely so the two sides consult ONE predicate — so the predicate's
// exact boundary, especially where it deliberately says NO, is the contract.

const prim = (name: string) => ({ kind: "primitive", name }) as never;
const paren = (inner: ExprIR): ExprIR => ({ kind: "paren", inner }) as unknown as ExprIR;
const thisRecv = { kind: "this" } as unknown as ExprIR;

describe("refCollectionFieldName — the `this.<refColl>.contains(x)` receiver", () => {
  const member = (m: string, receiver: ExprIR = thisRecv): ExprIR =>
    ({ kind: "member", receiver, member: m }) as unknown as ExprIR;

  it("names the field behind a `this.<field>` member access", () => {
    expect(refCollectionFieldName(member("tags"))).toBe("tags");
  });

  it("names the field behind a `this-prop` REF — the other lowered spelling", () => {
    // Both spellings reach the same emitters; matching only one would leave the
    // membership subquery unemitted for half the corpus, with no diagnostic.
    expect(
      refCollectionFieldName({ kind: "ref", name: "tags", refKind: "this-prop" } as never),
    ).toBe("tags");
  });

  it("is paren-transparent, at any depth", () => {
    expect(refCollectionFieldName(paren(member("tags")))).toBe("tags");
    expect(refCollectionFieldName(paren(paren(member("tags"))))).toBe("tags");
  });

  it("REFUSES a member on a non-`this` receiver", () => {
    // `other.tags` is not the owner row's collection, so the correlated
    // subquery would join the wrong table.  Returning a name here would emit
    // silently wrong SQL rather than fail.
    const other = { kind: "ref", name: "other", refKind: "let" } as unknown as ExprIR;
    expect(refCollectionFieldName(member("tags", other))).toBeNull();
  });

  it("REFUSES a nested member chain (`this.a.b`)", () => {
    expect(refCollectionFieldName(member("b", member("a")))).toBeNull();
  });

  it("REFUSES a ref of any other refKind, and any other node kind", () => {
    expect(
      refCollectionFieldName({ kind: "ref", name: "tags", refKind: "param" } as never),
    ).toBeNull();
    expect(refCollectionFieldName({ kind: "this" } as never)).toBeNull();
    expect(refCollectionFieldName({ kind: "literal", lit: "int", value: "1" } as never)).toBeNull();
  });
});

describe("durationCtorOperand — DIRECT constructors only", () => {
  const dur: ExprIR = { kind: "duration", amount: "5", unit: "days" } as unknown as ExprIR;

  it("returns the constructor node itself", () => {
    expect(durationCtorOperand(dur)).toBe(dur);
  });

  it("unwraps parens, at any depth", () => {
    expect(durationCtorOperand(paren(dur))).toBe(dur);
    expect(durationCtorOperand(paren(paren(dur)))).toBe(dur);
  });

  it("REFUSES a duration-typed ref — deliberately, not incidentally", () => {
    // The queryable gate admits only the direct constructor form because that
    // is the only shape the Drizzle lowerer turns into `make_interval`.
    // Accepting a `let` ref here would admit a predicate the lowerer then
    // cannot translate — the gate/emitter disagreement this module prevents.
    expect(
      durationCtorOperand({
        kind: "ref",
        name: "d",
        refKind: "let",
        type: prim("duration"),
      } as never),
    ).toBeNull();
  });

  it("REFUSES a `duration ± duration` binary", () => {
    expect(
      durationCtorOperand({ kind: "binary", op: "+", left: dur, right: dur } as never),
    ).toBeNull();
  });
});

describe("isDatetimeTypedIR — a best-effort probe that fails CLOSED", () => {
  it("is true for the `now` literal", () => {
    expect(isDatetimeTypedIR({ kind: "literal", lit: "now", value: "now" } as never)).toBe(true);
  });

  it("reads `memberType` on a member and `type` on a ref", () => {
    expect(
      isDatetimeTypedIR({
        kind: "member",
        receiver: thisRecv,
        member: "placedAt",
        memberType: prim("datetime"),
      } as never),
    ).toBe(true);
    expect(
      isDatetimeTypedIR({
        kind: "ref",
        name: "at",
        refKind: "let",
        type: prim("datetime"),
      } as never),
    ).toBe(true);
  });

  it("reads `resultType` on a lowered binary — not its operands", () => {
    // `datetime + duration` is datetime; `datetime - datetime` is a duration.
    // Inferring from the operands would call the second one datetime-typed.
    expect(
      isDatetimeTypedIR({
        kind: "binary",
        op: "-",
        left: { kind: "literal", lit: "now", value: "now" },
        right: { kind: "literal", lit: "now", value: "now" },
        resultType: prim("duration"),
      } as never),
    ).toBe(false);
  });

  it("is paren-transparent", () => {
    expect(isDatetimeTypedIR(paren({ kind: "literal", lit: "now", value: "now" } as never))).toBe(
      true,
    );
  });

  it("requires BOTH ternary branches to be datetime — an AND, not an OR", () => {
    // The interesting arm.  A ternary whose branches disagree has no single
    // temporal type, and treating it as datetime would push an untranslatable
    // expression past the queryable gate.
    const now = { kind: "literal", lit: "now", value: "now" } as unknown as ExprIR;
    const str = { kind: "literal", lit: "string", value: "x" } as unknown as ExprIR;
    const tern = (then: ExprIR, otherwise: ExprIR): ExprIR =>
      ({ kind: "ternary", cond: str, then, otherwise }) as unknown as ExprIR;
    expect(isDatetimeTypedIR(tern(now, now))).toBe(true);
    expect(isDatetimeTypedIR(tern(now, str))).toBe(false);
    expect(isDatetimeTypedIR(tern(str, now))).toBe(false);
  });

  it("answers FALSE for a synthetic node with no type stamp", () => {
    // Conservative by design: an unstamped node must not be assumed temporal.
    expect(isDatetimeTypedIR({ kind: "member", receiver: thisRecv, member: "x" } as never)).toBe(
      false,
    );
    expect(isDatetimeTypedIR({ kind: "ref", name: "x", refKind: "let" } as never)).toBe(false);
  });

  it("answers FALSE for a non-datetime primitive and for an unhandled kind", () => {
    expect(
      isDatetimeTypedIR({ kind: "ref", name: "n", refKind: "let", type: prim("int") } as never),
    ).toBe(false);
    expect(isDatetimeTypedIR({ kind: "this" } as never)).toBe(false);
  });
});
