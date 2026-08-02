// M-T1.3 Phase 1 — a page READS a query-time projection.
//
// Before this, projections were backend-only read models: each owned an HTTP
// route no generated frontend ever called.  A page that tried validated clean
// and emitted `/* unresolved: Sales */ undefined.SalesTotals.isLoading` — a
// runtime TypeError AND a build break — because `lower-ui.ts` had no projection
// arm and `_frontend/api-module.ts` emitted no client.
//
// The three pieces that close it, each pinned below: detector Pattern H
// (`<apiHandle>.<Projection>`), the `src/api/projections.ts` client, and the
// single-record binding a singleton needs (one object out, so the collection
// semantics would read `.length` on an object and render nothing).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order {}
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        select orders = count, revenue = sum(o.total)
      }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView {
          of: Sales.SalesTotals,
          empty: Text { "No data" },
          data: t => Group {
            Stat { "Orders", t.orders },
            Stat { "Revenue", Money { t.revenue } }
          }
        }
      }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The react deployable's files, path-prefixed off the system tree. */
async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

describe("react projection client", () => {
  it("emits a `src/api/projections.ts` module", async () => {
    expect((await files()).has("src/api/projections.ts")).toBe(true);
  });

  it("mirrors the backend row shape field-for-field", async () => {
    // Both sides read the same `wireShape`, so they cannot drift.  Money is the
    // interesting one: `moneySchema` parses the wire string into a Decimal.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export const SalesTotalsResponse = z.object({");
    expect(m).toContain("orders: z.number().int(),");
    expect(m).toContain("revenue: moneySchema,");
  });

  it("hits the projection's own route with no arguments", async () => {
    // A singleton read takes no id and no query — the projection IS the row.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export function useSalesTotals() {");
    expect(m).toContain('queryKey: ["projections", "sales_totals"],');
    expect(m).toContain("await api.get(`/projections/sales_totals`)");
    expect(m).toContain("return SalesTotalsResponse.parse(r);");
  });

  it("is NOT emitted for a projection-free app", async () => {
    // Byte-identical output for every app that declares no readable
    // projection — the module is emitted on demand, not unconditionally.
    const plain = `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order {}
  } }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash { route: "/dash"  title: "D"  body: Stack { Text { "hi" } } }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}`;
    expect((await files(plain)).has("src/api/projections.ts")).toBe(false);
  });
});

describe("react projection read in a page", () => {
  it("resolves the read to a hoisted hook — no unresolved receiver", async () => {
    const page = (await files()).get("src/pages/dash.tsx")!;
    expect(page).toContain('import { useSalesTotals } from "../api/projections";');
    expect(page).toContain("const salesTotals = useSalesTotals();");
    // The defect this closes.
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesTotals");
  });

  it("binds SINGLE-record, since a singleton returns one object", async () => {
    // The collection semantics (`data.length === 0` / `> 0`) would read
    // `.length` on an object — always undefined, so the body would never
    // render.  Derived from the query, not from an author-written `single:`.
    const page = (await files()).get("src/pages/dash.tsx")!;
    expect(page).toContain("{ salesTotals.data && (");
    expect(page).not.toContain("salesTotals.data.length");
  });

  it("reads row fields straight off `.data`", async () => {
    expect((await files()).get("src/pages/dash.tsx")!).toContain("salesTotals.data.orders");
  });
});

describe("Stat with a nested display primitive", () => {
  it("renders a money value through `Money` instead of dropping it", async () => {
    // A `money` deserialises client-side to a decimal.js `Decimal`: a bare
    // React child is `TS2322: Type 'Decimal' is not assignable to ReactNode`.
    // Wrapping it used to render EMPTY — the text path coerced the nested call
    // away — which left no way at all to put a currency figure on a KPI card.
    const page = (await files()).get("src/pages/dash.tsx")!;
    expect(page).toContain("<MoneyValue value={ salesTotals.data.revenue } />");
  });

  it("leaves a plain expression value on the text path", async () => {
    // The nested-primitive branch must not disturb the ordinary slot.
    expect((await files()).get("src/pages/dash.tsx")!).toContain(
      ">{salesTotals.data.orders}</Text>",
    );
  });
});
