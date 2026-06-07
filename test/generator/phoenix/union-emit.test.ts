// Generator coverage for discriminated-union finds on the Phoenix/Ash backend
// (payload-transport-layer.md, P4d — Phoenix slice).  A `find x(): A or B`
// keeps its single-get Ash read action; the controller tags the result into
// the cross-backend `%{type: tag, …fields}` wire via a generated
// `tag_<union>/1` (one struct-pattern clause per variant), byte-compatible
// with the TS `z.discriminatedUnion("type", …)` and the .NET JsonPolymorphic
// records.  The generated project compiles under
// `mix compile --warnings-as-errors` (test/e2e/fixtures/phoenix-build/union.ddd).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system UnionShop {
  subdomain Sales {
    context Orders {
      aggregate Order ids guid { code: string  region: string }
      aggregate Cancel ids guid { reason: string }
      repository Orders for Order { find recent(): Order or Cancel }
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

async function controller(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const key = [...files.keys()].find((k) => k.endsWith("controllers/orders_controller.ex"))!;
  return files.get(key)!;
}

describe("phoenix generator — discriminated-union finds (P4d)", () => {
  it("the find action tags the result via tag_<union>", async () => {
    const ctrl = await controller();
    expect(ctrl).toContain("def recent(conn, params) do");
    expect(ctrl).toContain("result = PhoenixApp.Orders.recent_order!()");
    expect(ctrl).toContain("json(conn, tag_order_or_cancel(result))");
  });

  it("emits a tagger with one struct-pattern clause per variant → the tagged-map wire", async () => {
    const ctrl = await controller();
    expect(ctrl).toContain(
      'defp tag_order_or_cancel(%PhoenixApp.Orders.Order{} = v), do: %{type: "Order", id: v.id, code: v.code, region: v.region}',
    );
    expect(ctrl).toContain(
      'defp tag_order_or_cancel(%PhoenixApp.Orders.Cancel{} = v), do: %{type: "Cancel", id: v.id, reason: v.reason}',
    );
    // Catch-all keeps the function total (compiles clean; raises at runtime
    // for an unhandled / producer-side variant).
    expect(ctrl).toContain("defp tag_order_or_cancel(_other), do: raise(ArgumentError,");
  });
});
