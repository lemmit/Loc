import { describe, expect, it } from "vitest";
import type { ExprIR, InvariantIR } from "../../src/ir/types/loom-ir.js";
import {
  classifyForWire,
  pickErrorPath,
  singleFieldConstraints,
  singleFieldShape,
} from "../../src/ir/validate/invariant-classify.js";

// ---------------------------------------------------------------------------
// Pure-function tests for the wire-invariant classifier.  No file system, no
// Langium roundtrip — these constructors mirror what the lowering pass
// emits and let us cover edge cases without authoring a `.ddd` per case.
// ---------------------------------------------------------------------------

const IntT = { kind: "primitive" as const, name: "int" as const };
const StrT = { kind: "primitive" as const, name: "string" as const };

const litInt = (n: number): ExprIR => ({
  kind: "literal",
  lit: "int",
  value: String(n),
});

const refField = (name: string): ExprIR => ({
  kind: "ref",
  name,
  refKind: "this-prop",
  type: IntT,
});

const refParam = (name: string, type = IntT): ExprIR => ({
  kind: "ref",
  name,
  refKind: "param",
  type,
});

const lengthOf = (recv: ExprIR): ExprIR => ({
  kind: "member",
  receiver: recv,
  member: "length",
  receiverType: StrT,
  memberType: IntT,
});

const inv = (expr: ExprIR, source = "test"): InvariantIR => ({
  expr,
  source,
});

describe("classifyForWire", () => {
  it("accepts an invariant whose refs are all in the available set", () => {
    const i = inv({
      kind: "binary",
      op: ">=",
      left: refField("amount"),
      right: litInt(0),
    });
    expect(classifyForWire(i, { available: new Set(["amount"]) })).toBe(true);
  });

  it("rejects when an invariant references something outside `available`", () => {
    const i = inv({
      kind: "binary",
      op: ">=",
      left: refField("missing"),
      right: litInt(0),
    });
    expect(classifyForWire(i, { available: new Set(["amount"]) })).toBe(false);
  });

  it("rejects helper-fn / current-user / this-derived refs always", () => {
    const helperRef: ExprIR = {
      kind: "ref",
      name: "isMutable",
      refKind: "helper-fn",
    };
    expect(classifyForWire(inv(helperRef), { available: new Set() })).toBe(false);

    const userRef: ExprIR = {
      kind: "ref",
      name: "currentUser",
      refKind: "current-user",
    };
    expect(classifyForWire(inv(userRef), { available: new Set() })).toBe(false);

    const derivedRef: ExprIR = {
      kind: "ref",
      name: "total",
      refKind: "this-derived",
      type: IntT,
    };
    expect(classifyForWire(inv(derivedRef), { available: new Set(["total"]) })).toBe(false);
  });

  it("rejects @server-only invariants even when the body would translate", () => {
    const i: InvariantIR = {
      ...inv({
        kind: "binary",
        op: ">=",
        left: refField("amount"),
        right: litInt(0),
      }),
      scope: "server-only",
    };
    expect(classifyForWire(i, { available: new Set(["amount"]) })).toBe(false);
  });

  it("threads through paren / unary / ternary / binary / lambda", () => {
    const guard: ExprIR = {
      kind: "ternary",
      cond: refField("x"),
      // biome-ignore lint/suspicious/noThenProperty: the ternary IR node's branch field is named `then`
      then: refField("y"),
      otherwise: litInt(0),
    };
    expect(
      classifyForWire(inv(guard), {
        available: new Set(["x", "y"]),
      }),
    ).toBe(true);
    expect(classifyForWire(inv(guard), { available: new Set(["x"]) })).toBe(false);

    // Lambda introduces a fresh scope.
    const lambda: ExprIR = {
      kind: "method-call",
      receiver: refParam("xs", { kind: "array", element: IntT }),
      member: "all",
      isCollectionOp: true,
      receiverType: { kind: "array", element: IntT },
      args: [
        {
          kind: "lambda",
          param: "x",
          body: {
            kind: "binary",
            op: ">",
            left: { kind: "ref", name: "x", refKind: "lambda" },
            right: litInt(0),
          },
        },
      ],
    };
    expect(classifyForWire(inv(lambda), { available: new Set(["xs"]) })).toBe(true);
  });
});

