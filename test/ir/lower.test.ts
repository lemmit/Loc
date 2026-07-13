import { describe, expect, it } from "vitest";
import type { AggregateIR, ExprIR } from "../../src/ir/types/loom-ir.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

// The lowering layer's job is to fully resolve names so backends never
// re-resolve.  These tests assert that contract directly on the IR:
// every ref carries a refKind, every call a callKind, every collection
// operation an isCollectionOp flag.

const SRC = `
  context Shop {
    enum OS { Draft, Confirmed }
    aggregate Order {
      status: OS
      contains lines: OrderLine[]
      derived lineCount: int = lines.count
      function isMutable(): bool = status == Draft
      operation addLine(qty: int) {
        precondition isMutable()
        lines += OrderLine { quantity: qty }
      }
      entity OrderLine { quantity: int  invariant quantity > 0 }
    }
    repository Orders for Order { }
  }
`;

async function orderAggregate(): Promise<AggregateIR> {
  const loom = await buildLoomModel(SRC);
  const order = allAggregates(loom).find((a) => a.name === "Order");
  expect(order, "Order aggregate").toBeDefined();
  return order!;
}

const asRef = (e: ExprIR) => {
  expect(e.kind).toBe("ref");
  return e as Extract<ExprIR, { kind: "ref" }>;
};

describe("lowering — name resolution metadata", () => {
  it("resolves a `this-prop` reference and an `enum-value` reference in a function body", async () => {
    const order = await orderAggregate();
    const fn = order.functions.find((f) => f.name === "isMutable")!;
    // Expression form lowers to the `{ expr }` body variant (domain-services.md
    // rev. 4 — the block form lowers to `{ stmts }`).
    expect("expr" in fn.body).toBe(true);
    const expr = (fn.body as { expr: ExprIR }).expr;
    expect(expr.kind).toBe("binary");
    const body = expr as Extract<ExprIR, { kind: "binary" }>;
    expect(body.op).toBe("==");
    expect(asRef(body.left).refKind).toBe("this-prop");
    expect(asRef(body.left).name).toBe("status");
    expect(asRef(body.right).refKind).toBe("enum-value");
    expect(asRef(body.right).name).toBe("Draft");
  });

  it("resolves a precondition call to a declared function as callKind `function`", async () => {
    const order = await orderAggregate();
    const addLine = order.operations.find((o) => o.name === "addLine")!;
    const pre = addLine.statements.find((s) => s.kind === "precondition")!;
    expect(pre.kind).toBe("precondition");
    const call = (pre as Extract<typeof pre, { kind: "precondition" }>).expr;
    expect(call.kind).toBe("call");
    const c = call as Extract<ExprIR, { kind: "call" }>;
    expect(c.callKind).toBe("function");
    expect(c.name).toBe("isMutable");
  });

  it("resolves a `param` reference inside a collection-add statement", async () => {
    const order = await orderAggregate();
    const addLine = order.operations.find((o) => o.name === "addLine")!;
    const add = addLine.statements.find((s) => s.kind === "add")!;
    expect(add.kind).toBe("add");
    const stmt = add as Extract<typeof add, { kind: "add" }>;
    expect(stmt.target.segments).toEqual(["lines"]);
    const value = stmt.value as Extract<ExprIR, { kind: "new" }>;
    expect(value.kind).toBe("new");
    expect(value.partName).toBe("OrderLine");
    const qty = value.fields.find((f) => f.name === "quantity")!;
    expect(asRef(qty.value).refKind).toBe("param");
    expect(asRef(qty.value).name).toBe("qty");
  });

  it("types a `.count` member access against an array receiver", async () => {
    const order = await orderAggregate();
    const derived = order.derived.find((d) => d.name === "lineCount")!;
    expect(derived.expr.kind).toBe("member");
    const m = derived.expr as Extract<ExprIR, { kind: "member" }>;
    expect(m.member).toBe("count");
    // Receiver `lines` resolves to a containment array — the typing the
    // backends rely on to lower `.count` to `.length` without re-resolving.
    expect(m.receiverType.kind).toBe("array");
    expect(asRef(m.receiver).name).toBe("lines");
    expect(asRef(m.receiver).refKind).toBe("this-prop");
  });
});

