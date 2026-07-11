// Shorthand projection-sourced views on React (projection.md v1.1): a
// projection has no frontend api module, so a shorthand `view X = Proj where …`
// emits its `<View>Row` zod schema INLINE from the projection's wire shape —
// NOT a re-export of a `<Proj>ListResponse` import (contrast the aggregate /
// workflow shorthand branches, which do re-export).
//
// Mirrors test/generator/react/react-workflow-view.test.ts.

import { describe, expect, it } from "vitest";
import { buildViewsApiModule } from "../../../src/generator/_frontend/views-module.js";
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

describe("React shorthand projection-sourced view api module", () => {
  it("emits the row schema inline from the projection wire shape", async () => {
    const { model } = await parseString(CTX, { validate: false });
    const ctxs = allContexts(enrichLoomModel(lowerModel(model)));
    const mod = buildViewsApiModule(ctxs);

    // Inline z.object with the projection's wire-shape fields.
    expect(mod).toContain("export const ShippedOrdersRow = z.object({");
    expect(mod).toContain("order: z.string(),");
    expect(mod).toContain("customer: z.string(),");
    expect(mod).toContain("status: OrderStatusSchema,");
    expect(mod).toContain("export const ShippedOrdersResponse = z.array(ShippedOrdersRow);");
    // The `use…View` hook + query key are still emitted.
    expect(mod).toContain("export function useShippedOrdersView() {");
    expect(mod).toContain("await api.get(`/views/shipped_orders`)");

    // NOT a re-export of a projection list response, and no import of one.
    expect(mod).not.toContain("OrderBookListResponse");
    expect(mod).not.toContain("export const ShippedOrdersResponse = OrderBookListResponse;");
  });
});