describe("singleFieldShape", () => {
  it("recognises `f >= N` as min", () => {
    const i = inv({
      kind: "binary",
      op: ">=",
      left: refField("amount"),
      right: litInt(0),
    });
    expect(singleFieldShape(i)).toEqual({
      field: "amount",
      pattern: { kind: "min", n: 0 },
    });
  });

  it("recognises `f > N` as min(N+1)", () => {
    const i = inv({
      kind: "binary",
      op: ">",
      left: refField("qty"),
      right: litInt(0),
    });
    expect(singleFieldShape(i)).toEqual({
      field: "qty",
      pattern: { kind: "min", n: 1 },
    });
  });

  // --- strict bounds on NON-integer fields: exclusive, no `n±1` fold ---
  // (the int-vs-decimal guard bug — `weight > 0.5` must NOT become `min(1.5)`)
  const DecT = { kind: "primitive" as const, name: "decimal" as const };
  const MoneyT = { kind: "primitive" as const, name: "money" as const };
  const litDec = (v: string): ExprIR => ({ kind: "literal", lit: "decimal", value: v });

  it("recognises `f > 0.5` on a DECIMAL field as an EXCLUSIVE min with the raw literal (no +1)", () => {
    const i = inv({
      kind: "binary",
      op: ">",
      left: { ...refField("weight"), type: DecT },
      right: litDec("0.5"),
      leftType: DecT,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "weight",
      pattern: { kind: "min", n: 0.5, exclusive: true },
    });
  });

  it("recognises `f < 2.0` on a DECIMAL field as an EXCLUSIVE max with the raw literal (no -1)", () => {
    const i = inv({
      kind: "binary",
      op: "<",
      left: { ...refField("weight"), type: DecT },
      right: litDec("2.0"),
      leftType: DecT,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "weight",
      pattern: { kind: "max", n: 2, exclusive: true },
    });
  });

  it("keeps `f > N` on an INTEGER field as the inclusive `min(N+1)` fold (byte-identical, no exclusive flag)", () => {
    const i = inv({
      kind: "binary",
      op: ">",
      left: refField("qty"),
      right: litInt(4),
      leftType: IntT,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "qty",
      pattern: { kind: "min", n: 5 },
    });
  });

  it("leaves an inclusive `f >= 0.5` on a DECIMAL field as a plain min (no exclusive flag)", () => {
    const i = inv({
      kind: "binary",
      op: ">=",
      left: { ...refField("weight"), type: DecT },
      right: litDec("0.5"),
      leftType: DecT,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "weight",
      pattern: { kind: "min", n: 0.5 },
    });
  });

  it("treats a strict bound on a MONEY field as exclusive too", () => {
    const i = inv({
      kind: "binary",
      op: ">",
      left: { ...refField("price"), type: MoneyT },
      right: litDec("0.99"),
      leftType: MoneyT,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "price",
      pattern: { kind: "min", n: 0.99, exclusive: true },
    });
  });

  it("does NOT fold two exclusive decimal bounds into `between` (falls through to the faithful refine)", () => {
    const i = inv({
      kind: "binary",
      op: "&&",
      left: {
        kind: "binary",
        op: ">",
        left: { ...refField("weight"), type: DecT },
        right: litDec("0.5"),
        leftType: DecT,
      },
      right: {
        kind: "binary",
        op: "<",
        left: { ...refField("weight"), type: DecT },
        right: litDec("2.0"),
        leftType: DecT,
      },
    });
    // `singleFieldShape` returns null (no `between` fold), but the constraint
    // splitter still yields both exclusive bounds for backends that apply
    // several constraints to one field.
    expect(singleFieldShape(i)).toBeNull();
    expect(singleFieldConstraints(i)).toEqual([
      { field: "weight", pattern: { kind: "min", n: 0.5, exclusive: true } },
      { field: "weight", pattern: { kind: "max", n: 2, exclusive: true } },
    ]);
  });

  it("recognises `f.length == N` as len-eq", () => {
    const i = inv({
      kind: "binary",
      op: "==",
      left: lengthOf(refField("currency")),
      right: litInt(3),
    });
    expect(singleFieldShape(i)).toEqual({
      field: "currency",
      pattern: { kind: "len-eq", n: 3 },
    });
  });

  it("recognises `f.length > 0` as len-min(1)", () => {
    const i = inv({
      kind: "binary",
      op: ">",
      left: lengthOf(refField("sku")),
      right: litInt(0),
    });
    expect(singleFieldShape(i)).toEqual({
      field: "sku",
      pattern: { kind: "len-min", n: 1 },
    });
  });

  it("recognises `f >= N && f <= M` as between", () => {
    const i = inv({
      kind: "binary",
      op: "&&",
      left: {
        kind: "binary",
        op: ">=",
        left: refField("age"),
        right: litInt(18),
      },
      right: {
        kind: "binary",
        op: "<=",
        left: refField("age"),
        right: litInt(150),
      },
    });
    expect(singleFieldShape(i)).toEqual({
      field: "age",
      pattern: { kind: "between", lo: 18, hi: 150 },
    });
  });

  it("returns null for cross-field comparisons", () => {
    const i = inv({
      kind: "binary",
      op: "<",
      left: refField("from"),
      right: refField("to"),
    });
    expect(singleFieldShape(i)).toBeNull();
  });

  it("recognises `f.matches(literal)` as the regex pattern", () => {
    const i = inv({
      kind: "method-call",
      receiver: {
        kind: "ref",
        name: "email",
        refKind: "this-prop",
        type: StrT,
      },
      member: "matches",
      args: [{ kind: "literal", lit: "string", value: "^[^@]+@.+$" }],
      receiverType: StrT,
      isCollectionOp: false,
    });
    expect(singleFieldShape(i)).toEqual({
      field: "email",
      pattern: { kind: "regex", pattern: "^[^@]+@.+$" },
    });
  });

  it("returns null for `matches` with a non-string-literal arg", () => {
    // Validator already rejects this at parse time, but the
    // pattern recogniser should fall through cleanly so a
    // misuse becomes a generic refine rather than a crash.
    const i = inv({
      kind: "method-call",
      receiver: {
        kind: "ref",
        name: "email",
        refKind: "this-prop",
        type: StrT,
      },
      member: "matches",
      args: [{ kind: "ref", name: "userPattern", refKind: "param", type: StrT }],
      receiverType: StrT,
      isCollectionOp: false,
    });
    expect(singleFieldShape(i)).toBeNull();
  });

  it("returns null when the invariant is guarded", () => {
    const i: InvariantIR = {
      ...inv({
        kind: "binary",
        op: ">=",
        left: refField("amount"),
        right: litInt(0),
      }),
      guard: {
        kind: "binary",
        op: "==",
        left: refField("status"),
        right: { kind: "literal", lit: "string", value: "open" },
      },
    };
    expect(singleFieldShape(i)).toBeNull();
  });
});

