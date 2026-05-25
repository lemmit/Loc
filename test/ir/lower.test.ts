import { describe, expect, it } from "vitest";
import type { AggregateIR, ExprIR } from "../../src/ir/loom-ir.js";
import { allAggregates } from "../../src/ir/loom-ir.js";
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
    expect(fn.body.kind).toBe("binary");
    const body = fn.body as Extract<ExprIR, { kind: "binary" }>;
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
