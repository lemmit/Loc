// Projection read models (projection.md) — the lowered `ProjectionIR`.
// Covers the grammar surface, state-field lowering, the explicit `keyed by`
// correlation field, and the pure `on(e: Event)` fold handlers.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
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

/** Wrap a projection body in a system and return the error codes the IR
 *  validator emits. */
async function projectionErrors(projectionBody: string): Promise<string[]> {
  const source = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Placed Shipped }
      event OrderPlaced  { order: Order id, customer: Customer id }
      event OrderShipped { order: Order id }
      event StockMoved   { sku: string }
      aggregate Customer { name: string }
      aggregate Order { status: OrderStatus  create place(customer: Customer id) {} }
      ${projectionBody}
    }
  }
}`;
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
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

describe("projection validation", () => {
  it("rejects `keyed by` naming an undeclared field", async () => {
    const errs = await projectionErrors(`
      projection P keyed by nope {
        order: Order id
        on(e: OrderPlaced) { order := e.order }
      }`);
    expect(errs).toContain("loom.projection-key-unknown");
  });

  it("rejects a non-id key field", async () => {
    const errs = await projectionErrors(`
      projection P keyed by status {
        status: OrderStatus
        on(e: OrderPlaced) { status := Placed }
      }`);
    expect(errs).toContain("loom.projection-key-not-id");
  });

  it("rejects an event with no field routable to the key", async () => {
    const errs = await projectionErrors(`
      projection P keyed by order {
        order: Order id
        on(e: StockMoved) { }
      }`);
    expect(errs).toContain("loom.projection-event-unkeyed");
  });

  it("rejects an impure fold that emits", async () => {
    const errs = await projectionErrors(`
      projection P keyed by order {
        order: Order id
        on(e: OrderPlaced) { order := e.order  emit OrderShipped { order: e.order } }
      }`);
    expect(errs).toContain("loom.projection-fold-impure");
  });

  it("rejects duplicate handlers for one event", async () => {
    const errs = await projectionErrors(`
      projection P keyed by order {
        order: Order id
        on(e: OrderPlaced) { order := e.order }
        on(e: OrderPlaced) { order := e.order }
      }`);
    expect(errs).toContain("loom.projection-duplicate-on");
  });
});
