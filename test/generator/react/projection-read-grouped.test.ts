// M-T1.3 Phase 4 — the GROUPED (`group by`) projection becomes frontend-
// readable, with the LIST response shape.
//
// Phase 1's client was singleton-only: one object out, `z.object` response,
// single-record `QueryView` binding.  A grouped projection returns one row
// PER GROUP — a JSON array — so its client wraps the same wireShape row in
// `z.array`, and the walker's query-shape derivation answers `single: false`
// so a `QueryView` binding list-binds exactly like a find-all (the A4
// decision: no new binding machinery — the existing collection arms read
// `.length` of a real array).  Sibling of `projection-read.test.ts`, which
// pins the singleton client byte-for-byte and is deliberately untouched.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** One grouped projection; `page` supplies the binding under test. */
const src = (page: string) => `
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
      projection SalesByStatus {
        status: OrderStatus
        orders: int
        revenue: money
        from Order as o
        group by o.status
        select status = o.status, orders = count(), revenue = sum(o.total)
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
        ${page}
      }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

const CHART_PAGE = `Chart { kind: "bar", of: Sales.SalesByStatus, x: r => r.status, y: r => r.revenue }`;

/** The react deployable's files, path-prefixed off the system tree. */
async function files(page = CHART_PAGE): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src(page));
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

describe("react grouped projection client", () => {
  it("wires the projections module for a grouped-only inventory", async () => {
    // Grouped is readable now, so react/index emits the module even with no
    // singleton in sight.
    expect((await files()).has("src/api/projections.ts")).toBe(true);
  });

  it("emits the row schema and wraps it in z.array — the LIST response", async () => {
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export const SalesByStatusRow = z.object({");
    expect(m).toContain("orders: z.number().int(),");
    expect(m).toContain("revenue: moneySchema,");
    expect(m).toContain("export const SalesByStatusResponse = z.array(SalesByStatusRow);");
    // The enum KEY renders INLINE (`z.enum([...])`), never as a reference to a
    // per-aggregate `<Enum>Schema` const this module doesn't import — the
    // unimported-reference form was a real TS2304 in the generated app.
    expect(m).toContain('status: z.enum(["Draft", "Confirmed"])');
    expect(m).not.toContain("OrderStatusSchema");
  });

  it("hook hits the projection route and parses the array", async () => {
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export function useSalesByStatus() {");
    expect(m).toContain('queryKey: ["projections", "sales_by_status"],');
    expect(m).toContain("await api.get(`/projections/sales_by_status`)");
    expect(m).toContain("return SalesByStatusResponse.parse(r);");
  });
});

describe("grouped projection bindings in a page", () => {
  it("binds through Chart — hook hoisted, list data, no unresolved receiver", async () => {
    const page = (await files()).get("src/pages/dash.tsx")!;
    expect(page).toContain('import { useSalesByStatus } from "../api/projections";');
    expect(page).toContain("const salesByStatus = useSalesByStatus();");
    expect(page).toContain("data={ salesByStatus.data ?? [] }");
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesByStatus");
  });

  it("list-binds through QueryView like a find-all (the A4 decision)", async () => {
    // `queryShape` answers `single: false, paged: false` for a grouped read,
    // so the COLLECTION arms render: emptiness is `.data.length === 0` of a
    // real array — not the singleton's `.data &&` object check, whose
    // one-object parse would have rejected the list wire.
    const page = (
      await files(
        `QueryView { of: Sales.SalesByStatus,
          empty: Text { "No data" },
          data: rows => Table(
            Column("Status", o => o.status),
            Column("Revenue", o => o.revenue),
            rows: rows) }`,
      )
    ).get("src/pages/dash.tsx")!;
    expect(page).toContain("const salesByStatus = useSalesByStatus();");
    expect(page).toContain("salesByStatus.data && salesByStatus.data.length === 0");
    expect(page).toContain("salesByStatus.data && salesByStatus.data.length > 0");
    expect(page).not.toContain("unresolved");
  });
});
