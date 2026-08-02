// M-T4.2 — the GROUPED read model: `group by <col>, …` in a query-time
// projection makes the aggregate/per-row `select` MIX legal — one row per
// distinct grouping-key combination, aggregates computed per group in SQL, the
// LIST response shape (an array of the declared row, ordered by the keys).
//
// What this pins: the clause lowers into `ProjectionQueryIR.groupBy` (same
// candidate scope as `select`, so `o.status` and `select status = o.status`
// match structurally); the shared `groupedAggregates` detector splits keys
// from aggregates with DECLARED wire types; the singleton detector refuses a
// grouped projection (so no emitter mistakes the list for one row); and the
// shape gates reject every combination the emitters would otherwise guess at.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, isGroupedProjection, isSingletonProjection } from "../../src/ir/types/loom-ir.js";
import { groupedAggregates, wholeTableAggregates } from "../../src/ir/util/projection-aggregate.js";
import { isFrontendReadableProjection } from "../../src/ir/util/projection-read.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function codes(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

async function projection(src: string, name: string) {
  const { model } = await parseString(src, { validate: false });
  const loom = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(loom).find((c) => c.name === "Orders")!;
  return ctx.projections.find((p) => p.name === name)!;
}

const context = (body: string) => `system S {
  subdomain Sales { context Orders {
    enum OrderStatus { Draft Confirmed Cancelled }
    aggregate Customer { name: string }
    aggregate Order {
      code: string
      status: OrderStatus
      total: money
      lineCount: int
      customerId: Customer id
      derived display: string = code
    }
    repository Orders for Order { }
    repository Customers for Customer { }
    event OrderPlaced { orderId: Order id  status: OrderStatus }
    ${body}
  } }
}`;

const hostedOn = (platform: string, body: string) => `system S {
  subdomain Sales { context Orders {
    enum OrderStatus { Draft Confirmed Cancelled }
    aggregate Order { status: OrderStatus  total: money  derived display: string = status }
    repository Orders for Order { }
    ${body}
  } }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  deployable api { platform: ${platform} contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}`;

const BY_STATUS = `projection SalesByStatus { status: OrderStatus  orders: int  revenue: money
  from Order as o
  group by o.status
  select status = o.status, orders = count(), revenue = sum(o.total) }`;

describe("lowering the group by clause", () => {
  it("lowers each grouping column in the select scope — a this-rooted member", async () => {
    const p = await projection(context(BY_STATUS), "SalesByStatus");
    expect(p.query?.groupBy).toHaveLength(1);
    expect(p.query?.groupBy?.[0]?.kind).toBe("member");
    expect(isGroupedProjection(p)).toBe(true);
    // Grouped ⇒ many rows; still UNKEYED, but no longer the one-object read.
    expect(isSingletonProjection(p)).toBe(true);
    expect(isFrontendReadableProjection(p)).toBe(false);
  });

  it("splits keys from aggregates via groupedAggregates, with DECLARED wire types", async () => {
    const p = await projection(context(BY_STATUS), "SalesByStatus");
    const g = groupedAggregates(p)!;
    expect(g.keys.map((k) => k.field)).toEqual(["status"]);
    expect(g.aggregates.map((a) => a.field)).toEqual(["orders", "revenue"]);
    // The money sum coerces to the DECLARED row type (string on the wire).
    expect(g.aggregates[1]?.type).toEqual({ kind: "primitive", name: "money" });
    expect(g.groupBy).toHaveLength(1);
  });

  it("keeps the singleton detector all-or-nothing — a grouped projection never takes the one-row path", async () => {
    // Even an ALL-aggregate select with `group by` returns one row PER GROUP,
    // so `wholeTableAggregates` must refuse it or the emitters would serve an
    // object where the wire says array.
    const p = await projection(
      context(`projection Volumes { orders: int
        from Order as o
        group by o.status
        select orders = count() }`),
      "Volumes",
    );
    expect(wholeTableAggregates(p)).toBeNull();
    expect(groupedAggregates(p)).not.toBeNull();
  });

  it("a non-grouped projection stays exactly as before", async () => {
    const p = await projection(
      context(`projection SalesTotals { orders: int
        from Order as o
        select orders = count() }`),
      "SalesTotals",
    );
    expect(p.query?.groupBy).toBeUndefined();
    expect(groupedAggregates(p)).toBeNull();
    expect(wholeTableAggregates(p)).toHaveLength(1);
  });
});

