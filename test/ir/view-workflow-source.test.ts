// Workflow-sourced views (workflow-instance-views.md), foundation slice:
// grammar + scope let a `view` resolve to a workflow; lowering records
// `source.kind === "workflow"`; the IR validator resolves the filter against
// the workflow's state fields and rejects non-observable / full-form sources.
// (Backend emission is added in later slices — here a workflow view lowers and
// validates but emits no endpoint yet.)

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

function src(opts: { workflow?: string; view: string }): string {
  const workflow =
    opts.workflow ??
    `workflow Fulfillment {
       orderId: Order id
       status: FulfillmentStatus
       amountDue: int
       create(paid: PaymentReceived) by paid.order { let x = paid.amount }
     }`;
  return `
    system S { subdomain M { context C {
      aggregate Order { total: int }
      enum FulfillmentStatus { Pending, Shipped }
      event PaymentReceived { order: Order id, amount: int }
      ${workflow}
      ${opts.view}
    }}}`;
}

async function firstView(view: string) {
  const { model } = await parseString(src({ view }), { validate: false });
  return allContexts(lowerModel(model))[0].views[0];
}

async function diags(opts: { workflow?: string; view: string }): Promise<string[]> {
  const { model } = await parseString(src(opts), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

describe("workflow-sourced views — lowering", () => {
  it("lowers a workflow source to `source.kind === 'workflow'`", async () => {
    const view = await firstView("view ActiveFulfillments = Fulfillment where status == Pending");
    expect(view.source).toEqual({ kind: "workflow", name: "Fulfillment" });
    expect(view.filter?.kind).toBe("binary");
  });

  it("still lowers an aggregate source to `source.kind === 'aggregate'`", async () => {
    const view = await firstView("view BigOrders = Order where total > 100");
    expect(view.source).toEqual({ kind: "aggregate", name: "Order" });
  });
});

describe("workflow-sourced views — validation", () => {
  it("accepts a shorthand view whose filter references a workflow state field", async () => {
    expect(
      await diags({ view: "view ActiveFulfillments = Fulfillment where status == Pending" }),
    ).toEqual([]);
  });

  it("rejects a filter referencing an unknown state field", async () => {
    // A bare unknown name lowers to an unresolved ref → caught by the
    // not-queryable check; an explicit `this.<unknown>` is caught by the
    // column-ref check.  Either way the filter is rejected.
    const bare = await diags({ view: "view Bogus = Fulfillment where missingField == Pending" });
    expect(bare).toContain("loom.view-where-not-queryable");

    const explicit = await diags({
      view: "view Bogus2 = Fulfillment where this.missingField == Pending",
    });
    expect(explicit).toContain("loom.view-where-unknown-field");
  });

  it("accepts an event-sourced workflow with a correlation field as a view source", async () => {
    // event-sourced workflows now carry an instance read model (folded from
    // the `<wf>_events` stream); a view over one reads that fold-projected
    // read model in-memory, so the source is observable.
    const codes = await diags({
      workflow: `workflow Fulfillment eventSourced {
        orderId: Order id
        status: FulfillmentStatus
        create(paid: PaymentReceived) by paid.order { emit PaymentReceived { order: paid.order, amount: paid.amount } }
        apply(paid: PaymentReceived) { }
      }`,
      view: "view ActiveFulfillments = Fulfillment where status == Pending",
    });
    expect(codes).not.toContain("loom.view-workflow-not-observable");
    expect(codes).toEqual([]);
  });

  it("rejects a workflow with no single id-shaped correlation field as a view source", async () => {
    // No id-shaped state field ⇒ no correlation ⇒ no instance read model on
    // either a state-table saga or an event-sourced workflow.
    const codes = await diags({
      workflow: `workflow Fulfillment eventSourced {
        status: FulfillmentStatus
        create(paid: PaymentReceived) by paid.order { emit PaymentReceived { order: paid.order, amount: paid.amount } }
        apply(paid: PaymentReceived) { }
      }`,
      view: "view ActiveFulfillments = Fulfillment where status == Pending",
    });
    expect(codes).toContain("loom.view-workflow-not-observable");
  });

  it("rejects a full-form view over a workflow source (v1 shorthand only)", async () => {
    const codes = await diags({
      view: `view FulfillmentSummary {
        orderId: Order id
        from Fulfillment where status == Pending
        bind orderId = orderId
      }`,
    });
    expect(codes).toContain("loom.view-workflow-fullform-unsupported");
  });
});
