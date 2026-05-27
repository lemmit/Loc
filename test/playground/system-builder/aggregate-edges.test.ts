// Aggregate-level read/write/emit derivation. Pure walk over the parsed AST
// (no linking required) — covers each statement form, derived/invariant/
// function consumers, and the `this.` vs bare-name read flavours.

import { describe, expect, it } from "vitest";
import type { Aggregate, BoundedContext, Model } from "../../../src/language/generated/ast.js";
import { computeAggregateRelations } from "../../../web/src/builder/system-v2/aggregate-edges.js";
import { parseRaw as parse } from "../../_helpers/index.js";

function findAggregate(ast: Model, name: string): Aggregate {
  for (const m of ast.members) {
    if (m.$type === "BoundedContext") {
      const ctx = m as BoundedContext;
      for (const cm of ctx.members)
        if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) return cm as Aggregate;
    } else if (m.$type === "System") {
      for (const sm of m.members) {
        if (sm.$type === "BoundedContext") {
          const ctx = sm as BoundedContext;
          for (const cm of ctx.members)
            if (cm.$type === "Aggregate" && (cm as Aggregate).name === name) return cm as Aggregate;
        }
      }
    }
  }
  throw new Error(`no aggregate ${name}`);
}

const SET = (vs: string[]) => new Set(vs);

describe("v2 — aggregate-edges", () => {
  it("an operation that assigns this.x and reads this.y emits one write + one read", () => {
    const ast = parse(`context C {
  aggregate A {
    x: int
    y: int
    operation bump() {
      x := y
    }
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    expect(rel.writes.get("operation:bump")).toEqual(SET(["x"]));
    expect(rel.reads.get("operation:bump")).toEqual(SET(["y"]));
  });

  it("a derived prop's bare-name references count as reads of same-aggregate fields", () => {
    const ast = parse(`context C {
  aggregate A {
    amount: decimal
    qty: int
    derived total: decimal = amount * qty
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    expect(rel.reads.get("derived:total")).toEqual(SET(["amount", "qty"]));
  });

  it("invariants register reads keyed by their source-order index", () => {
    const ast = parse(`context C {
  aggregate A {
    amount: decimal
    currency: string
    invariant amount >= 0
    invariant currency.length == 3
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    expect(rel.reads.get("invariant:0")).toEqual(SET(["amount"]));
    expect(rel.reads.get("invariant:1")).toEqual(SET(["currency"]));
  });

  it("emit statements collect event names per operation", () => {
    const ast = parse(`context C {
  event Placed {
  }
  aggregate A {
    status: string
    operation confirm() {
      status := "ok"
      emit Placed {
      }
    }
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    expect(rel.emits.get("operation:confirm")).toEqual(SET(["Placed"]));
    expect(rel.writes.get("operation:confirm")).toEqual(SET(["status"]));
  });

  it("nested member access on this records the outermost-segment only", () => {
    const ast = parse(`context C {
  valueobject Money {
    amount: decimal
  }
  aggregate A {
    price: Money
    operation discount() {
      price := price
    }
    invariant price.amount > 0
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    // Both write target (this.price) and invariant read register `price`,
    // not `amount` (which is a member of Money, not of A).
    expect(rel.writes.get("operation:discount")).toEqual(SET(["price"]));
    expect(rel.reads.get("invariant:0")).toEqual(SET(["price"]));
  });

  it("ignores let-bound names that don't shadow fields", () => {
    const ast = parse(`context C {
  aggregate A {
    amount: int
    operation foo() {
      let tmp = amount
      amount := tmp
    }
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    // `tmp` isn't a field — it must not leak into reads.
    expect(rel.reads.get("operation:foo")).toEqual(SET(["amount"]));
    expect(rel.writes.get("operation:foo")).toEqual(SET(["amount"]));
  });

  it("a function body's reads contribute under the function id", () => {
    const ast = parse(`context C {
  aggregate A {
    amount: int
    function half(): int = amount / 2
  }
}`);
    const rel = computeAggregateRelations(findAggregate(ast, "A"));
    expect(rel.reads.get("function:half")).toEqual(SET(["amount"]));
  });
});
