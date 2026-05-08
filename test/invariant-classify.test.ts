import { describe, expect, it } from "vitest";
import type { ExprIR, InvariantIR } from "../src/ir/loom-ir.js";
import {
  classifyForWire,
  pickErrorPath,
  singleFieldShape,
} from "../src/ir/invariant-classify.js";

// ---------------------------------------------------------------------------
// Pure-function tests for the slice 21.A classifier.  No file system, no
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
    expect(
      classifyForWire(i, { available: new Set(["amount"]) }),
    ).toBe(true);
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
    expect(classifyForWire(inv(helperRef), { available: new Set() })).toBe(
      false,
    );

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
    expect(
      classifyForWire(inv(derivedRef), { available: new Set(["total"]) }),
    ).toBe(false);
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
    expect(
      classifyForWire(i, { available: new Set(["amount"]) }),
    ).toBe(false);
  });

  it("threads through paren / unary / ternary / binary / lambda", () => {
    const guard: ExprIR = {
      kind: "ternary",
      cond: refField("x"),
      then: refField("y"),
      otherwise: litInt(0),
    };
    expect(
      classifyForWire(inv(guard), {
        available: new Set(["x", "y"]),
      }),
    ).toBe(true);
    expect(
      classifyForWire(inv(guard), { available: new Set(["x"]) }),
    ).toBe(false);

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
    expect(
      classifyForWire(inv(lambda), { available: new Set(["xs"]) }),
    ).toBe(true);
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
