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
