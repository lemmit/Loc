// Generator coverage for discriminated-union finds on the Phoenix/Ash backend
// (payload-transport-layer.md, P4d — Phoenix slice).  A `find x(): A or B`
// keeps its single-get Ash read action; the controller tags the result into
// the cross-backend `%{type: tag, …fields}` wire via a generated
// `tag_<union>/1` (one struct-pattern clause per variant), byte-compatible
// with the TS `z.discriminatedUnion("type", …)` and the .NET JsonPolymorphic
// records.  The generated project compiles under
// `mix compile --warnings-as-errors` (test/e2e/fixtures/elixir-ash-build/union.ddd).

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

// ---------------------------------------------------------------------------
// Find re-shape (exception-less.md A4) — a union-find with an `error` variant
// maps the absent variant to an RFC-7807 ProblemDetails at its status (the
// cross-backend absent-variant wire: Hono / .NET / Python / Java / vanilla),
// not a 200 tagged body.  The success variant stays inline-tagged.
// ---------------------------------------------------------------------------

const ABSENCE_SRC = `
system UnionShop {
  subdomain Sales {
    context Orders {
      error NotFound { resource: string }
      aggregate Order ids guid { code: string  region: string }
      repository Orders for Order { find recent(): Order or NotFound }
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

async function absenceController(): Promise<string> {
  const files = await generateSystemFiles(ABSENCE_SRC);
  const key = [...files.keys()].find((k) => k.endsWith("controllers/orders_controller.ex"))!;
  return files.get(key)!;
}

describe("phoenix generator — union-find with an error variant (A4)", () => {
  it("reads via the non-bang interface and maps the absent case to a 404 ProblemDetails", async () => {
    const ctrl = await absenceController();
    // The error payload has no struct on Ash, so the route can't pattern-match a
    // `%NotFound{}` — it reads via the non-bang `recent_order` and maps the
    // absent result (`{:ok, nil}` / `{:error, _}`) to the ProblemDetails.
    expect(ctrl).toContain("case PhoenixApp.Orders.recent_order() do");
    expect(ctrl).toContain("{:ok, record} when not is_nil(record) ->");
    expect(ctrl).toContain('|> put_resp_content_type("application/problem+json")');
    expect(ctrl).toContain("|> put_status(404)");
    // The absent-variant wire matches the other backends byte-for-byte:
    // `type`/`title`/`status`/`detail`/`instance` + the `resource` extension
    // carrying the aggregate name.
    expect(ctrl).toContain(
      '|> json(%{type: "/errors/not-found", title: "Not Found", status: 404, detail: "Not Found", instance: conn.request_path, resource: "Order"})',
    );
  });

  it("tags the success variant inline at 200", async () => {
    const ctrl = await absenceController();
    expect(ctrl).toContain("json(conn, tag_order_or_not_found(record))");
  });

  it("tags only the success variant — the error payload has no struct clause", async () => {
    const ctrl = await absenceController();
    expect(ctrl).toContain(
      'defp tag_order_or_not_found(%PhoenixApp.Orders.Order{} = v), do: %{type: "Order", id: v.id, code: v.code, region: v.region}',
    );
    // No `%PhoenixApp.Orders.NotFound{}` clause — that struct doesn't exist
    // (error payloads aren't reified on Ash), and the absent variant is a 404.
    expect(ctrl).not.toContain("tag_order_or_not_found(%PhoenixApp.Orders.NotFound{}");
  });
});
