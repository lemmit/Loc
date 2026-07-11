// Shorthand projection-sourced views on Angular (projection.md v1.1): the
// angular views module emits a shorthand projection view's `<View>Row`
// interface from the projection's wire shape (correlation id token then the
// state fields), rather than reusing a source aggregate row.
//
// Angular sibling of test/generator/react/react-projection-view.test.ts.

import { describe, expect, it } from "vitest";
import { buildAngularViewsModule } from "../../../src/generator/angular/views-module.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/index.js";

const CTX = `
  system S { subdomain M { context C {
    enum OrderStatus { Placed Shipped }
    event OrderPlaced  { order: Order id, customer: Customer id }
    event OrderShipped { order: Order id }
    aggregate Customer { name: string }
    aggregate Order { status: OrderStatus  create place(customer: Customer id) {} }
    channel Lifecycle { carries: OrderPlaced, OrderShipped  retention: log  key: order }
    projection OrderBook keyed by order {
      order: Order id
      customer: Customer id
      status: OrderStatus
      on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
      on(e: OrderShipped) { status := Shipped }
    }
    view ShippedOrders = OrderBook where status == Shipped
    repository Orders for Order {}
  }}}`;

describe("Angular shorthand projection-sourced view module", () => {
  it("emits the <View>Row interface from the projection wire shape", async () => {
    const { model } = await parseString(CTX, { validate: false });
    const ctxs = allContexts(enrichLoomModel(lowerModel(model)));
    const mod = buildAngularViewsModule(ctxs);

    // The row interface projects the projection's fields (id tokens are strings;
    // the enum falls back to `unknown` per the angular wire-type mapping).
    expect(mod).toContain("export interface ShippedOrdersRow {");
    expect(mod).toContain("order: string;");
    expect(mod).toContain("customer: string;");
    expect(mod).toContain("status: unknown;");
    // Service method + injectQuery factory still emitted.
    expect(mod).toContain("this.http.get<ShippedOrdersRow[]>(");
    expect(mod).toContain("export function useShippedOrdersView() {");
  });
});
