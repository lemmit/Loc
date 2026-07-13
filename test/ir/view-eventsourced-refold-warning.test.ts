// A `view` sourced from an event-sourced thing (an `eventSourced` workflow or a
// `persistedAs(eventLog)` aggregate) re-folds the whole event stream in memory
// on every request — a projection recomputed per call.  The validator surfaces
// this as a WARNING (`loom.view-source-eventsourced-refold`), NOT a gate: the
// view stays valid and emits; the lint just nudges toward a projection.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

async function diags(src: string) {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const REFOLD = "loom.view-source-eventsourced-refold";

describe("event-sourced view source — refold lint", () => {
  it("warns (not errors) on a view over an event-sourced workflow", async () => {
    const ds = await diags(`
      system S { subdomain M { context C {
        aggregate Order { total: int }
        enum FulfillmentStatus { Pending, Shipped }
        event PaymentReceived { order: Order id, amount: int }
        channel L { carries: PaymentReceived  delivery: broadcast  retention: ephemeral }
        workflow Fulfillment eventSourced {
          orderId: Order id
          status: FulfillmentStatus
          create(paid: PaymentReceived) by paid.order { emit PaymentReceived { order: paid.order, amount: paid.amount } }
          apply(paid: PaymentReceived) { }
        }
        view ActiveFulfillments = Fulfillment where status == Pending
      }}}`);
    const refold = ds.find((d) => d.code === REFOLD);
    expect(refold?.severity).toBe("warning");
    expect(refold?.message).toMatch(/event-sourced workflow/);
    // Non-blocking: no errors on the view.
    expect(ds.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("warns on a view over an event-sourced (persistedAs eventLog) aggregate", async () => {
    // An eventLog aggregate needs a hosting deployable with an eventLog
    // dataSource to validate cleanly, so the warning is the only diagnostic.
    const ds = await diags(`
      system S {
        subdomain M { context C {
          enum OrderStatus { Placed, Shipped }
          event OrderPlaced { order: Order id }
          aggregate Order persistedAs(eventLog) {
            status: OrderStatus
            create place() { emit OrderPlaced { order: id } }
            apply(e: OrderPlaced) { status := Placed }
          }
          repository Orders for Order { }
          view PlacedOrders = Order where status == Placed
        }}
        api A from M
        storage pg { type: postgres }
        resource orderLog { for: C, kind: eventLog, use: pg }
        deployable api { platform: node  contexts: [C]  serves: A  dataSources: [orderLog]  port: 3000 }
      }`);
    const refold = ds.find((d) => d.code === REFOLD);
    expect(refold?.severity).toBe("warning");
    expect(refold?.message).toMatch(/event-sourced aggregate/);
    expect(ds.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("does NOT warn on a state aggregate / state workflow / projection source", async () => {
    const ds = await diags(`
      system S { subdomain M { context C {
        enum OrderStatus { Placed, Shipped }
        event OrderPlaced  { order: Order id, customer: Customer id }
        event OrderShipped { order: Order id }
        aggregate Customer { name: string }
        repository Customers for Customer { }
        aggregate Order { status: OrderStatus  customer: Customer id }
        repository Orders for Order { }
        projection OrderBook keyed by order {
          order: Order id
          customer: Customer id
          status: OrderStatus
          on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
          on(e: OrderShipped) { status := Shipped }
        }
        view StateAggView = Order where status == Shipped
        view ProjView = OrderBook where status == Shipped
      }}}`);
    expect(ds.find((d) => d.code === REFOLD)).toBeUndefined();
  });
});
