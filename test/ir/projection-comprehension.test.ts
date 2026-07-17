// Lowering + validation coverage for the generalised `projection` query-time
// comprehension (read-path-architecture.md rev.13).  The front-half lands the
// surface + IR + validation gates; the per-backend emit is a follow-up, so a
// query-time / `join` projection lowers fully but is HONESTLY rejected by
// `loom.projection-query-time-unsupported` until a backend ports it.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import {
  allContexts,
  type ExprIR,
  isMaterializedProjection,
  isQueryTimeProjection,
  isSingletonProjection,
} from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed Closed }
      event OrderPlaced { order: Order id }
      aggregate Customer { name: string  region: string }
      aggregate Order {
        status: OrderStatus  placedAt: datetime  customerId: Customer id  lineCount: int  total: money
        create place(customer: Customer id) {}
      }
      repository Orders for Order {}
      repository Customers for Customer {}
      criterion InRegion(region: string) of Order as o = o.region == region
      ${body}
    }
  }
}`;

async function lowerProjection(name: string, body: string) {
  const { model } = await parseString(wrap(body), { validate: false });
  const loom = lowerModel(model);
  const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
  return ctx.projections.find((p) => p.name === name)!;
}

async function projectionErrorCodes(body: string): Promise<string[]> {
  const { model } = await parseString(wrap(body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
}

const QUERY_TIME = `
  projection OrdersInRegion(region: string) keyed by orderId {
    orderId: Order id  lineCount: int  customerName: string
    from Order as o
    where InRegion(region) && o.status == Confirmed
    join Customer as c on o.customerId
    select orderId = o.id, lineCount = o.lineCount, customerName = c.name
  }
`;

describe("projection comprehension — lowering", () => {
  it("lowers params, source + alias, joins, and selects", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(p.params.map((x) => x.name)).toEqual(["region"]);
    expect(p.correlationField).toBe("orderId");
    expect(p.query?.source).toBe("Order");
    expect(p.query?.sourceAlias).toBe("o");
    expect(p.query?.joins.map((j) => ({ agg: j.aggregate, alias: j.alias }))).toEqual([
      { agg: "Customer", alias: "c" },
    ]);
    expect(p.query?.selects?.map((s) => s.field)).toEqual(["orderId", "lineCount", "customerName"]);
  });

  it("derives a by-id auxiliary (path + mapVar) from the `join` clause", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(p.query?.auxiliaries).toEqual([
      { path: ["customerId"], aggName: "Customer", mapVar: "customerById" },
    ]);
  });

  it("resolves a join-alias read (`c.name`) to a member on an entity-typed local (no unknown ref)", async () => {
    const p = await lowerProjection("OrdersInRegion", QUERY_TIME);
    const sel = p.query!.selects!.find((s) => s.field === "customerName")!.expr as ExprIR;
    expect(sel).toMatchObject({
      kind: "member",
      member: "name",
      receiver: { kind: "ref", name: "c", refKind: "let" },
      receiverType: { kind: "entity", name: "Customer" },
    });
  });

  it("reifies a named-criterion `where` (criterionRef), like a retrieval", async () => {
    const p = await lowerProjection(
      "ByRegion",
      `projection ByRegion(region: string) keyed by orderId {
        orderId: Order id
        from Order as o where InRegion(region)
        select orderId = o.id
      }`,
    );
    expect(p.query?.criterionRef?.name).toBe("InRegion");
  });

  it("derives materialized/singleton/query-time from clause presence (not stamped)", async () => {
    const qt = await lowerProjection("OrdersInRegion", QUERY_TIME);
    expect(isQueryTimeProjection(qt)).toBe(true);
    expect(isMaterializedProjection(qt)).toBe(false);
    expect(isSingletonProjection(qt)).toBe(false);

    const singleton = await lowerProjection(
      "Dash",
      `projection Dash {
        openOrders: int
        from Order as o where o.status == Confirmed
        select openOrders = o.lineCount.count
      }`,
    );
    expect(isSingletonProjection(singleton)).toBe(true);

    const folded = await lowerProjection(
      "OrderBook",
      `projection OrderBook keyed by order {
        order: Order id  status: OrderStatus
        on(e: OrderPlaced) { order := e.order  status := Confirmed }
      }`,
    );
    expect(isMaterializedProjection(folded)).toBe(true);
    expect(isQueryTimeProjection(folded)).toBe(false);
    expect(folded.query).toBeUndefined();
  });
});

describe("projection comprehension — validation gates", () => {
  it("HONESTLY rejects a query-time projection until a backend emits it", async () => {
    const codes = await projectionErrorCodes(QUERY_TIME);
    expect(codes).toContain("loom.projection-query-time-unsupported");
  });

  it("rejects a `from` source AND `on(e)` folds together (reserved combo)", async () => {
    const codes = await projectionErrorCodes(`
      projection Hybrid keyed by orderId {
        orderId: Order id  status: OrderStatus
        on(e: OrderPlaced) { orderId := e.order }
        from Order as o where o.status == Confirmed
        select orderId = o.id
      }
    `);
    expect(codes).toContain("loom.projection-query-and-fold-unsupported");
    // the specific reserved-combo gate fires INSTEAD of the generic honest gate
    expect(codes).not.toContain("loom.projection-query-time-unsupported");
  });

  it("leaves today's folded projection untouched (no comprehension diagnostics)", async () => {
    const codes = await projectionErrorCodes(`
      projection OrderBook keyed by order {
        order: Order id  status: OrderStatus
        on(e: OrderPlaced) { order := e.order  status := Confirmed }
      }
    `);
    expect(codes).not.toContain("loom.projection-query-time-unsupported");
    expect(codes).not.toContain("loom.projection-query-and-fold-unsupported");
  });
});