describe("group-by shape gates", () => {
  it("accepts the canonical grouped read model — no projection-groupby diagnostics", async () => {
    const cs = (await codes(context(BY_STATUS))).filter((c) => c.startsWith("loom.projection-groupby"));
    expect(cs).toEqual([]);
  });

  it("accepts a multi-column grouping", async () => {
    const cs = await codes(
      context(`projection ByStatusAndCustomer { status: OrderStatus  customerId: Customer id  orders: int
        from Order as o
        group by o.status, o.customerId
        select status = o.status, customerId = o.customerId, orders = count() }`),
    );
    expect(cs.filter((c) => c.startsWith("loom.projection-groupby"))).toEqual([]);
  });

  it("rejects group by without a from source", async () => {
    expect(
      await codes(
        context(`projection Nope keyed by orderId { orderId: Order id  n: int
          on(e: OrderPlaced) { orderId := e.orderId  n := 1 }
          group by o.status }`),
      ),
    ).toContain("loom.projection-groupby-source-unsupported");
  });

  it("rejects group by over a keyed projection", async () => {
    expect(
      await codes(
        context(`projection Nope(customer: Customer id) keyed by customerId { customerId: Customer id  orders: int
          from Order as o
          group by o.customerId
          select customerId = o.customerId, orders = count() }`),
      ),
    ).toContain("loom.projection-groupby-keyed-unsupported");
  });

  it("rejects group by alongside a join", async () => {
    expect(
      await codes(
        context(`projection Nope { status: OrderStatus  customerName: string  orders: int
          from Order as o
          join Customer as c on o.customerId
          group by o.status
          select status = o.status, customerName = c.name, orders = count() }`),
      ),
    ).toContain("loom.projection-groupby-join-unsupported");
  });

  it("rejects group by with no aggregate select — that is just DISTINCT", async () => {
    expect(
      await codes(
        context(`projection Nope { status: OrderStatus
          from Order as o
          group by o.status
          select status = o.status }`),
      ),
    ).toContain("loom.projection-groupby-no-aggregate");
  });

  it("rejects a computed grouping key — group-by columns must be bare source columns", async () => {
    expect(
      await codes(
        context(`projection Nope { n: int  orders: int
          from Order as o
          group by o.lineCount + 1
          select n = o.lineCount, orders = count() }`),
      ),
    ).toContain("loom.projection-groupby-key-not-columnar");
  });

  it("rejects a per-row select that is not one of the grouping columns", async () => {
    expect(
      await codes(
        context(`projection Nope { status: OrderStatus  code: string  orders: int
          from Order as o
          group by o.status
          select status = o.status, code = o.code, orders = count() }`),
      ),
    ).toContain("loom.projection-groupby-select-not-grouped");
  });
});

describe("loom.projection-groupby-unsupported-backend (per-backend seam)", () => {
  // All five backends ship the grouped emit, so the gate is silent everywhere.
  // The check stays — it is the seam a NEW backend gates on until it ports.
  for (const platform of ["node", "python", "java", "dotnet", "elixir"]) {
    it(`is silent on ${platform}`, async () => {
      const cs = await codes(
        hostedOn(
          platform,
          `projection SalesByStatus { status: OrderStatus  orders: int
            from Order as o
            group by o.status
            select status = o.status, orders = count() }`,
        ),
      );
      expect(cs).not.toContain("loom.projection-groupby-unsupported-backend");
    });
  }
});
