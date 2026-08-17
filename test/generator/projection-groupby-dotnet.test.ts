// M-T4.2 — the GROUPED read model on .NET: `group by <col>, …` in a query-time
// projection emits ONE EF query — `GroupBy` on the real key columns (not the
// singleton arm's `GroupBy(_ => 1)` whole-table trick), aggregates computed per
// group server-side, `OrderBy`/`ThenBy` over exactly the grouping columns so
// the row order is deterministic across backends — returning the LIST shape
// (`IReadOnlyList<<P>Row>`), never the singleton object.
//
// Coercions follow the DECLARED row types: a key enum stays the enum type
// (JsonStringEnumConverter puts the member name on the wire), a key id unwraps
// to its Guid, and a money aggregate formats InvariantCulture — the same rules
// the per-row and singleton arms already pin.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (projections: string, deployableExtra = "", systemExtra = "") => `system Shop {
  ${systemExtra}
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Customer { name: string }
      aggregate Order {
        code: string
        total: money
        lineCount: int
        status: OrderStatus
        customerId: Customer id
        derived display: string = code
      }
      repository Orders for Order { }
      repository Customers for Customer { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      ${projections}
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable api { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 ${deployableExtra} }
}`;

const BY_STATUS = `projection SalesByStatus {
  status: OrderStatus
  orders: int
  revenue: money
  from Order as o
  where Confirmed
  group by o.status
  select status = o.status, orders = count(), revenue = sum(o.total)
}`;

async function fileEndingWith(source: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(source);
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  throw new Error(`no generated file ending with ${suffix}`);
}

describe(".NET grouped query-time projection (group by)", () => {
  it("aggregates in ONE grouped EF query — real key GroupBy, not the whole-table GroupBy(_ => 1)", async () => {
    const handler = await fileEndingWith(
      system(BY_STATUS),
      "Projections/SalesByStatusQpHandler.cs",
    );
    expect(handler).toContain(".GroupBy(o => new { o.Status })");
    expect(handler).not.toContain(".GroupBy(_ => 1)");
    expect(handler).toContain(
      ".Select(g => new { g.Key.Status, Orders = g.Count(), Revenue = g.Sum(o => o.Total) })",
    );
    // Never through the repository, which would materialise rows.
    expect(handler).not.toContain("_repo.");
  });

  it("folds the `where` into the same query and orders by the grouping key", async () => {
    const handler = await fileEndingWith(
      system(BY_STATUS),
      "Projections/SalesByStatusQpHandler.cs",
    );
    expect(handler).toContain(".Where(o => o.Status == OrderStatus.Confirmed)");
    // ORDER BY the grouping columns is REQUIRED — deterministic cross-backend reads.
    expect(handler).toContain(".OrderBy(x => x.Status)");
  });

  it("returns the LIST shape through the whole CQRS chain — never the singleton row", async () => {
    expect(
      await fileEndingWith(system(BY_STATUS), "Projections/SalesByStatusQpQuery.cs"),
    ).toContain("IQuery<IReadOnlyList<SalesByStatusRow>>");
    const handler = await fileEndingWith(
      system(BY_STATUS),
      "Projections/SalesByStatusQpHandler.cs",
    );
    expect(handler).toContain(
      "IQueryHandler<SalesByStatusQpQuery, IReadOnlyList<SalesByStatusRow>>",
    );
    expect(await fileEndingWith(system(BY_STATUS), "QueryProjectionsController.cs")).toContain(
      "Task<ActionResult<IReadOnlyList<SalesByStatusRow>>>",
    );
  });

  it("coerces to the declared row types — enum key stays the enum, money aggregate → invariant string", async () => {
    const handler = await fileEndingWith(
      system(BY_STATUS),
      "Projections/SalesByStatusQpHandler.cs",
    );
    // Key: the Row param is the enum type (JsonStringEnumConverter → wire member
    // name), so the raw key value passes through unconverted.
    expect(handler).toContain(
      // money pins the fixed wire scale (RS-12 / #2549) — "F4", not a bare
      // ToString, which would echo whatever scale SQL returned.
      'new SalesByStatusRow(x.Status, x?.Orders ?? 0, (x?.Revenue ?? 0m).ToString("F4", CultureInfo.InvariantCulture))',
    );
    // Row DTO declares the wire types: enum key, int count, money as string.
    const row = await fileEndingWith(system(BY_STATUS), "Projections/SalesByStatusRow.cs");
    expect(row).toContain("OrderStatus Status");
    expect(row).toContain("string Revenue");
  });

  it("multi-column grouping: composite anonymous key, ThenBy chain, id key unwraps to Guid", async () => {
    const handler = await fileEndingWith(
      system(`projection ByStatusAndCustomer {
        status: OrderStatus
        customerId: Customer id
        orders: int
        from Order as o
        group by o.status, o.customerId
        select status = o.status, customerId = o.customerId, orders = count()
      }`),
      "Projections/ByStatusAndCustomerQpHandler.cs",
    );
    expect(handler).toContain(".GroupBy(o => new { o.Status, o.CustomerId })");
    expect(handler).toContain(
      ".Select(g => new { g.Key.Status, g.Key.CustomerId, Orders = g.Count() })",
    );
    expect(handler).toContain(".OrderBy(x => x.Status).ThenBy(x => x.CustomerId)");
    // The Row declares `Guid CustomerId` (ids ride the .NET wire as Guid), so
    // the strongly-typed key unwraps via `.Value` — same as the per-row arm.
    expect(handler).toContain("x.CustomerId.Value");
  });

  it("emits the requires gate (403 before the query) exactly like the other projection handlers", async () => {
    const handler = await fileEndingWith(
      system(
        `projection SalesByStatus requires currentUser.role == "admin" {
          status: OrderStatus
          orders: int
          from Order as o
          group by o.status
          select status = o.status, orders = count()
        }`,
        "auth: required",
        "user { id: string role: string }",
      ),
      "Projections/SalesByStatusQpHandler.cs",
    );
    expect(handler).toContain("ICurrentUserAccessor _currentUser");
    expect(handler).toContain("var currentUser = _currentUser.User;");
    expect(handler).toContain(
      'if (!(currentUser.Role == "admin")) throw new ForbiddenException("Forbidden: projection SalesByStatus");',
    );
    // Gate fires BEFORE the grouped query runs.
    const gateIdx = handler.indexOf("throw new ForbiddenException");
    const queryIdx = handler.indexOf("var groups = await _db.");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("an ungated grouped projection emits no gate", async () => {
    const handler = await fileEndingWith(
      system(BY_STATUS),
      "Projections/SalesByStatusQpHandler.cs",
    );
    expect(handler).not.toContain("ForbiddenException");
  });
});
