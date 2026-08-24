// Python/FastAPI — a query-time projection AGGREGATION carries the source
// aggregate's capability filters (audit A1).
//
// The aggregation shapes read the source TABLE directly (`select(func.count())
// .select_from(OrderRow)`), never through the repository that ANDs
// `tenantOwned` / `softDeletable` / any `filter <expr>` into every root read —
// so the emitted read applied only the projection's own `where`: a cross-tenant
// COUNT/SUM with `tenantOwned`, a plain wrong number with `softDeletable`.
//
// `mypy --strict` + `ruff` prove the module is well-formed; a missing WHERE
// conjunct is invisible to both.  What is pinned here is that the aggregation
// read carries the SAME predicate the repository carries in the same run,
// including the ambient `require_current_user()` binding and the `ignoring`
// bypass.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";
import { parseValid } from "../../_helpers/parse.js";

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
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    resource aState { for: A, kind: state, use: primary }
    deployable d {
      platform: python
      contexts: [C, A]
      dataSources: [cState, aState]
      serves: Api
      port: 4000
      auth: required
    }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

async function routes(): Promise<string> {
  const f = await files();
  const k = [...f.keys()].find((key) => key.endsWith("http/query_projections_routes.py"));
  expect(k, "query_projections_routes.py not emitted").toBeDefined();
  return f.get(k!)!;
}

// The two predicates the source aggregate contributes, as the SQLAlchemy
// repository spells them.
const PY_CAPS =
  "and_((OrderRow.tenant_id == require_current_user().tenant_id), not_(OrderRow.is_deleted))";

describe("python query-projection aggregations apply the source capability filters", () => {
  it("the WHOLE-TABLE aggregation ANDs the capability filters into the same query as its `where`", async () => {
    const r = await routes();
    expect(r).toContain(
      "select(func.count(), func.sum(OrderRow.total)).select_from(OrderRow)" +
        `.where(and_((OrderRow.status == OrderStatus.Confirmed), ${PY_CAPS}))`,
    );
  });

  it("an UNFILTERED aggregation gets the capability filters as its entire WHERE", async () => {
    const r = await routes();
    expect(r).toContain(`select(func.count()).select_from(OrderRow).where(${PY_CAPS})`);
  });

  it("the GROUPED aggregation carries them too", async () => {
    const r = await routes();
    expect(r).toContain(`.select_from(OrderRow).where(${PY_CAPS})`);
    expect(r).toContain(".group_by(OrderRow.status)");
  });

  it("`ignoring softDeletable` drops that conjunct and KEEPS the tenant one", async () => {
    const r = await routes();
    expect(r).toContain(
      "select(func.count()).select_from(OrderRow)" +
        ".where((OrderRow.tenant_id == require_current_user().tenant_id))",
    );
  });

  it("imports the ambient accessor the repository binds the principal through", async () => {
    const f = await files();
    const r = await routes();
    expect(r).toContain("from app.auth.user import require_current_user");
    const repo = [...f.keys()].find((k) => k.endsWith("repositories/order_repository.py"));
    expect(f.get(repo!)!).toContain(PY_CAPS);
  });
});
