// `bodyTypeOf` — the SHARED lambda-body type probe (`src/util/expr-body-type.ts`)
// every backend's money/decimal collection-op dispatch reads.
//
// The `binary` arm is audit finding A5: without it an ARITHMETIC lambda body
// (`sum(l => l.price * l.qty)` — the canonical order total) typed as
// `undefined`, so node/python/elixir all fell back to "not money" and emitted a
// numeric fold over Decimals.  Java carried a private duplicate probe that DID
// handle `binary`; it was deleted and routed here, so this file is now the one
// place the behaviour is pinned for all five backends.

import { describe, expect, it } from "vitest";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import { bodyTypeOf } from "../../src/util/expr-body-type.js";

const MONEY: TypeIR = { kind: "primitive", name: "money" };
const INT: TypeIR = { kind: "primitive", name: "int" };
const BOOL: TypeIR = { kind: "primitive", name: "bool" };

const member = (name: string, memberType: TypeIR): ExprIR => ({
  kind: "member",
  receiver: { kind: "ref", name: "l", refKind: "lambda" },
  member: name,
  receiverType: { kind: "entity", name: "LineItem" },
  memberType,
});

describe("bodyTypeOf — binary arm (A5)", () => {
  it("types `money * int` from resultType — the canonical order-total body", () => {
    const body: ExprIR = {
      kind: "binary",
      op: "*",
      left: member("price", MONEY),
      right: member("qty", INT),
      leftType: MONEY,
      rightType: INT,
      resultType: MONEY,
    };
    expect(bodyTypeOf(body)).toEqual(MONEY);
  });

  it("falls back to leftType when a synthetic binary carries no resultType", () => {
    const body: ExprIR = {
      kind: "binary",
      op: "+",
      left: member("price", MONEY),
      right: member("price", MONEY),
      leftType: MONEY,
    };
    expect(bodyTypeOf(body)).toEqual(MONEY);
  });

  it("types a comparison body as its resultType (bool), not its operands", () => {
    const body: ExprIR = {
      kind: "binary",
      op: ">",
      left: member("qty", INT),
      right: { kind: "literal", lit: "int", value: "0" },
      leftType: INT,
      rightType: INT,
      resultType: BOOL,
    };
    expect(bodyTypeOf(body)).toEqual(BOOL);
  });

  it("sees through parens to a nested arithmetic body", () => {
    const inner: ExprIR = {
      kind: "binary",
      op: "*",
      left: member("price", MONEY),
      right: member("qty", INT),
      resultType: MONEY,
    };
    expect(bodyTypeOf({ kind: "paren", inner })).toEqual(MONEY);
  });
});

describe("bodyTypeOf — unary arm (A11)", () => {
  it("`-money` keeps the operand's type — the money-negation probe", () => {
    expect(bodyTypeOf({ kind: "unary", op: "-", operand: member("price", MONEY) })).toEqual(MONEY);
  });

  it("`!x` is bool regardless of the operand", () => {
    expect(bodyTypeOf({ kind: "unary", op: "!", operand: member("flag", BOOL) })).toEqual(BOOL);
  });
});

describe("bodyTypeOf — shapes it deliberately declines to type", () => {
  it("returns undefined for a method-call body (no result type on the node)", () => {
    // `l.price.abs()` — `MethodCallExpr` carries `receiverType` but no result
    // type, so callers keep their element-type fallback rather than guess.
    expect(
      bodyTypeOf({
        kind: "method-call",
        receiver: member("price", MONEY),
        member: "abs",
        args: [],
        receiverType: MONEY,
        isCollectionOp: false,
      }),
    ).toBeUndefined();
  });
});
