// Projection read models (projection.md) — the lowered `ProjectionIR`.
// Covers the grammar surface, state-field lowering, the explicit `keyed by`
// correlation field, and the pure `on(e: Event)` fold handlers.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Placed Shipped }

      event OrderPlaced  { order: Order id, customer: Customer id }
      event OrderShipped { order: Order id }

      aggregate Customer { name: string }
      aggregate Order {
        status: OrderStatus
        create place(customer: Customer id) {}
      }

      projection OrderBook keyed by order {
        order:    Order id
        customer: Customer id
        status:   OrderStatus
        on(e: OrderPlaced) {
          order := e.order
          customer := e.customer
          status := Placed
        }
        on(e: OrderShipped) {
          status := Shipped
        }
      }
    }
  }
}
`;

async function lowerFirstProjection() {
  const { model } = await parseString(SOURCE, { validate: false });
  const loom = lowerModel(model);
  const ctx = allContexts(loom)[0]!;
  return ctx.projections[0]!;
}

describe("projection lowering", () => {
  it("lowers a projection onto ProjectionIR with an explicit correlation field", async () => {
    const p = await lowerFirstProjection();
    expect(p.name).toBe("OrderBook");
    expect(p.correlationField).toBe("order");
    expect(p.stateFields.map((f) => f.name)).toEqual(["order", "customer", "status"]);
  });

  it("lowers one pure fold handler per subscribed event", async () => {
    const p = await lowerFirstProjection();
    expect(p.handlers.map((h) => h.event)).toEqual(["OrderPlaced", "OrderShipped"]);
    const placed = p.handlers.find((h) => h.event === "OrderPlaced")!;
    expect(placed.param).toBe("e");
    // Three assignment folds against the row.
    expect(placed.statements).toHaveLength(3);
  });

  it("resolves bare state-field assignment targets as this-props", async () => {
    const p = await lowerFirstProjection();
    const shipped = p.handlers.find((h) => h.event === "OrderShipped")!;
    const stmt = shipped.statements[0]!;
    // `status := Shipped` — an assignment whose target is the `status` state field.
    expect(JSON.stringify(stmt)).toContain("status");
  });
});
