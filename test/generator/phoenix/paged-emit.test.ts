// Generator coverage for paged finds on the Phoenix/Ash backend
// (payload-transport-layer.md, P3b emission — Phoenix slice).  A
// `find x(): <Agg> paged` emits an Ash read action with offset pagination,
// and a controller action that reads page/pageSize, passes Ash
// `page: [limit:, offset:, count: true]`, and maps the `%Ash.Page.Offset{}`
// to the cross-backend `{ items, page, pageSize, total, totalPages }` envelope.
// The generated project compiles against real Ash 3.x under
// `mix compile --warnings-as-errors` (test/e2e/fixtures/phoenix-build/paged.ddd);
// these unit tests pin the emitted Elixir shape.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system PagedShop {
  subdomain Sales {
    context Orders {
      aggregate Order ids guid { code: string  region: string }
      repository Orders for Order {
        find recent(): Order paged
        find inRegion(region: string): Order paged where this.region == region
      }
    }
  }
  api OrdersApi from Sales
  ui OrdersAdmin with scaffold(subdomains: [Sales]) { }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable phoenixApp {
    platform: phoenix
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    ui: OrdersAdmin
    port: 4000
  }
}
`;

describe("phoenix generator — paged finds (P3b)", () => {
  it("emits an Ash read action with offset pagination", async () => {
    const files = await generateSystemFiles(SRC);
    const resource = files.get("phoenix_app/lib/phoenix_app/orders/order.ex")!;
    expect(resource).toContain("read :recent do");
    expect(resource).toContain("pagination offset?: true, required?: false");
  });

  it("controller maps %Ash.Page.Offset{} to the paged envelope (1-based page/pageSize)", async () => {
    const files = await generateSystemFiles(SRC);
    const ctrl = files.get("phoenix_app/lib/phoenix_app_web/controllers/orders_controller.ex")!;
    expect(ctrl).toContain('page = String.to_integer(params["page"] || "1")');
    expect(ctrl).toContain('page_size = String.to_integer(params["pageSize"] || "20")');
    expect(ctrl).toContain("offset = (page - 1) * page_size");
    expect(ctrl).toContain(
      "PhoenixApp.Orders.recent_order!(page: [limit: page_size, offset: offset, count: true])",
    );
    expect(ctrl).toContain("total = result.count || 0");
    expect(ctrl).toContain("total_pages = if page_size > 0, do: ceil(total / page_size), else: 0");
    expect(ctrl).toContain(
      "json(conn, %{items: result.results, page: page, pageSize: page_size, total: total, totalPages: total_pages})",
    );
  });

  it("threads a find's domain arg ahead of the page option", async () => {
    const files = await generateSystemFiles(SRC);
    const ctrl = files.get("phoenix_app/lib/phoenix_app_web/controllers/orders_controller.ex")!;
    expect(ctrl).toContain(
      'PhoenixApp.Orders.in_region_order!(params["region"], page: [limit: page_size, offset: offset, count: true])',
    );
  });
});
