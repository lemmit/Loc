// A query-time projection's `join` lookup is TOTAL on node (G2667-D3, node arm).
//
// `join <Agg> as c on <idRef>` bulk-loads the followed aggregate THROUGH its
// repository (`findManyByIds`), so the joined aggregate's own capability
// filters apply to that load: a `softDeletable` target that has been deleted,
// an out-of-tenant target under `tenantOwned`, or an ordinary dangling
// reference is simply ABSENT from the `Map` the handler builds.  The emitter
// read it as `customerById.get(<key> as string)!.name` — a TypeError ("Cannot
// read properties of undefined") → 500, produced by data the model permits, on
// a route that is not even about the missing row.
//
// The rule pinned here is the .NET arm's: LEFT JOIN — the source row survives
// and the joined field carries the absent value.  Dropping the source row
// instead would let a FOREIGN aggregate's filters change this projection's row
// count while the source aggregate's own list still shows the row, trading one
// silent failure for another.
//
// Node emits ONE per-row bind per join ALIAS (`const __j0 = …get(…)`) rather
// than the .NET arm's one `out var` per joined SELECT: a `Map.get` is the whole
// lookup here, so every field on the same alias shares it.
//
// Why a string test: `tsc` is blind to it (`!` asserts the undefined away, which
// is exactly the bug), and the corpus e2e (`projection-join.ddd`) only exercises
// join targets that are present.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `Customer` is softDeletable, so the join target can genuinely vanish from the
// bulk load while the `Order` rows referencing it stay readable.  `signedUpAt`
// (datetime), `discount` (decimal) and `credit` (money) are joined too: each of
// their wire projections wraps the value in a CALL (the canonical-instant trim,
// `Number(...)`, `.toFixed(4)`), and that wrap must sit INSIDE the guard — on a
// null receiver it would throw at exactly the point the guard exists to make
// safe.
const SRC = (platform: string) => `
  system JoinSys {
    subdomain Sales { context Orders {
      aggregate Customer with crudish, softDeletable {
        name: string
        signedUpAt: datetime
        discount: decimal
        credit: money
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
        customerCredit: money
        from Order as o
        join Customer as c on o.customerId
        select orderId = o.id,
               code = o.code,
               customerName = c.name,
               customerSignedUpAt = c.signedUpAt,
               customerDiscount = c.discount,
               customerCredit = c.credit
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
  if (src === undefined) {
    const files = await generateSystemFiles(SRC(platform));
    const key = [...files.keys()].find((k) => k.endsWith("http/query-projections.ts"));
    expect(key, "http/query-projections.ts not emitted").toBeDefined();
    src = files.get(key!)!;
    cache.set(platform, src);
  }
  return src;
}

// The repository-sourced shape is adapter-NEUTRAL (both adapters synthesise the
// same projection find and both go through `findManyByIds`), so the guard has
// to hold on both — and asserting both is what proves the claim.
for (const [adapter, platform] of [
  ["drizzle", "node"],
  ["mikroorm", "node { persistence: mikroorm }"],
] as const) {
  describe(`query-projection join lookup is total — ${adapter}`, () => {
    it("never reads through a non-null assertion on the join map", async () => {
      const src = await handler(platform);
      // The shape that threw: `customerById.get(<key>)!`.
      expect(src).not.toMatch(/customerById\.get\([^)]*\)!/);
    });

    it("binds the lookup once per row and guards its presence", async () => {
      const src = await handler(platform);
      expect(src).toContain("const __j0 = customerById.get(r.customerId as string);");
      // One bind for the alias, shared by all four joined fields.
      expect([...src.matchAll(/const (__j\d+) = /g)]).toHaveLength(1);
      // The absent branch FILLS the row rather than dropping it — the source
      // row must still be projected.
      expect(src).toContain("__j0 === undefined ? null :");
    });

    it("keeps every wire wrap INSIDE the guarded branch", async () => {
      const src = await handler(platform);
      const guarded = [...src.matchAll(/(__j\d+) === undefined \? null : (.*?),\n/g)].map((m) => ({
        bind: m[1]!,
        arm: m[2]!,
      }));
      // name / signedUpAt / discount / credit.
      expect(guarded).toHaveLength(4);
      // Every present-branch reads through the bind, never the raw map.
      for (const g of guarded) {
        expect(g.arm).toContain(g.bind);
        expect(g.arm).not.toContain("customerById");
      }
      const armFor = (field: string): string =>
        guarded.find((g) => g.arm.includes(field))?.arm ?? "";
      // datetime → the canonical RS-4 trim; money → the fixed wire scale.
      // Both are CALLS on the joined value, so both would throw on `null`.
      expect(armFor("signedUpAt")).toContain('.toISOString().replace(/\\.?0+Z$/, "Z")');
      expect(armFor("credit")).toContain(".toFixed(4)");
    });

    it("still projects source-row fields off the row variable, unguarded", async () => {
      const src = await handler(platform);
      expect(src).toContain("code: r.code");
      // The source row is always present — no guard is emitted for it.
      expect(src).not.toContain("r.code === undefined");
    });
  });
}

describe("a join-free query projection keeps the expression-bodied map", () => {
  it("emits no per-row bind and no guard", async () => {
    const files = await generateSystemFiles(
      SRC("node")
        .replace("join Customer as c on o.customerId\n", "")
        .replace(/,\n *customerName = c\.name[\s\S]*?customerCredit = c\.credit/, "")
        .replace(/ *customerName: string\n/, "")
        .replace(/ *customerSignedUpAt: datetime\n/, "")
        .replace(/ *customerDiscount: decimal\n/, "")
        .replace(/ *customerCredit: money\n/, ""),
    );
    const key = [...files.keys()].find((k) => k.endsWith("http/query-projections.ts"));
    const src = files.get(key!)!;
    // Byte-for-byte the pre-existing shape: `rows.map((r) => ({ … }))`.
    expect(src).toContain("const projected = rows.map((r) => ({");
    expect(src).not.toContain("__j0");
  });
});
