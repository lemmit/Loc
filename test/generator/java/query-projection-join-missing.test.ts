// A query-time projection's `join` lookup is TOTAL on Java (G2667-D3, wave-2
// residue — landing the java arm alongside dotnet/node/python/elixir).
//
// `join <Agg> as c on <idRef>` bulk-loads the followed aggregate through its
// own (tenancy-/capability-scoped) `findAll()` into a `Map<idValue, Agg>`
// (`queryProjectionFindsFor` / the `aliasMap` in
// `src/generator/java/emit/query-projection-reads.ts`), so a `softDeletable`
// target that has been deleted, an out-of-tenant target under `tenantOwned`,
// or an ordinary dangling reference is simply ABSENT from that map.  Indexing
// it directly (`customerById.get(a.customerId().value()).name()`) was a
// `NullPointerException` — a 500 produced by data the model permits, on a
// route that is not even about the missing row.
//
// The rule this pins is LEFT JOIN (docs/conformance-semantics.md): the source
// row survives and the joined field carries wire `null`.  Dropping the source
// row instead would let a FOREIGN aggregate's filters change this
// projection's row count while the source aggregate's own list still shows
// the row — one silent failure traded for another.
//
// Why a string test: `gradle testClasses` is blind to it (a bare `.get(...)`
// and a null-guarded ternary both compile), and the corpus e2e only exercises
// join targets that are present.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// `Customer` is softDeletable, so the join target can genuinely vanish from
// the bulk load while the `Order` rows referencing it stay readable.
// `signedUpAt` (a datetime) and `discount` (a decimal) are joined too: their
// wire projection wraps the value in a call (`.toString()` / the double
// narrowing), and that wrap must sit INSIDE the guard — a null receiver would
// otherwise NPE at exactly the point the guard exists to make safe.
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
      platform: java
      contexts: [Orders]
      dataSources: [ordersState]
      serves: OrdersApi
      port: 4000
    }
  }
`;

let cache: string | undefined;
async function handler(): Promise<string> {
  if (cache !== undefined) return cache;
  const files = await generateSystemFiles(SRC);
  const key = [...files.keys()].find((k) => k.endsWith("OrdersQueryProjections.java"));
  expect(key, "OrdersQueryProjections.java not emitted").toBeDefined();
  cache = files.get(key!)!;
  return cache;
}

describe("query-projection join lookup is total — java", () => {
  it("reads every joined field through a null-guarded ternary, never a bare .get(...)", async () => {
    const src = await handler();
    // The shape that threw: `customerById.get(a.customerId().value()).name()`
    // with no preceding null check. Every one of the three joined selects
    // (name/signedUpAt/discount) must be reached through the SAME guard
    // prefix — count it exactly, so a partially-guarded regression (one
    // field fixed, the others left bare) still fails this test.
    const GUARD = "customerById.get(a.customerId().value()) == null ? null : ";
    const guardCount = src.split(GUARD).length - 1;
    expect(guardCount).toBe(3);
    // And every occurrence of the map lookup followed by a member call is
    // immediately preceded by that guard — i.e. there is no OTHER, unguarded
    // site reaching `.get(...)` and then dereferencing a member on it.
    const lookup = "customerById.get(a.customerId().value())";
    let idx = 0;
    let dereferenced = 0;
    while (true) {
      idx = src.indexOf(lookup, idx);
      if (idx === -1) break;
      const after = src.slice(idx + lookup.length, idx + lookup.length + 1);
      if (after === ".") {
        dereferenced++;
        expect(src.slice(idx - GUARD.length, idx)).toBe(GUARD);
      }
      idx += lookup.length;
    }
    expect(dereferenced).toBe(3);
  });

  it("keeps the wire projection INSIDE the guarded branch", async () => {
    const src = await handler();
    // datetime → `.toString()`; decimal → the `.doubleValue()` narrowing.
    // Both must read the guarded member call, never bare `.get(...)` piped
    // straight into the coercion (that would NPE on the absent row).
    expect(src).toContain(
      "customerById.get(a.customerId().value()) == null ? null : customerById.get(a.customerId().value()).name()",
    );
    expect(src).toContain(
      "customerById.get(a.customerId().value()) == null ? null : customerById.get(a.customerId().value()).signedUpAt().toString()",
    );
    expect(src).toContain(
      "customerById.get(a.customerId().value()) == null ? null : customerById.get(a.customerId().value()).discount().doubleValue()",
    );
  });

  it("still projects source-row fields off the row variable", async () => {
    const src = await handler();
    expect(src).toContain("a.code()");
  });
});
