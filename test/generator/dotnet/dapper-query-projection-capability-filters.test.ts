// .NET/Dapper — a query-time projection AGGREGATION carries the source
// aggregate's capability filters (audit A1).
//
// The two adapters of ONE backend disagreed here.  EF installs `tenantOwned` /
// `softDeletable` / any `filter <expr>` once via `HasQueryFilter`, so its
// aggregation arm inherits them for free.  Dapper has no such thing — every
// read splices the predicate into its own SQL — and the aggregation arms wrote
// their SELECT from the projection's `where` alone, so the same model reported
// GLOBAL totals on `persistence: dapper` and tenant-scoped ones on `efcore`.
//
// `dotnet build` proves the C# compiles; the SQL is a string literal, so a
// missing WHERE conjunct is invisible to it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SOURCE = (persistence: string) => `
system S {
  user { id: guid  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain D {
    context C {
      enum OrderStatus { Draft Confirmed }
      aggregate Order with tenantOwned, softDeletable, crudish {
        code: string
        total: money
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order { }
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed

      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        select orders = count(), revenue = sum(o.total)
      }
      projection OrderVolume {
        total: int
        from Order as o
        select total = count()
      }
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count()
      }
      projection AllTimeVolume {
        total: int
        from Order as o
        ignoring softDeletable
        select total = count()
      }
    }
    context A { aggregate Organization with crudish { name: string } }
  }
  api Api from D
  storage pg { type: postgres }
  resource cState { for: C, kind: state, use: pg }
  resource aState { for: A, kind: state, use: pg }
  deployable d {
    platform: dotnet { persistence: ${persistence} }
    contexts: [C, A]
    dataSources: [cState, aState]
    serves: Api
    port: 4000
    auth: required
  }
}`;

const SINGLETON = "d/Application/Projections/SalesTotalsQpHandler.cs";
const UNFILTERED = "d/Application/Projections/OrderVolumeQpHandler.cs";
const GROUPED = "d/Application/Projections/SalesByStatusQpHandler.cs";
const IGNORING = "d/Application/Projections/AllTimeVolumeQpHandler.cs";

let cache: Map<string, string> | undefined;
async function dapper(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SOURCE("dapper"));
  return cache;
}

// The two predicates the source aggregate contributes, as `whereToSql` renders
// them (each already parenthesised).
const SQL_CAPS = "(tenant_id = @__cu_tenantId) AND (NOT is_deleted)";

describe("Dapper query-projection aggregations apply the source capability filters", () => {
  it("the WHOLE-TABLE aggregation ANDs them into the same SELECT as its `where`", async () => {
    const src = (await dapper()).get(SINGLETON)!;
    expect(src).toContain(
      "SELECT count(*)::int AS orders, sum(total)::numeric AS revenue FROM orders " +
        `WHERE (status = 'Confirmed') AND ${SQL_CAPS}`,
    );
  });

  it("an UNFILTERED aggregation gets them as its entire WHERE", async () => {
    const src = (await dapper()).get(UNFILTERED)!;
    expect(src).toContain(`SELECT count(*)::int AS total FROM orders WHERE ${SQL_CAPS}`);
  });

  it("the GROUPED aggregation carries them before GROUP BY", async () => {
    const src = (await dapper()).get(GROUPED)!;
    expect(src).toContain(
      `SELECT status, count(*)::int AS orders FROM orders WHERE ${SQL_CAPS} ` +
        "GROUP BY status ORDER BY status",
    );
  });

  it("binds the principal claim the SQL names — an unbound @param is a runtime failure", async () => {
    const src = (await dapper()).get(UNFILTERED)!;
    expect(src).toContain("private readonly ICurrentUserAccessor _currentUser;");
    expect(src).toContain("var currentUser = _currentUser.User;");
    expect(src).toContain("new { __cu_tenantId = currentUser.TenantId }");
  });

  it("`ignoring softDeletable` drops that conjunct and KEEPS the tenant one", async () => {
    const src = (await dapper()).get(IGNORING)!;
    expect(src).toContain(
      "SELECT count(*)::int AS total FROM orders WHERE (tenant_id = @__cu_tenantId)",
    );
    expect(src).not.toContain("is_deleted");
  });

  it("leaves the EF adapter alone — it inherits HasQueryFilter", async () => {
    const files = await generateSystemFiles(SOURCE("efcore"));
    const src = files.get(UNFILTERED)!;
    expect(src).toContain("private readonly AppDbContext _db;");
    expect(src).toContain(".GroupBy(_ => 1)");
    expect(src).not.toContain("tenant_id");
    // The model-level filter that makes that correct.
    const model = [...files.keys()].find((k) => k.endsWith("AppDbContext.cs"));
    expect(files.get(model!)!).toContain("HasQueryFilter");
  });
});
