// A DIRECT-TABLE query-time projection (a whole-table or grouped aggregation)
// reads the source table without going through the repository — that is the
// point of the shape: the aggregation pushes down to SQL and materialises no
// rows.  Until this suite existed it also skipped the source aggregate's
// CAPABILITY filters, which the repository-sourced arm of the very same feature
// applies for free (it reads through the synthesised `repo.<proj>()` find).
//
// That is a SILENT WRONG ANSWER, not a broken build: `count()` over a
// `softDeletable` aggregate counted its soft-deleted rows, and over a
// `tenantOwned` one counted every tenant's — while `.all` on the same aggregate
// answered correctly.  One feature, two arms, two different numbers.
//
// Per-backend disposition, verified by generating the same source:
//   node/drizzle, node/mikroorm, python  — the filter must be in the emitted
//     direct-table read (these three build the WHERE themselves).
//   java        — correct by construction: `@SQLRestriction` sits on the entity,
//     so Hibernate applies it to the JPQL aggregation too.
//   dotnet/efcore — correct by construction: `HasQueryFilter` applies to the
//     LINQ aggregation.
//   dotnet/dapper — NOT covered here: its raw-Npgsql arm has the same omission
//     and is out of this change's scope (reported as follow-up).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

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

async function fileContaining(src: string, needle: string): Promise<string> {
  for (const [path, body] of await generateSystemFiles(src)) if (path.includes(needle)) return body;
  return "";
}

describe("direct-table projection — node (Hono/Drizzle)", () => {
  it("ANDs the capability filter into the whole-table AND grouped aggregation", async () => {
    const f = await fileContaining(softDeleteSystem("node"), "query-projections");
    expect(f).toContain(
      "db.select({ total: count() }).from(schema.orders).where(not(eq(schema.orders.isDeleted, true)))",
    );
    expect(f).toContain(
      ".from(schema.orders).where(not(eq(schema.orders.isDeleted, true))).groupBy(schema.orders.code)",
    );
  });

  it("scopes a tenantOwned source to the caller, and honours `ignoring *`", async () => {
    const f = await fileContaining(tenancySystem("node"), "query-projections");
    expect(f).toContain(
      "db.select({ total: count() }).from(schema.orders).where(eq(schema.orders.tenantId, requireCurrentUser().tenantId))",
    );
    // The ambient accessor needs its import — an undefined name would not
    // compile, which is how a filter that is applied differs from one that is
    // merely rendered.
    expect(f).toContain(`import { requireCurrentUser } from "../auth/middleware";`);
    // `ignoring *` drops the capability predicate for that read ONLY.
    expect(f).toContain("db.select({ total: count() }).from(schema.orders);");
  });
});

describe("direct-table projection — node (Hono/MikroORM)", () => {
  const mikro = "node { persistence: mikroorm }";

  it("ANDs the capability filter into the QueryBuilder WHERE", async () => {
    const f = await fileContaining(softDeleteSystem(mikro), "query-projections");
    // Two direct-table reads (whole-table + grouped), each carrying the filter.
    expect([...f.matchAll(/qb\.where\(\{ isDeleted: false \}\);/g)].length).toBe(2);
  });

  it("scopes a tenantOwned source to the caller, and honours `ignoring *`", async () => {
    const f = await fileContaining(tenancySystem(mikro), "query-projections");
    expect(f).toContain("qb.where({ tenantId: requireCurrentUser().tenantId });");
    expect(f).toContain(`import { requireCurrentUser } from "../auth/middleware";`);
    // The bypassed read emits no `where` at all.
    expect([...f.matchAll(/qb\.where\(/g)].length).toBe(1);
  });
});

describe("direct-table projection — python (FastAPI/SQLAlchemy)", () => {
  it("ANDs the capability filter into both aggregation selects", async () => {
    const f = await fileContaining(softDeleteSystem("python"), "query_projections_routes");
    expect(f).toContain(
      "select(func.count()).select_from(OrderRow).where(not_(OrderRow.is_deleted))",
    );
    expect(f).toContain(".select_from(OrderRow).where(not_(OrderRow.is_deleted))");
  });

  it("scopes a tenantOwned source to the caller, and honours `ignoring *`", async () => {
    const f = await fileContaining(tenancySystem("python"), "query_projections_routes");
    expect(f).toContain(
      "select(func.count()).select_from(OrderRow).where((OrderRow.tenant_id == require_current_user().tenant_id))",
    );
    expect(f).toContain("from app.auth.user import require_current_user");
    // The bypassed read keeps the bare select.
    expect(f).toContain("select(func.count()).select_from(OrderRow))).one()");
  });
});

describe("direct-table projection — backends where the filter is entity-level", () => {
  it("java carries it as @SQLRestriction on the entity, so the JPQL aggregation inherits it", async () => {
    const files = await generateSystemFiles(softDeleteSystem("java"));
    const all = [...files.values()].join("\n");
    expect(all).toContain('@SQLRestriction("not (is_deleted)")');
    expect(all).toContain("select count(e) from Order e");
  });

  it("dotnet/efcore carries it as HasQueryFilter, so the LINQ aggregation inherits it", async () => {
    const files = await generateSystemFiles(softDeleteSystem("dotnet"));
    const all = [...files.values()].join("\n");
    expect(all).toContain('builder.HasQueryFilter("IsDeletedFilter", x => !x.IsDeleted);');
    expect(all).toContain("_db.Orders.AsNoTracking()");
  });
});
