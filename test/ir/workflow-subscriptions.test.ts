// Workflow `on(e: Event) { … }` reactors — surface + IR lowering
// (workflow-and-applier.md Phase A2, surface slice: grammar + IR + discipline;
// `by` correlation and backend emission are deferred to later slices, exactly
// as Phase A1 landed `apply(...)` ahead of any event-store emission).

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

/** A Sales context whose `Fulfillment` workflow reacts to `PaymentReceived`.
 *  `body` is spliced into the workflow so each test can perturb it. */
function sales(opts: { reactors?: string; body?: string } = {}): string {
  return `
    system S {
      subdomain M {
        context C {
          aggregate Order { total: int }
          event PaymentReceived { order: Order id, amount: int }
          workflow Fulfillment() {
            ${opts.body ?? ""}
            ${opts.reactors ?? "on(paid: PaymentReceived) { let seen = paid.amount }"}
          }
        }
      }
    }`;
}

/** Lower a source and return the first workflow of the first context. */
async function lowerFirstWorkflow(source: string) {
  const { model } = await parseString(source, { validate: false });
  const loom = lowerModel(model);
  return allContexts(loom)[0].workflows[0];
}

describe("workflow on(...) reactors — surface + lowering", () => {
  it("parses a workflow with an on(...) reactor without errors", async () => {
    const { errors } = await parseString(sales());
    expect(errors).toEqual([]);
  });

  it("lowers on(...) into wf.subscriptions with event, param and body", async () => {
    const wf = await lowerFirstWorkflow(sales());
    expect(wf.subscriptions).toBeDefined();
    expect(wf.subscriptions).toHaveLength(1);
    const [sub] = wf.subscriptions ?? [];
    expect(sub.event).toBe("PaymentReceived");
    expect(sub.param).toBe("paid");
    expect(sub.statements).toHaveLength(1);
  });

  it("type-resolves member access on the event param (paid.field) from the event's fields", async () => {
    // `PaymentReceived { order: Order id, amount: int }` — `paid.amount` must
    // resolve to int through the event binding, proving the param-binding
    // mechanism transferred from `apply`.
    const wf = await lowerFirstWorkflow(
      sales({ reactors: "on(paid: PaymentReceived) { let x = paid.amount }" }),
    );
    const [sub] = wf.subscriptions ?? [];
    const stmt = sub.statements[0];
    // expr-let: `let x = paid.amount`
    expect(stmt.kind).toBe("expr-let");
    const value = stmt.kind === "expr-let" ? stmt.expr : undefined;
    expect(value?.kind).toBe("member");
    if (value?.kind === "member") {
      expect(value.memberType).toEqual({ kind: "primitive", name: "int" });
      expect(value.receiverType).toEqual({ kind: "entity", name: "PaymentReceived" });
    }
  });

  it("leaves subscriptions undefined when the workflow declares none", async () => {
    const wf = await lowerFirstWorkflow(sales({ reactors: "", body: "let total = 1" }));
    expect(wf.subscriptions).toBeUndefined();
  });

  it("preserves the legacy statement body unchanged alongside a reactor", async () => {
    // The sequential statements still lower to `wf.statements`; the reactor
    // is split off into `wf.subscriptions` and does not pollute the body.
    const wf = await lowerFirstWorkflow(
      sales({
        body: "let total = 1",
        reactors: "on(paid: PaymentReceived) { let seen = paid.amount }",
      }),
    );
    expect(wf.statements).toHaveLength(1);
    expect(wf.statements[0].kind).toBe("expr-let");
    expect(wf.subscriptions).toHaveLength(1);
  });

  it("lowers multiple reactor members onto the workflow", async () => {
    const wf = await lowerFirstWorkflow(
      sales({
        reactors: `on(paid: PaymentReceived) { let a = paid.amount }
                   on(p2: PaymentReceived) { let b = p2.amount }`,
      }),
    );
    expect(wf.subscriptions).toHaveLength(2);
  });
});
