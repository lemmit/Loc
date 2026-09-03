// A query-time projection's `join` lookup is TOTAL on .NET (G2667-D3).
//
// `join <Agg> as c on <idRef>` bulk-loads the followed aggregate THROUGH its
// repository (`FindManyByIdsAsync`), so the joined aggregate's own capability
// filters apply to that load: a `softDeletable` target that has been deleted,
// an out-of-tenant target under `tenantOwned`, or an ordinary dangling
// reference is simply ABSENT from the dictionary the handler builds.  The
// emitter indexed that dictionary directly (`customerById[d.CustomerId].Name`),
// so the read threw `KeyNotFoundException` — a 500 produced by data the model
// permits, on a route that is not even about the missing row.
//
// The rule this pins is LEFT JOIN: the source row survives and the joined field
// carries the wire type's empty value.  Dropping the source row instead would
// let a FOREIGN aggregate's filters change this projection's row count while
// the source aggregate's own list still shows the row — one silent failure
// traded for another.
//
// Why a string test: `dotnet build` is blind to it (an indexer and a
// `TryGetValue` both compile), and the corpus e2e (`projection-join.ddd`) only
// exercises join targets that are present.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `Customer` is softDeletable, so the join target can genuinely vanish from the
// bulk load while the `Order` rows referencing it stay readable.  `signedUpAt`
// (a datetime) and `discount` (a decimal) are joined too: their wire projection
// wraps the value in a call (`.ToString(...)` / the decimal narrowing), and
// that wrap must sit INSIDE the guard — a null receiver would otherwise NRE at
// exactly the point the guard exists to make safe.
const SRC = (platform: string) => `
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
      platform: ${platform}
      contexts: [Orders]
      dataSources: [ordersState]
      serves: OrdersApi
      port: 4000
    }
  }
`;

const cache = new Map<string, string>();
async function handler(platform: string): Promise<string> {
  let src = cache.get(platform);
  if (!src) {
    const files = await generateSystemFiles(SRC(platform));
    const key = [...files.keys()].find((k) =>
      k.endsWith("Application/Projections/OrderWithCustomerQpHandler.cs"),
    );
    expect(key, "OrderWithCustomerQpHandler.cs not emitted").toBeDefined();
    src = files.get(key!)!;
    cache.set(platform, src);
  }
  return src;
}

for (const [adapter, platform] of [
  ["efcore", "dotnet"],
  ["dapper", "dotnet { persistence: dapper }"],
] as const) {
  describe(`query-projection join lookup is total — ${adapter}`, () => {
    it("never indexes the join dictionary directly", async () => {
      const src = await handler(platform);
      // The shape that threw: `customerById[<key>]`.
      expect(src).not.toMatch(/customerById\[/);
    });

    it("reads every joined field through TryGetValue, defaulting when absent", async () => {
      const src = await handler(platform);
      expect(src).toContain("customerById.TryGetValue(d.CustomerId, out var __j0)");
      // Three joined selects → three distinct out-vars in ONE lambda scope
      // (reusing a name is CS0128, which no string test would otherwise see).
      const tmps = [...src.matchAll(/out var (__j\d+)\)/g)].map((m) => m[1]!);
      expect(tmps).toHaveLength(3);
      expect(new Set(tmps).size).toBe(3);
      // The absent branch fills the row rather than dropping it.
      expect(src).toContain(": default!)");
    });

    it("keeps the wire projection INSIDE the guarded branch", async () => {
      const src = await handler(platform);
      // datetime → the canonical instant wire call; decimal → the narrowing
      // call.  Both must read the guarded temp, never a bare dictionary hit.
      const guarded = [
        ...src.matchAll(/TryGetValue\([^)]*out var (__j\d+)\) \? (.*?) : default!\)/g),
      ];
      expect(guarded).toHaveLength(3);
      for (const m of guarded) expect(m[2]!).toContain(m[1]!);
      const datetimeArm = guarded.find((m) => m[2]!.includes("SignedUpAt"))![2]!;
      expect(datetimeArm).toMatch(/__j\d+\.SignedUpAt/);
      expect(datetimeArm.length).toBeGreaterThan("__j0.SignedUpAt".length);
    });

    it("still projects source-row fields off the row variable", async () => {
      const src = await handler(platform);
      expect(src).toContain("d.Code");
    });
  });
}
