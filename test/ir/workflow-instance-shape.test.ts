// Workflow `instanceWireShape` enrichment (workflow-instance-visibility.md):
// the persisted correlation-state row's canonical wire shape — the
// workflow-instance analogue of an aggregate's `wireShape`.  Derived for every
// correlation-bearing workflow — state-based sagas AND event-sourced ones (the
// ES read folds the per-correlation event stream; the shape is identical) —
// and absent only for a stateless workflow (no correlation field ⇒ no instance
// to read).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";

async function enrichFirstWorkflow(members: string) {
  const srcText = `
    system S { subdomain M { context C {
      aggregate Order { total: int }
      enum FulfillmentStatus { Pending, Shipped }
      event PaymentReceived { order: Order id, amount: int }
      workflow Fulfillment {
        ${members}
      }
    }}}`;
  const { model } = await parseString(srcText, { validate: false });
  return allContexts(enrichLoomModel(lowerModel(model)))[0].workflows[0];
}

describe("workflow instanceWireShape enrichment", () => {
  it("derives the instance wire shape from the correlation field + state fields", async () => {
    const wf = await enrichFirstWorkflow(`
      orderId: Order id
      status: FulfillmentStatus
      amountPaid: int
      create(paid: PaymentReceived) by paid.order { let x = paid.amount }
    `);
    expect(wf.correlationField).toBe("orderId");
    expect(wf.instanceWireShape).toBeDefined();
    const shape = wf.instanceWireShape ?? [];
    // Correlation field first, as the id-shaped token row.
    expect(shape[0]).toMatchObject({ name: "orderId", source: "id", access: "token" });
    // Then the remaining state fields, declaration order, as properties.
    expect(shape.slice(1).map((f) => f.name)).toEqual(["status", "amountPaid"]);
    expect(shape.slice(1).every((f) => f.source === "property")).toBe(true);
  });

  it("carries the correlation field's declared name (not always `id`)", async () => {
    const wf = await enrichFirstWorkflow(`
      orderId: Order id
      create(paid: PaymentReceived) by paid.order { let x = paid.amount }
    `);
    expect(wf.instanceWireShape?.map((f) => f.name)).toEqual(["orderId"]);
  });

  it("derives the same instance wire shape for an event-sourced workflow", async () => {
    // ES workflows no longer short-circuit: a correlation field + state fields
    // gives the SAME populated shape a state-based saga would get.  The read
    // body folds the per-correlation `<wf>_events` stream instead of selecting a
    // `<wf>_state` row, but the wire shape (and thus cross-backend DTO) is
    // identical (workflow-instance-visibility.md / workflow-and-applier.md A2-S5b).
    const srcText = `
      system S { subdomain M { context C {
        aggregate Order { total: int }
        enum FulfillmentStatus { Pending, Shipped }
        event PaymentReceived { order: Order id, amount: int }
        workflow Fulfillment eventSourced {
          orderId: Order id
          status: FulfillmentStatus
          amountPaid: int
          create(paid: PaymentReceived) by paid.order { emit PaymentReceived { order: paid.order, amount: 0 } }
          apply(paid: PaymentReceived) { amountPaid := amountPaid + paid.amount }
        }
      }}}`;
    const { model } = await parseString(srcText, { validate: false });
    const wf = allContexts(enrichLoomModel(lowerModel(model)))[0].workflows[0];
    expect(wf.eventSourced).toBe(true);
    expect(wf.correlationField).toBe("orderId");
    expect(wf.instanceWireShape).toBeDefined();
    const shape = wf.instanceWireShape ?? [];
    // Correlation field first (id-shaped token row), then state fields as props —
    // byte-identical to the state-based saga shape above.
    expect(shape[0]).toMatchObject({ name: "orderId", source: "id", access: "token" });
    expect(shape.slice(1).map((f) => f.name)).toEqual(["status", "amountPaid"]);
    expect(shape.slice(1).every((f) => f.source === "property")).toBe(true);
  });

  it("leaves instanceWireShape undefined for a workflow without a correlation field", async () => {
    // A command-only workflow with no id-shaped state field has no instance
    // to persist or observe.
    const wf = await enrichFirstWorkflow(`
      create(customerId: Order id) { let o = Order.create({ total: 1 }) }
    `);
    expect(wf.correlationField).toBeUndefined();
    expect(wf.instanceWireShape).toBeUndefined();
  });

  it("is idempotent — enrich(enrich(m)) yields the same shape", async () => {
    const srcText = `
      system S { subdomain M { context C {
        aggregate Order { total: int }
        event PaymentReceived { order: Order id, amount: int }
        workflow Fulfillment {
          orderId: Order id
          note: string
          create(paid: PaymentReceived) by paid.order { let x = paid.amount }
        }
      }}}`;
    const { model } = await parseString(srcText, { validate: false });
    const once = enrichLoomModel(lowerModel(model));
    const twice = enrichLoomModel(once);
    expect(allContexts(twice)[0].workflows[0].instanceWireShape).toEqual(
      allContexts(once)[0].workflows[0].instanceWireShape,
    );
  });
});
