// A DIRECT-TABLE query-time projection (a whole-table or grouped aggregation)
// reads the source table WITHOUT going through the repository — that is the
// point of the shape: the aggregation pushes down to SQL and materialises no
// rows.  On `persistence: dapper` it also skipped the source aggregate's
// CAPABILITY filters, which the repository-sourced arm of the very same feature
// applies for free.
//
// A SILENT WRONG ANSWER, not a broken build: `SELECT count(*)::int AS total
// FROM orders` counted soft-deleted rows, and over a `tenantOwned` aggregate
// counted EVERY TENANT'S — while `.all` on the same aggregate answered
// correctly.  One feature, two arms, two different numbers; on the tenancy
// filters, a cross-tenant disclosure.
//
// The EF sibling of this adapter is correct by construction (`HasQueryFilter`
// applies to the LINQ aggregation), which is why the omission survived the
// dotnet compile leg and the OpenAPI parity diff alike.  #2609 fixed the same
// omission on drizzle / mikroorm / python and named dapper as the follow-up;
// this is it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const DAPPER = "dotnet { persistence: dapper }";

/** `softDeletable` contributes a NON-principal filter (`!this.isDeleted`). */
const softDeleteSystem = (platform: string) => `
  system ProjSys {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish, softDeletable {
          code: string
          total: money
        }
        repository Orders for Order { }
        projection OrderVolume {
          total: int
          from Order as o
          select total = count()
        }
        projection ByCode {
          code: string
          total: int
          from Order as o
          group by o.code
          select code = o.code, total = count()
        }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    deployable api {
      platform: ${platform}
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 3001
    }
  }
`;

/** `tenantOwned` contributes a PRINCIPAL filter, and `ignoring *` must drop it. */
const tenancySystem = (platform: string) => `
  system ProjTSys {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain Sales {
      context Orders {
        aggregate Order with crudish, tenantOwned {
          code: string
          total: money
        }
        aggregate Org with crudish {
          name: string
          implements tenantRegistry
        }
        repository Orders for Order { }
        repository Orgs for Org { }
        projection OrderVolume {
          total: int
          from Order as o
          select total = count()
        }
        projection AllVolume {
          total: int
          from Order as o ignoring *
          select total = count()
        }
      }
    }
    api SalesApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    deployable api {
      platform: ${platform}
      contexts: [Orders]
      dataSources: [ordersState]
      serves: SalesApi
      port: 3001
      auth: required
    }
  }
`;

async function handler(src: string, projection: string): Promise<string> {
  for (const [path, body] of await generateSystemFiles(src)) {
    if (path.endsWith(`Application/Projections/${projection}QpHandler.cs`)) return body;
  }
  throw new Error(`${projection}QpHandler.cs not emitted`);
}

describe("dapper direct-table aggregations apply the source's capability filters", () => {
  it("the whole-table arm carries a non-principal filter", async () => {
    const src = await handler(softDeleteSystem(DAPPER), "OrderVolume");
    expect(src).toContain("SELECT count(*)::int AS total FROM orders WHERE (NOT is_deleted)");
  });

  it("the grouped arm carries it too", async () => {
    const src = await handler(softDeleteSystem(DAPPER), "ByCode");
    expect(src).toContain("FROM orders WHERE (NOT is_deleted) GROUP BY code");
  });

  it("a tenantOwned source scopes to the caller — and BINDS the principal param", async () => {
    const src = await handler(tenancySystem(DAPPER), "OrderVolume");
    expect(src).toContain("FROM orders WHERE (tenant_id = @__cu_tenantId)");
    // Naming the param without binding it is a RUNTIME Npgsql error, so the
    // binding + the accessor it reads from are part of the same fix.
    expect(src).toContain("__cu_tenantId = currentUser.TenantId");
    expect(src).toContain("private readonly ICurrentUserAccessor _currentUser;");
    expect(src).toContain("var currentUser = _currentUser.User;");
  });

  it("`ignoring *` drops the predicate for that read only — and its param with it", async () => {
    const src = await handler(tenancySystem(DAPPER), "AllVolume");
    expect(src).toContain('SELECT count(*)::int AS total FROM orders"');
    expect(src).not.toContain("@__cu_tenantId");
    // No surviving principal reference ⇒ no accessor injected (an unused
    // constructor dependency is dead weight, and `/warnaserror` notices).
    expect(src).not.toContain("ICurrentUserAccessor");
  });
});

describe("the EF sibling is unchanged — it inherits the filter from HasQueryFilter", () => {
  it("still emits the bare LINQ aggregation over the filtered DbSet", async () => {
    const src = await handler(softDeleteSystem("dotnet"), "OrderVolume");
    expect(src).toContain("_db.Orders.AsNoTracking()");
    expect(src).not.toContain("IsDeleted");
  });
});
