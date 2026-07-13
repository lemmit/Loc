// Projection-sourced views on React (projection.md v1.1): a projection has no
// per-source api module, so a shorthand view emits its row schema INLINE from
// the projection's `wireShape` (a plain `<Agg>ListResponse` re-export would be a
// broken import) and pulls in any enum/VO schema the row references.

import { describe, expect, it } from "vitest";
import { buildViewsApiModule } from "../../../src/generator/_frontend/views-module.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { parseString } from "../../_helpers/index.js";

const CTX = `
  system S { subdomain M { context C {
    enum OrderStatus { Placed, Shipped }
    event OrderPlaced  { order: Order id, customer: Customer id }
    event OrderShipped { order: Order id }
    aggregate Customer { name: string }
    repository Customers for Customer {}
    aggregate Order { status: OrderStatus  customer: Customer id }
    repository Orders for Order {}
    projection OrderBook keyed by order {
      order: Order id
      customer: Customer id
      status: OrderStatus
      on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
      on(e: OrderShipped) { status := Shipped }
    }
    view ShippedRows = OrderBook where status == Shipped
  }}}`;

describe("React projection-sourced view api module", () => {
  it("emits an inline row schema from the projection wireShape (no broken source import)", async () => {
    const { model } = await parseString(CTX, { validate: false });
    const ctxs = allContexts(enrichLoomModel(lowerModel(model)));
    const mod = buildViewsApiModule(ctxs);
    // Inline row object — NOT a `<Proj>ListResponse` re-export (which has no module).
    expect(mod).toContain("export const ShippedRowsRow = z.object({");
    expect(mod).not.toContain("OrderBookListResponse");
    // Enum column pulls the enum schema in from its owning aggregate module.
    expect(mod).toMatch(/import \{ OrderStatusSchema \} from "\.\/order";/);
    expect(mod).toContain("status: OrderStatusSchema,");
    expect(mod).toContain("export function useShippedRowsView() {");
    expect(mod).toContain("await api.get(`/views/shipped_rows`)");
  });
});
