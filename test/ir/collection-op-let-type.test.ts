// F2-EXPR-1 / F2-EXPR-2 — the two typing paths for a collection op must agree.
//
// `applySuffixToRecv` (the lowering call site) refined `map`/`min`/`max` from
// the λ body; `inferSuffixType` — the path that types a `let` binding through
// `inferExprType` — called the structural `memberType` raw.  Two consequences,
// both silent through `ddd parse` and `generate system`:
//
//   F2-EXPR-2  `memberType` had NO `map` arm, so it fell to its `string`
//              default: `let m = lines.map(λ)` bound a `string`-typed local and
//              every downstream collection op on `m` mis-rendered — node
//              `m.count` on a `string[]` (TS2339), java `m.count()`, elixir
//              `m.count` on a list, python binding the `list.count` METHOD.
//   F2-EXPR-1  NEITHER path refined `sum`, so `lines.sum(l => l.price * l.qty)`
//              was `money` to the AST type-system and `decimal` in the IR stamp
//              every renderer reads — node then emitted `Decimal * number`
//              (TS2362) and python `Decimal * float` (TypeError).
//
// Both halves are pinned at BOTH ends: the IR type on the `let`, and the
// generated TS that reads it.

import { describe, expect, it } from "vitest";
import type { AggregateIR, StmtIR } from "../../src/ir/types/loom-ir.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { generateHono } from "../_helpers/generate.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
  context Shop {
    aggregate Order {
      factor: decimal
      discount: money
      cnt: int
      contains lines: Line[]
      entity Line { sku: string  price: money  qty: int }
      create() { }
      operation total() {
        let base = lines.sum(l => l.price * l.qty)
        discount := base * factor
      }
      operation names() {
        let m = lines.map(l => l.sku)
        cnt := m.count
      }
      operation prices() {
        let m = lines.map(l => l.price)
        discount := m.sum(p => p)
      }
    }
    repository Orders for Order { }
  }
`;

async function letTypeIn(opName: string) {
  const loom = await buildLoomModel(SRC);
  const order = allAggregates(loom).find((a) => a.name === "Order") as AggregateIR;
  const op = order.operations.find((o) => o.name === opName)!;
  const binding = op.statements.find((s: StmtIR) => s.kind === "let");
  expect(binding).toBeDefined();
  return (binding as Extract<StmtIR, { kind: "let" }>).type;
}

describe("collection-op result types survive a `let` binding", () => {
  it("F2-EXPR-1 — `let base = lines.sum(λ)` keeps `money` (not decimal)", async () => {
    expect(await letTypeIn("total")).toEqual({ kind: "primitive", name: "money" });
  });

  it("F2-EXPR-2 — `let m = lines.map(λ)` is an ARRAY of the λ body type", async () => {
    expect(await letTypeIn("names")).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "string" },
    });
    expect(await letTypeIn("prices")).toEqual({
      kind: "array",
      element: { kind: "primitive", name: "money" },
    });
  });

  it("renders money arithmetic / array ops on the let-bound values (Hono)", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const order = generateHono(model).get("domain/order.ts")!;
    expect(order).toBeDefined();
    // F2-EXPR-1: `base * factor` on a Decimal must be `.times(...)`, not `*`.
    expect(order).toContain("this._discount = base.times(this._factor);");
    expect(order).not.toContain("this._discount = base * this._factor;");
    // F2-EXPR-2: `m.count` on a real array is `.length`, not a `.count` member.
    expect(order).toContain("this._cnt = m.length;");
    expect(order).not.toContain("this._cnt = m.count;");
    // F2-EXPR-2 (money element): the fold over a money array seeds a Decimal
    // and adds with `.plus`, never `acc + x` off an int seed.
    expect(order).toContain("acc.plus(((p) => p)(x)), new Decimal(0))");
    expect(order).not.toContain("acc + ((p) => p)(x), 0)");
  });
});
