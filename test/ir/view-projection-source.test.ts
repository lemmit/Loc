// Projection-sourced views (projection.md v1.1): grammar + scope let a `view`
// resolve to a projection; lowering records `source.kind === "projection"`; the
// IR validator resolves the filter against the projection's state fields.  The
// headline divergence from a workflow source: a projection source PERMITS the
// full-form bind-follow (a view is a query, not a replayable fold), so there is
// no `fullform-unsupported` gate here.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/index.js";

function src(opts: { view: string }): string {
  return `
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
      ${opts.view}
    }}}`;
}

async function firstView(view: string) {
  const { model } = await parseString(src({ view }), { validate: false });
  return allContexts(lowerModel(model))[0].views[0];
}

async function diags(view: string): Promise<string[]> {
  const { model } = await parseString(src({ view }), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code ?? "");
}

describe("projection-sourced views — lowering", () => {
  it("lowers a projection source to `source.kind === 'projection'`", async () => {
    const view = await firstView("view ShippedRows = OrderBook where status == Shipped");
    expect(view.source).toEqual({ kind: "projection", name: "OrderBook" });
    expect(view.filter?.kind).toBe("binary");
  });

  it("lowers a full-form projection view with a bind-follow to auxiliaries", async () => {
    const view = await firstView(`view ShippedOrders {
      customerName: string
      from OrderBook where status == Shipped
      bind customerName = customer.name
    }`);
    expect(view.source).toEqual({ kind: "projection", name: "OrderBook" });
    expect(view.output?.auxiliaries.map((a) => a.aggName)).toEqual(["Customer"]);
  });
});

describe("projection-sourced views — validation", () => {
  it("accepts a shorthand view whose filter references a projection state field", async () => {
    expect(await diags("view ShippedRows = OrderBook where status == Shipped")).toEqual([]);
  });

  it("accepts a full-form (bind-projected) view over a projection source", async () => {
    // The key divergence from a workflow source: full-form is PERMITTED (no
    // `loom.view-workflow-fullform-unsupported`-style gate).
    const codes = await diags(`view ShippedOrders {
      customerName: string
      from OrderBook where status == Shipped
      bind customerName = customer.name
    }`);
    expect(codes).toEqual([]);
  });

  it("rejects a filter referencing an unknown projection field", async () => {
    const bare = await diags("view Bogus = OrderBook where missingField == Shipped");
    expect(bare).toContain("loom.view-where-not-queryable");

    const explicit = await diags("view Bogus2 = OrderBook where this.missingField == Shipped");
    expect(explicit).toContain("loom.view-where-unknown-field");
  });
});
