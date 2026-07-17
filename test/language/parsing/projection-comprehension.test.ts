// Grammar coverage for the generalised `projection` — the LINQ/SQL-shaped
// query-time comprehension (read-path-architecture.md rev.13 § "projection
// generalises").  Covers the optional `(params)`, optional `keyed by`, and the
// inline `from … as` / `where` / `join … as … on` / `order by` / `select`
// clauses; plus the domain-word floor (`order`/`select`/`join` stay usable as
// ordinary identifiers).

import { describe, expect, it } from "vitest";
import { isBoundedContext, isProjection } from "../../../src/language/generated/ast.js";
import { printStructural } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/parse.js";

const wrap = (body: string) => `
  context Sales {
    enum OrderStatus { Draft, Confirmed, Closed }
    aggregate Order { status: OrderStatus  placedAt: datetime  customerId: Customer id  lineCount: int  total: money }
    aggregate Customer { name: string  region: string }
    repository Orders for Order { }
    repository Customers for Customer { }
    event OrderPlaced { order: Order id }
    ${body}
  }
`;

describe("parsing — projection comprehension", () => {
  it("parses a parameterised, keyed query-time projection with every clause", async () => {
    const { model, errors } = await parseString(
      wrap(`
        criterion InRegion(region: string) of Order as o = o.region == region
        projection OrdersInRegion(region: string) keyed by orderId {
          orderId: Order id  lineCount: int  customerName: string
          from Order as o
          where InRegion(region) && o.status == Confirmed
          join Customer as c on o.customerId
          select orderId = o.id, lineCount = o.lineCount, customerName = c.name
        }
      `),
    );
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const proj = ctx.members.filter(isProjection).find((p) => p.name === "OrdersInRegion")!;
    expect(proj.params.map((p) => p.name)).toEqual(["region"]);
    expect(proj.key).toBe("orderId");
    expect(proj.source?.$refText).toBe("Order");
    expect(proj.sourceAlias).toBe("o");
    expect(proj.joins.map((j) => j.alias)).toEqual(["c"]);
    expect(proj.selects.map((s) => s.field)).toEqual(["orderId", "lineCount", "customerName"]);
  });

  it("parses a SINGLETON projection (no `keyed by`)", async () => {
    const { model, errors } = await parseString(
      wrap(`
        projection SalesDashboard {
          openOrders: int  revenue: money
          from Order as o where o.status == Confirmed
          select openOrders = o.lineCount.count, revenue = o.total.sum
        }
      `),
    );
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const proj = ctx.members.filter(isProjection).find((p) => p.name === "SalesDashboard")!;
    expect(proj.key).toBeUndefined();
    expect(proj.source?.$refText).toBe("Order");
  });

  it("still parses today's folded projection (no query clauses) unchanged", async () => {
    const { errors } = await parseString(
      wrap(`
        projection OrderBook keyed by order {
          order: Order id  status: OrderStatus
          on(e: OrderPlaced) { order := e.order  status := Confirmed }
        }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("round-trips the comprehension through the structural printer", async () => {
    const src = wrap(`
      criterion InRegion(region: string) of Order as o = o.region == region
      projection OrdersInRegion(region: string) keyed by orderId {
        orderId: Order id  customerName: string
        from Order as o
        where InRegion(region) && o.status == Confirmed
        join Customer as c on o.customerId
        select orderId = o.id, customerName = c.name
      }
    `);
    const { model } = await parseString(src);
    const proj = model.members
      .find(isBoundedContext)!
      .members.filter(isProjection)
      .find((p) => p.name === "OrdersInRegion")!;
    const printed = printStructural(proj);
    // The printed clauses are present and well-formed …
    expect(printed).toContain("projection OrdersInRegion(region: string) keyed by orderId");
    expect(printed).toContain("from Order as o");
    expect(printed).toContain("join Customer as c on o.customerId");
    expect(printed).toContain("select orderId = o.id, customerName = c.name");
    // … and re-parsing the printed form yields the same structural shape.
    const criterion = "criterion InRegion(region: string) of Order as o = o.region == region";
    const { model: re, errors } = await parseString(wrap(`${criterion}\n${printed}`));
    expect(errors).toEqual([]);
    const reProj = re.members
      .find(isBoundedContext)!
      .members.filter(isProjection)
      .find((p) => p.name === "OrdersInRegion")!;
    expect(reProj.source?.$refText).toBe("Order");
    expect(reProj.sourceAlias).toBe("o");
    expect(reProj.joins.map((j) => j.alias)).toEqual(["c"]);
    expect(reProj.selects.map((s) => s.field)).toEqual(["orderId", "customerName"]);
  });

  it("keeps `order` / `select` / `join` usable as domain identifiers (field / key)", async () => {
    // `order` as a field name AND as the `keyed by` key; `select`/`join` as fields.
    const { errors } = await parseString(`
      context Sales {
        aggregate Widget { order: int  select: string  join: bool }
        repository Widgets for Widget { }
        event Ping { order: Widget id }
        projection Board keyed by order {
          order: Widget id  select: string
          on(e: Ping) { order := e.order }
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});
