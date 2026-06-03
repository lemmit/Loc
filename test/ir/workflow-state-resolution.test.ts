// Workflow-as-entity resolution foundation (workflow-and-applier.md A2-S5a).
// A workflow's `Property` state fields resolve as `this`-props inside handler
// bodies — bare names and `this.field` member access — exactly like aggregate
// fields.  Purely additive: legacy workflow bodies declare no state, so their
// resolution is unchanged.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

const SRC = `
  system S { subdomain M { context C {
    aggregate Order { total: int }
    event PaymentReceived { order: Order id, amount: int }
    workflow Fulfillment {
      orderId: Order id
      count: int
      on(paid: PaymentReceived) by paid.order {
        let a = count
        let b = this.count
      }
    }
  }}}`;

async function reactorStatements() {
  const { model } = await parseString(SRC, { validate: false });
  const wf = allContexts(lowerModel(model))[0].workflows[0];
  return wf.subscriptions?.[0].statements ?? [];
}

describe("workflow-as-entity resolution (A2-S5a)", () => {
  it("resolves a bare state-field name to a this-prop with the field type", async () => {
    const [a] = await reactorStatements();
    expect(a.kind).toBe("expr-let");
    const expr = a.kind === "expr-let" ? a.expr : undefined;
    expect(expr?.kind).toBe("ref");
    if (expr?.kind === "ref") {
      expect(expr.refKind).toBe("this-prop");
      expect(expr.type).toEqual({ kind: "primitive", name: "int" });
    }
  });

  it("resolves `this.field` member access against workflow state", async () => {
    const stmts = await reactorStatements();
    const b = stmts[1];
    expect(b.kind).toBe("expr-let");
    const expr = b.kind === "expr-let" ? b.expr : undefined;
    expect(expr?.kind).toBe("member");
    if (expr?.kind === "member") {
      expect(expr.member).toBe("count");
      expect(expr.receiverType).toEqual({ kind: "entity", name: "Fulfillment" });
      expect(expr.memberType).toEqual({ kind: "primitive", name: "int" });
    }
  });

  it("multi-hops a state field whose type is an aggregate id (this.orderId.total)", async () => {
    const { model } = await parseString(
      `
      system S { subdomain M { context C {
        aggregate Order { total: int }
        event PaymentReceived { order: Order id, amount: int }
        workflow Fulfillment {
          orderId: Order id
          on(paid: PaymentReceived) by paid.order {
            let t = this.orderId.total
          }
        }
      }}}`,
      { validate: false },
    );
    const wf = allContexts(lowerModel(model))[0].workflows[0];
    const stmt = wf.subscriptions?.[0].statements[0];
    const expr = stmt?.kind === "expr-let" ? stmt.expr : undefined;
    // `this.orderId` is `Order id`; `.total` hops into Order → int.
    expect(expr?.kind).toBe("member");
    if (expr?.kind === "member") {
      expect(expr.memberType).toEqual({ kind: "primitive", name: "int" });
    }
  });
});
