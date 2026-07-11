// Projection-sourced views (projection.md v1.1): a `view` may name a
// `projection` as its `from` source.  Shorthand (`view X = Proj where …`)
// reuses the projection's wire shape; full form declares its own output record
// with `bind` expressions, and an `X id` bind may follow into the referenced
// aggregate.  Lowering records `source.kind === "projection"`; the IR validator
// resolves the filter/binds against the projection's `stateFields` and — unlike
// a workflow source — accepts the full form.
//
// Mirrors test/ir/view-workflow-source.test.ts.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

function src(view: string): string {
  return `
    system Shop { subdomain Sales { context Orders {
      enum OrderStatus { Placed Shipped }
      event OrderPlaced  { order: Order id, customer: Customer id }
      event OrderShipped { order: Order id }
      aggregate Customer { name: string }
      repository Customers for Customer { }
      aggregate Order {
        status: OrderStatus
        create place(customer: Customer id) {}
        operation ship() { emit OrderShipped { order: id } }
      }
      repository Orders for Order { }
      channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
      projection OrderBook keyed by order {
        order: Order id
        customer: Customer id
        status: OrderStatus
        on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
        on(e: OrderShipped) { status := Shipped }
      }
      ${view}
    }}}`;
}

async function firstView(view: string) {
  const { model } = await parseString(src(view), { validate: false });
  return allContexts(lowerModel(model))[0].views[0];
}

async function diags(view: string): Promise<string[]> {
  const { model } = await parseString(src(view), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

describe("projection-sourced views — lowering", () => {
  it("lowers a shorthand projection source to `source.kind === 'projection'`", async () => {
    const view = await firstView("view PlacedOrderBooks = OrderBook where status == Placed");
    expect(view.source).toEqual({ kind: "projection", name: "OrderBook" });
    expect(view.filter?.kind).toBe("binary");
    // Shorthand: no declared output record — emitters fall back to the
    // projection wire shape.
    expect(view.output).toBeUndefined();
  });

  it("lowers a full-form projection view (bind + `X id` follow) without error", async () => {
    const view = await firstView(`view ShippedOrders {
      orderId: Order id
      customerName: string
      status: OrderStatus
      from OrderBook where status == Shipped
      bind orderId = order, customerName = customer.name, status = status
    }`);
    expect(view.source).toEqual({ kind: "projection", name: "OrderBook" });
    expect(view.output).toBeDefined();
    expect(view.output?.fields.map((f) => f.name)).toEqual(["orderId", "customerName", "status"]);
    expect(view.output?.binds.map((b) => b.name)).toEqual(["orderId", "customerName", "status"]);
    // `bind customerName = customer.name` follows a `Customer id` state field
    // into the Customer aggregate — one bulk-load auxiliary keyed on `customer`.
    const aux = view.output?.auxiliaries ?? [];
    expect(aux.map((a) => a.aggName)).toContain("Customer");
    expect(aux.map((a) => a.path.join("."))).toContain("customer");
  });

  it("still lowers an aggregate source to `source.kind === 'aggregate'`", async () => {
    const view = await firstView("view PlacedOrders = Order where status == Placed");
    expect(view.source).toEqual({ kind: "aggregate", name: "Order" });
  });
});

describe("projection-sourced views — validation", () => {
  it("accepts a shorthand view whose filter references a projection state field", async () => {
    expect(await diags("view PlacedOrderBooks = OrderBook where status == Placed")).toEqual([]);
  });

  it("accepts a well-formed full-form projection view (bind + `X id` follow)", async () => {
    const codes = await diags(`view ShippedOrders {
      orderId: Order id
      customerName: string
      status: OrderStatus
      from OrderBook where status == Shipped
      bind orderId = order, customerName = customer.name, status = status
    }`);
    expect(codes).toEqual([]);
  });

  it("fires loom.view-unknown-source when `from` names a non-source (an enum)", async () => {
    // OrderStatus is an enum, not an aggregate / workflow / projection, so it is
    // not a ViewSource — the cross-ref never resolves and the IR validator
    // rejects the unresolved source.
    const codes = await diags("view Bogus = OrderStatus where status == Placed");
    expect(codes).toContain("loom.view-unknown-source");
  });
});
