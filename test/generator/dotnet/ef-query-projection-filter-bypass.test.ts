// ---------------------------------------------------------------------------
// .NET/EF — a query-time projection AGGREGATION honours the source's
// `ignoring` clause (08-17 follow-up register item 1, still open on 08-24).
//
// The dapper half landed first (#2603/#2637): its aggregation arms splice the
// source aggregate's capability predicates into their own SQL, and an
// `ignoring` clause simply omits the ones its capabilities contributed.  The EF
// arms consulted `aggregationCapabilityFilters` ONLY under dapper — correct as
// far as it went, because EF installs each capability predicate as a
// model-level NAMED query filter the aggregation inherits for free.  But that
// left `ignoring <Cap>` / `ignoring *` completely DEAD on EF: the very filters
// the read declared it was bypassing kept applying, while the repository read
// path honoured the same clause (`ignoreFiltersClause`) and dapper honoured it
// too.  One model, three answers, and the wrong one is silent — the numbers are
// simply narrower than asked for.
//
// EF Core 10 named filters make partial bypass expressible: `ignoring <Cap>`
// names only that capability's filters and the rest stay armed.  Bypass is
// CAPABILITY-ORIGIN-ONLY on both adapters — a bare `filter <expr>` has no
// capability behind it and survives even `ignoring *`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
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
        // A BARE filter — no capability behind it, so no \`ignoring\` drops it.
        filter this.code != ""
      }
      repository Orders for Order { }

      projection AllTimeVolume {
        total: int
        from Order as o
        ignoring softDeletable
        select total = count()
      }
      projection EverythingVolume {
        total: int
        from Order as o
        ignoring *
        select total = count()
      }
      projection ByStatusAllTime {
        status: OrderStatus
        orders: int
        from Order as o
        ignoring softDeletable
        group by o.status
        select status = o.status, orders = count()
      }
      projection Scoped {
        total: int
        from Order as o
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
    platform: dotnet
    contexts: [C, A]
    dataSources: [cState, aState]
    serves: Api
    port: 4000
    auth: required
  }
}
`;

const P = (name: string) => `d/Application/Projections/${name}QpHandler.cs`;
const CONFIG = "d/Infrastructure/Persistence/Configurations/OrderConfiguration.cs";

describe("EF query-projection aggregations honour `ignoring`", () => {
  it("registers the three named query filters the bypass clauses refer to", async () => {
    // The whole mechanism rests on these NAMES matching: `IgnoreQueryFilters`
    // throws at query time on a name the model never registered.
    const config = (await generateSystemFiles(SRC)).get(CONFIG)!;
    expect(config).toContain('builder.HasQueryFilter("CodeFilter"');
    expect(config).toContain('builder.HasQueryFilter("IsDeletedFilter"');
    const model = (await generateSystemFiles(SRC)).get(
      "d/Infrastructure/Persistence/AppDbContext.cs",
    )!;
    expect(model).toContain('HasQueryFilter("TenantIdFilter"');
  });

  it("`ignoring <Cap>` drops that capability's filter and KEEPS the others", async () => {
    const src = (await generateSystemFiles(SRC)).get(P("AllTimeVolume"))!;
    expect(src).toContain('_db.Orders.AsNoTracking().IgnoreQueryFilters(["IsDeletedFilter"])');
    // Tenancy still scopes the count — bypassing soft-delete must not widen it
    // across tenants.
    expect(src).not.toContain("TenantIdFilter");
  });

  it("the GROUPED arm bypasses identically", async () => {
    const src = (await generateSystemFiles(SRC)).get(P("ByStatusAllTime"))!;
    expect(src).toContain('_db.Orders.AsNoTracking().IgnoreQueryFilters(["IsDeletedFilter"])');
  });

  it("`ignoring *` drops every CAPABILITY filter — the bare one survives", async () => {
    const src = (await generateSystemFiles(SRC)).get(P("EverythingVolume"))!;
    expect(src).toContain(
      '_db.Orders.AsNoTracking().IgnoreQueryFilters(["TenantIdFilter", "IsDeletedFilter"])',
    );
    // `CodeFilter` has no capability origin, so no `ignoring` reaches it — the
    // Dapper twin keeps it too (`aggregationCapabilityFilters`).  The
    // parameterless `IgnoreQueryFilters()` overload would have dropped it.
    expect(src).not.toContain("CodeFilter");
    expect(src).not.toContain("IgnoreQueryFilters()");
  });

  it("a projection with no `ignoring` keeps the untouched inherited-filter query", async () => {
    const src = (await generateSystemFiles(SRC)).get(P("Scoped"))!;
    expect(src).toContain("_db.Orders.AsNoTracking()\n");
    expect(src).not.toContain("IgnoreQueryFilters");
  });
});
