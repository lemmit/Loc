// B9 (full-review-remediation §B9, audit finding 4): a collection-op lambda
// param must be typed at the receiver's ELEMENT type, not a `string`
// placeholder.  Without it, member accesses inside the lambda get the wrong
// receiver/member types and money arithmetic renders as a `String(...)` concat
// with a raw `>` instead of decimal `.plus`/`.gt`.
//
// These pin the fix at BOTH ends: the IR (the lambda body's member access +
// binary carry money types) and the generated TS (money method forms).

import { describe, expect, it } from "vitest";
import type { AggregateIR, ExprIR } from "../../src/ir/types/loom-ir.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { generateDotnet, generateHono } from "../_helpers/generate.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

// A money-typed containment element (`OrderLine.price`) read inside an `any`
// lambda, doing money arithmetic (`+ 10.00`) and a money comparison (`> total`).
const SRC = `
  context Shop {
    aggregate Order {
      total: money
      contains lines: OrderLine[]
      derived expensive: bool = lines.any(l => l.price + 10.00 > total)
      entity OrderLine { price: money }
    }
    repository Orders for Order { }
  }
`;

const asBinary = (e: ExprIR) => {
  expect(e.kind).toBe("binary");
  return e as Extract<ExprIR, { kind: "binary" }>;
};

describe("B9 — collection-op lambda params carry the element type", () => {
  it("types the lambda body's member access + binaries at the element (money) type", async () => {
    const loom = await buildLoomModel(SRC);
    const order = allAggregates(loom).find((a) => a.name === "Order") as AggregateIR;
    const expensive = order.derived.find((d) => d.name === "expensive")!;
    // `lines.any(λ)` — a collection op whose arg is the lambda.
    expect(expensive.expr.kind).toBe("method-call");
    const mc = expensive.expr as Extract<ExprIR, { kind: "method-call" }>;
    expect(mc.member).toBe("any");
    expect(mc.isCollectionOp).toBe(true);
    const lambda = mc.args[0] as Extract<ExprIR, { kind: "lambda" }>;
    expect(lambda.kind).toBe("lambda");
    // Body: `l.price + 10.00 > total`.  Outer `>` — its left is `l.price + 10.00`,
    // typed money because `l` is now the OrderLine element (not a string).
    const cmp = asBinary(lambda.body!);
    expect(cmp.op).toBe(">");
    expect(cmp.leftType).toEqual({ kind: "primitive", name: "money" });
    // Inner `+` — left is `l.price`, a money member on the element.
    const add = asBinary(cmp.left);
    expect(add.op).toBe("+");
    expect(add.leftType).toEqual({ kind: "primitive", name: "money" });
    const priceMember = add.left as Extract<ExprIR, { kind: "member" }>;
    expect(priceMember.kind).toBe("member");
    expect(priceMember.member).toBe("price");
    // The receiver `l` resolves to the OrderLine element, and `.price` is money —
    // the whole point of threading the element type into the lambda env.
    expect(priceMember.receiverType).toEqual({ kind: "entity", name: "OrderLine" });
    expect(priceMember.memberType).toEqual({ kind: "primitive", name: "money" });
  });

  it("renders money `.plus`/`.gt` (not `String(...)` + raw `>`) on Hono/TS", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const order = files.get("domain/order.ts")!;
    expect(order).toBeDefined();
    // The `expensive` getter body: money arithmetic + comparison inside the
    // `.some(...)` lambda render as decimal.js method forms, keyed off the
    // element-typed `l.price` (money) — not a `String(...)` concat / raw `>`.
    const getter = order.split("\n").find((l) => l.includes("get expensive"))!;
    expect(getter).toContain("l.price.plus(new Decimal(");
    expect(getter).toContain(".gt(");
    // The bug's fingerprint — a placeholder-string param forced a `String(...)`
    // conversion of the decimal literal and a raw `>` — must be gone.
    expect(getter).not.toContain("String(");
    expect(getter).not.toMatch(/l\.price \+/);
  });

  it("resolves the element member + money-typed literal on .NET", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateDotnet(model);
    const order = files.get("Domain/Orders/Order.cs")!;
    expect(order).toBeDefined();
    const getter = order.split("\n").find((l) => l.includes("Expensive"))!;
    // `l.Price` resolves against the OrderLine element (not a string), and the
    // decimal literal is money-typed (`10.00m`) via contextual promotion from
    // the element member — both consequences of the element type reaching the
    // lambda env.  .NET money is `decimal`, so native operators are correct.
    expect(getter).toContain("l.Price + 10.00m");
    expect(getter).toContain("> this.Total");
  });
});
