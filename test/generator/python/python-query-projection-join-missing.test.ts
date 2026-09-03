// A query-time projection's `join` lookup is TOTAL on Python (G2667-D3,
// python arm — the .NET arm landed in #b75ce2c; matched here to the same
// ruling).
//
// `join <Agg> as c on <idRef>` bulk-loads the followed aggregate THROUGH its
// repository (`find_many_by_ids`), so the joined aggregate's own capability
// filters apply to that load: a `softDeletable` target that has been deleted,
// an out-of-tenant target under `tenantOwned`, or an ordinary dangling
// reference is simply ABSENT from the `{id: row}` dict the handler builds.
// The emitter indexed that dict directly (`customer_by_id[str(r.customer_id)].name`),
// so the read raised `KeyError` — a 500 produced by data the model permits,
// on a route that is not even about the missing row.
//
// The rule this pins is LEFT JOIN, matching the dotnet ruling: the source row
// survives and the joined field carries `None`. Dropping the source row
// instead would let a FOREIGN aggregate's filters change this projection's
// row count while the source aggregate's own list still shows the row — one
// silent failure traded for another.
//
// Why a string test: `mypy --strict`/`ruff` are blind to it (a `[key]` index
// and a guarded `.get(key)` both typecheck and lint clean) — only a runtime
// probe over data with a filtered-out join target would catch it, and no
// fixture in the corpus crosses a query-time projection join with a
// softDeletable target.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `Customer` is softDeletable, so the join target can genuinely vanish from
// the bulk load while the `Order` rows referencing it stay readable.
// `signedUpAt` (datetime) and `discount` (decimal) are joined too: their wire
// projection wraps the value in a call (`iso(...)` / the decimal narrowing),
// and that wrap must sit INSIDE the guard — a `None` receiver would otherwise
// AttributeError at exactly the point the guard exists to make safe.
const SRC = `
  system JoinSys {
    subdomain Sales { context Orders {
      aggregate Customer with crudish, softDeletable {
        name: string
        signedUpAt: datetime
        discount: decimal
      }
      aggregate Order with crudish {
        code: string
        customerId: Customer id
      }
      repository Orders for Order { }
      repository Customers for Customer { }
      projection OrderWithCustomer {
        orderId: Order id
        code: string
        customerName: string
        customerSignedUpAt: datetime
        customerDiscount: decimal
        from Order as o
        join Customer as c on o.customerId
        select orderId = o.id,
               code = o.code,
               customerName = c.name,
               customerSignedUpAt = c.signedUpAt,
               customerDiscount = c.discount
      }
    }}
    api OrdersApi from Sales
    storage pg { type: postgres }
    resource ordersState { for: Orders, kind: state, use: pg }
    deployable d {
      platform: python
      contexts: [Orders]
      dataSources: [ordersState]
      serves: OrdersApi
      port: 4000
    }
  }
`;

let cached: string | undefined;
async function routes(): Promise<string> {
  if (cached) return cached;
  const files = await generateSystemFiles(SRC);
  const key = [...files.keys()].find((k) => k.endsWith("http/query_projections_routes.py"));
  expect(key, "query_projections_routes.py not emitted").toBeDefined();
  cached = files.get(key!)!;
  return cached;
}

describe("python query-time projection — a join read never indexes the map directly (G2667-D3)", () => {
  it("never indexes the join map with a bare subscript", async () => {
    const r = await routes();
    // The old, crashing shape: `customer_by_id[str(r.customer_id)]`.
    expect(r).not.toMatch(/customer_by_id\[/);
  });

  it("guards the string field through .get(...) — None on a missing join row", async () => {
    const r = await routes();
    expect(r).toContain(
      '"customerName": (__j0.name if (__j0 := customer_by_id.get(str(r.customer_id))) is not None else None),',
    );
  });

  it("guards the datetime field — the iso() wrap sits INSIDE the guard, not applied to None", async () => {
    const r = await routes();
    expect(r).toContain(
      '"customerSignedUpAt": (iso(__j1.signed_up_at) if (__j1 := customer_by_id.get(str(r.customer_id))) is not None else None),',
    );
    // The would-be crash if the wrap were outside the guard.
    expect(r).not.toMatch(/iso\(customer_by_id\[/);
  });

  it("guards the decimal field the same way", async () => {
    const r = await routes();
    expect(r).toContain(
      '"customerDiscount": (__j2.discount if (__j2 := customer_by_id.get(str(r.customer_id))) is not None else None),',
    );
  });

  it("source-row fields (no join) are unaffected — still read straight off r", async () => {
    const r = await routes();
    expect(r).toContain('"orderId": r.id,');
    expect(r).toContain('"code": r.code,');
  });
});
