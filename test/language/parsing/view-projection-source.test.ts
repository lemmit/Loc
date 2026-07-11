// A `view` may name a `projection` as its `from` source (projection.md v1.1):
// the grammar's `type ViewSource = Aggregate | Workflow | Projection` admits it
// and the scope provider resolves the bare projection name.  Proves both the
// full-form (`view X { … from Proj … bind … }`) and shorthand
// (`view X = Proj where …`) forms parse with the projection as the resolved
// `from` source.
//
// Mirrors the view smoke test in parsing.test.ts.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { BoundedContext, Model, View } from "../../../src/language/generated/ast.js";

const FIXTURE = `
context Orders {
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
  view ShippedOrders {
    orderId: Order id
    customerName: string
    status: OrderStatus
    from OrderBook where status == Shipped
    bind orderId = order, customerName = customer.name, status = status
  }
  view PlacedOrderBooks = OrderBook where status == Placed
}
`;

describe("projection-as-view-source — parsing", () => {
  it("resolves a projection as the `from` source for both view forms", async () => {
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(FIXTURE, { validation: true });

    // No lexer / parser errors.
    expect(doc.parseResult.lexerErrors).toEqual([]);
    expect(doc.parseResult.parserErrors).toEqual([]);
    // No error-severity validation diagnostics.
    expect((doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message)).toEqual(
      [],
    );

    const ctx = (doc.parseResult.value as Model).members[0] as BoundedContext;
    const views = ctx.members.filter((m): m is View => m.$type === "View");
    expect(views.map((v) => v.name)).toEqual(["ShippedOrders", "PlacedOrderBooks"]);

    const full = views.find((v) => v.name === "ShippedOrders")!;
    const shorthand = views.find((v) => v.name === "PlacedOrderBooks")!;

    // Full form: the `from OrderBook` cross-ref resolves to the Projection node.
    expect(full.source?.ref?.$type).toBe("Projection");
    expect(full.source?.ref?.name).toBe("OrderBook");
    expect(full.fields.map((f) => f.name)).toEqual(["orderId", "customerName", "status"]);
    expect(full.binds.map((b) => b.name)).toEqual(["orderId", "customerName", "status"]);

    // Shorthand form: same projection as the resolved source.
    expect(shorthand.source?.ref?.$type).toBe("Projection");
    expect(shorthand.source?.ref?.name).toBe("OrderBook");
    expect(shorthand.fields).toHaveLength(0);
  });
});