// A4 — collection transformation ops (map/sortBy/distinct/take/skip/join)
// result typing.  Each derived below chains a trailing property op onto the
// transform, so the trailing member node's `receiverType` IS the transform's
// result type — the same handle the `.count` test above reads.
const A4_SRC = `
  context Shop {
    aggregate Order {
      contains lines: OrderLine[]
      derived firstQty: int = lines.map(l => l.qty).first
      derived sortedCount: int = lines.sortBy(l => l.qty).count
      derived takenCount: int = lines.take(2).count
      derived skippedCount: int = lines.skip(1).count
      derived distinctCount: int = lines.map(l => l.sku).distinct.count
      derived labelLen: int = lines.map(l => l.sku).join(", ").length
      entity OrderLine { qty: int  sku: string }
    }
    repository Orders for Order { }
  }
`;

const INT_ARR = { kind: "array", element: { kind: "primitive", name: "int" } };
const STR_ARR = { kind: "array", element: { kind: "primitive", name: "string" } };
const ORDERLINE_ARR = { kind: "array", element: { kind: "entity", name: "OrderLine" } };

describe("lowering — A4 collection-op result types", () => {
  async function derivedExpr(name: string): Promise<Extract<ExprIR, { kind: "member" }>> {
    const loom = await buildLoomModel(A4_SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    const d = order.derived.find((x) => x.name === name)!;
    expect(d, name).toBeDefined();
    expect(d.expr.kind).toBe("member");
    return d.expr as Extract<ExprIR, { kind: "member" }>;
  }

  it("types `map(l => l.qty)` (qty: int) as int[]", async () => {
    // Trailing `.first` reads the map result: its receiver type is the array
    // produced by the map, and the ELEMENT is `int` (the lambda body type) —
    // not the `string` fallback.
    const first = await derivedExpr("firstQty");
    expect(first.member).toBe("first");
    expect(first.receiverType).toEqual(INT_ARR);
  });

  it("keeps `sortBy(λ)` a T[] (element unchanged)", async () => {
    const count = await derivedExpr("sortedCount");
    expect(count.member).toBe("count");
    expect(count.receiverType).toEqual(ORDERLINE_ARR);
  });

  it("keeps `take(n)` a T[]", async () => {
    const count = await derivedExpr("takenCount");
    expect(count.receiverType).toEqual(ORDERLINE_ARR);
  });

  it("keeps `skip(n)` a T[]", async () => {
    const count = await derivedExpr("skippedCount");
    expect(count.receiverType).toEqual(ORDERLINE_ARR);
  });

  it("keeps `distinct` a T[] (over a scalar map projection → string[])", async () => {
    const count = await derivedExpr("distinctCount");
    expect(count.receiverType).toEqual(STR_ARR);
  });

  it("types `join(sep)` as string", async () => {
    // Trailing `.length` (a string member) resolves only if `join` produced a
    // string — its receiver type IS the join result.
    const len = await derivedExpr("labelLen");
    expect(len.member).toBe("length");
    expect(len.receiverType).toEqual({ kind: "primitive", name: "string" });
  });
});

// A4 — reduction ops (min/max) result typing.  min/max return the PROJECTED
// value, OPTIONAL (empty → null): `<λ-body>?`.  `memberType` can only see the
// element type, so the call site refines the result to the LAMBDA-BODY type;
// the same trailing-member handle as above reads it (its `receiverType` IS the
// reduction's result).  A neutral trailing probe (`.p`) keeps the declared type
// a bare `string` fallback — what matters is the receiver it captures.
const MINMAX_SRC = `
  context Shop {
    aggregate Order {
      contains lines: OrderLine[]
      derived minMoney: string = lines.min(l => l.price).p
      derived maxInt: string = lines.max(l => l.qty).p
      derived minAt: string = lines.min(l => l.at).p
      entity OrderLine { qty: int  price: money  at: datetime }
    }
    repository Orders for Order { }
  }
`;

const MONEY_OPT = { kind: "optional", inner: { kind: "primitive", name: "money" } };
const INT_OPT = { kind: "optional", inner: { kind: "primitive", name: "int" } };
const DATETIME_OPT = { kind: "optional", inner: { kind: "primitive", name: "datetime" } };

describe("lowering — A4 reduction (min/max) result types", () => {
  async function reductionRecvType(name: string): Promise<unknown> {
    const loom = await buildLoomModel(MINMAX_SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    const d = order.derived.find((x) => x.name === name)!;
    expect(d, name).toBeDefined();
    expect(d.expr.kind).toBe("member");
    return (d.expr as Extract<ExprIR, { kind: "member" }>).receiverType;
  }

  it("types `min(l => l.price)` (price: money) as money? (optional λ-body)", async () => {
    expect(await reductionRecvType("minMoney")).toEqual(MONEY_OPT);
  });

  it("types `max(l => l.qty)` (qty: int) as int? (optional λ-body)", async () => {
    expect(await reductionRecvType("maxInt")).toEqual(INT_OPT);
  });

  it("types a `min` over a datetime projection as datetime?", async () => {
    expect(await reductionRecvType("minAt")).toEqual(DATETIME_OPT);
  });
});

// A4 — `avg(λ)` DESUGARS during lowering to `count == 0 ? null : sum(λ) / count`
// (it has no renderer).  The numeric type of the fold is `money` when the λ-body
// types as money, else `decimal` (int/long/decimal widen to decimal).  These
// assert the desugared IR SHAPE directly — a ternary over count/sum/count — plus
// the money-preserving vs widen-to-decimal numeric type on the division.
const AVG_SRC = `
  context Shop {
    aggregate Order {
      contains lines: OrderLine[]
      derived avgPrice: money? = lines.avg(l => l.price)
      derived avgQty: decimal? = lines.avg(l => l.qty)
      entity OrderLine { qty: int  price: money }
    }
    repository Orders for Order { }
  }
`;

const MONEY = { kind: "primitive", name: "money" };
const DECIMAL = { kind: "primitive", name: "decimal" };
const INT = { kind: "primitive", name: "int" };

describe("lowering — A4 avg(λ) desugars to count/sum/count", () => {
  async function avgExpr(name: string): Promise<Extract<ExprIR, { kind: "ternary" }>> {
    const loom = await buildLoomModel(AVG_SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order")!;
    const d = order.derived.find((x) => x.name === name)!;
    expect(d, name).toBeDefined();
    expect(d.expr.kind).toBe("ternary");
    return d.expr as Extract<ExprIR, { kind: "ternary" }>;
  }

  it("desugars `avg` to `count == 0 ? null : sum(λ) / count`", async () => {
    const t = await avgExpr("avgPrice");
    // cond: `count == 0`
    expect(t.cond.kind).toBe("binary");
    const cond = t.cond as Extract<ExprIR, { kind: "binary" }>;
    expect(cond.op).toBe("==");
    expect((cond.left as Extract<ExprIR, { kind: "method-call" }>).member).toBe("count");
    expect(cond.right).toEqual({ kind: "literal", lit: "int", value: "0" });
    // then: null
    expect(t.then).toEqual({ kind: "literal", lit: "null", value: "null" });
    // otherwise: `sum(λ) / count`
    expect(t.otherwise.kind).toBe("binary");
    const div = t.otherwise as Extract<ExprIR, { kind: "binary" }>;
    expect(div.op).toBe("/");
    expect((div.left as Extract<ExprIR, { kind: "method-call" }>).member).toBe("sum");
    expect((div.right as Extract<ExprIR, { kind: "method-call" }>).member).toBe("count");
  });

  it("keeps the money numeric type on a money projection (money-preserving fold)", async () => {
    const div = (await avgExpr("avgPrice")).otherwise as Extract<ExprIR, { kind: "binary" }>;
    expect(div.leftType).toEqual(MONEY);
    expect(div.resultType).toEqual(MONEY);
  });

  it("widens an int projection to a decimal numeric type", async () => {
    const div = (await avgExpr("avgQty")).otherwise as Extract<ExprIR, { kind: "binary" }>;
    expect(div.leftType).toEqual(DECIMAL);
    expect(div.resultType).toEqual(DECIMAL);
  });

  it("preserves the money `sum(λ)` projection lambda through the desugar", async () => {
    const div = (await avgExpr("avgPrice")).otherwise as Extract<ExprIR, { kind: "binary" }>;
    const sum = div.left as Extract<ExprIR, { kind: "method-call" }>;
    expect(sum.args).toHaveLength(1);
    expect(sum.args[0]!.kind).toBe("lambda");
    // λ-body is the money member projection.
    const lam = sum.args[0] as Extract<ExprIR, { kind: "lambda" }>;
    expect((lam.body as Extract<ExprIR, { kind: "member" }>).memberType).toEqual(MONEY);
    // int projection keeps its int λ-body (the widening is on the division type).
    const qtyDiv = (await avgExpr("avgQty")).otherwise as Extract<ExprIR, { kind: "binary" }>;
    const qtyLam = (qtyDiv.left as Extract<ExprIR, { kind: "method-call" }>).args[0] as Extract<
      ExprIR,
      { kind: "lambda" }
    >;
    expect((qtyLam.body as Extract<ExprIR, { kind: "member" }>).memberType).toEqual(INT);
  });
});