describe("pickErrorPath", () => {
  it("uses the single-field shape's field when one matches", () => {
    const i = inv({
      kind: "binary",
      op: ">=",
      left: refField("amount"),
      right: litInt(0),
    });
    expect(pickErrorPath(i)).toBe("amount");
  });

  it("falls back to the first field reference for cross-field rules", () => {
    const i = inv({
      kind: "binary",
      op: "<",
      left: refField("from"),
      right: refField("to"),
    });
    expect(pickErrorPath(i)).toBe("from");
  });

  it("returns null when no field reference is reachable", () => {
    const i = inv({
      kind: "binary",
      op: "==",
      left: { kind: "literal", lit: "int", value: "1" },
      right: { kind: "literal", lit: "int", value: "1" },
    });
    expect(pickErrorPath(i)).toBeNull();
  });
});

describe("singleFieldConstraints", () => {
  const strField = (name: string): ExprIR => ({
    kind: "ref",
    name,
    refKind: "this-prop",
    type: StrT,
  });
  const bin = (op: "&&" | ">=" | "<=" | "!=", left: ExprIR, right: ExprIR): ExprIR =>
    ({ kind: "binary", op, left, right }) as unknown as ExprIR;
  const matches = (recv: ExprIR, pattern: string): ExprIR =>
    ({
      kind: "method-call",
      receiver: recv,
      member: "matches",
      args: [{ kind: "literal", lit: "string", value: pattern }],
      receiverType: StrT,
      isCollectionOp: false,
    }) as unknown as ExprIR;

  it("splits a numeric `f >= N && f <= M` into separate min + max constraints", () => {
    const i = inv(
      bin("&&", bin(">=", refField("level"), litInt(1)), bin("<=", refField("level"), litInt(10))),
    );
    expect(singleFieldConstraints(i)).toEqual([
      { field: "level", pattern: { kind: "min", n: 1 } },
      { field: "level", pattern: { kind: "max", n: 10 } },
    ]);
  });

  it("collects both regex AND len-max from `f.matches(r) && f.length <= N` (single field)", () => {
    const i = inv(
      bin(
        "&&",
        matches(strField("email"), "^x$"),
        bin("<=", lengthOf(strField("email")), litInt(120)),
      ),
    );
    expect(singleFieldConstraints(i)).toEqual([
      { field: "email", pattern: { kind: "regex", pattern: "^x$" } },
      { field: "email", pattern: { kind: "len-max", n: 120 } },
    ]);
  });

  it("returns null for a cross-field invariant (not input-derivable)", () => {
    expect(
      singleFieldConstraints(inv(bin("!=", strField("handle"), strField("email")))),
    ).toBeNull();
  });

  it("returns null when any conjunct is not a single-field shape", () => {
    const i = inv(
      bin("&&", bin(">=", refField("level"), litInt(1)), bin("!=", strField("a"), strField("b"))),
    );
    expect(singleFieldConstraints(i)).toBeNull();
  });
});
