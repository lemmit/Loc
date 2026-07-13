// Plain Ecto/Phoenix emission for the explicit application/transport layer
// (unfoldable-api-derivation.md, A2 — the Phoenix sibling of the .NET A1 test):
// `commandHandler` / `queryHandler` context members + `route <M> "<path>" ->
// <Ctx>.<Handler>` api bindings emit `<App>.<Ctx>.Handlers.<Name>` `run/1`
// modules (reusing the bespoke `with`-chain workflow engine) + one
// `<Api>RoutesController` spliced into the router ROOT `scope "/"` (at the
// route's absolute declared path, clear of the auto-CRUD `/api` routes).  The generated
// project compiles clean under `mix compile --warnings-as-errors` (gated on
// demand via LOOM_PHOENIX_VANILLA_BUILD).
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order ids guid {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
      commandHandler CancelOrder(orderId: Order id): Order id {
        let o = Orders.getById(orderId)
        o.cancel()
        return o.id
      }
      queryHandler GetStatus(orderId: Order id): string {
        let o = Orders.getById(orderId)
        return o.status
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/cancellations" -> Ordering.CancelOrder
    route GET  "/orders/{orderId}/status"        -> Ordering.GetStatus
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(m: Map<string, string>, suffix: string): string {
  const key = [...m.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return m.get(key!)!;
}

describe("elixir — explicit commandHandler/queryHandler → plain Ecto/Phoenix", () => {
  it("emits the command handler module: run/1, param destructure, with-chain, {:ok, o.id}", async () => {
    const h = fileEndingWith(await files(), "lib/api/ordering/handlers/cancel_order.ex");
    expect(h).toContain("defmodule Api.Ordering.Handlers.CancelOrder do");
    expect(h).toContain("alias Api.Ordering, as: Context");
    expect(h).toContain("def run(params) when is_map(params) do");
    // referenced param destructured off the string-keyed run/1 map:
    expect(h).toContain('%{"order_id" => order_id} = params');
    // repo-let getById → context get_<agg>; op-call → context <op>_<agg> (which
    // itself persists via persist_change — no redundant update clause):
    expect(h).toContain("with {:ok, o} <- Context.get_order(order_id)");
    expect(h).toContain("{:ok, _} <- Context.cancel_order(o, %{})");
    expect(h).not.toContain("update_order");
    // return projects the aggregate id:
    expect(h).toContain("{:ok, o.id}");
    expect(h).not.toContain("__bad__");
  });

  it("emits the query handler module returning the resolved returnValue (no __bad__)", async () => {
    const h = fileEndingWith(await files(), "lib/api/ordering/handlers/get_status.ex");
    expect(h).toContain("defmodule Api.Ordering.Handlers.GetStatus do");
    expect(h).toContain("with {:ok, o} <- Context.get_order(order_id) do");
    expect(h).toContain("{:ok, o.status}");
    expect(h).not.toContain("__bad__");
  });

  it("emits one RoutesController per api dispatching each route through the handler's run/1", async () => {
    const ctrl = fileEndingWith(
      await files(),
      "lib/api_web/controllers/sales_api_routes_controller.ex",
    );
    expect(ctrl).toContain("defmodule ApiWeb.SalesApiRoutesController do");
    expect(ctrl).toContain("use ApiWeb, :controller");
    // one action per route calling the target handler module's run/1:
    expect(ctrl).toContain("def cancel_order(conn, params) do");
    expect(ctrl).toContain("respond(conn, Api.Ordering.Handlers.CancelOrder.run(params))");
    expect(ctrl).toContain("def get_status(conn, params) do");
    expect(ctrl).toContain("respond(conn, Api.Ordering.Handlers.GetStatus.run(params))");
    // shared respond/2 maps the typed result tuples to HTTP:
    expect(ctrl).toContain("def respond(conn, {:ok, result}) do");
    expect(ctrl).toContain("def respond(conn, {:error, :not_found})");
  });

  it("splices the explicit routes into the router ROOT scope, not /api (braces → :snake path params)", async () => {
    // The explicit `route "<path>" -> ...` path is absolute, so it must serve at
    // that path in the root `scope "/"` (controller carries the `ApiWeb.` prefix
    // since the root scope has no module alias) — NOT nested under `scope "/api"`,
    // where it would both mis-serve (`/api/orders/...`) and shadow the auto-CRUD
    // routes (Phoenix ignores param names → `--warnings-as-errors` failure).
    const router = fileEndingWith(await files(), "lib/api_web/router.ex");
    expect(router).toContain(
      'post "/orders/:order_id/cancellations", ApiWeb.SalesApiRoutesController, :cancel_order',
    );
    expect(router).toContain(
      'get "/orders/:order_id/status", ApiWeb.SalesApiRoutesController, :get_status',
    );
    // The explicit routes live in the root scope, above `scope "/api"`.
    const rootIdx = router.indexOf('scope "/" do');
    const apiIdx = router.indexOf('scope "/api"');
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(router.indexOf("SalesApiRoutesController")).toBeGreaterThan(rootIdx);
    expect(router.indexOf("SalesApiRoutesController")).toBeLessThan(apiIdx);
    // …and NOT the bare (aliased) form that `scope "/api"` would emit.
    expect(router).not.toContain('", SalesApiRoutesController, :cancel_order');
  });
});

// Regression (A3.3 review): a scaffolded `destroy` produces an explicit
// `DELETE /orders/{orderId}` route whose Phoenix path (`/orders/:order_id`) is
// identical — param names aside — to the always-on auto-CRUD `DELETE
// /orders/:id`.  Nesting the explicit route under `scope "/api"` made the
// auto-CRUD clause shadow it, failing `mix compile --warnings-as-errors`.
// Root-scoping keeps the two at distinct paths (`/orders/...` vs
// `/api/orders/...`), so they coexist and compile — matching every other backend.
const DESTROY_SRC = `
system Shop {
  subdomain Sales {
    context Ordering with scaffoldHandlers {
      aggregate Order {
        code: string
        status: string
        operation cancel() { status := "cancelled" }
        destroy { }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi with scaffoldApi(of: Sales)
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("elixir — scaffolded destroy route does not collide with auto-CRUD", () => {
  it("root-scopes the explicit DELETE so it never shadows the /api auto-CRUD delete", async () => {
    const router = fileEndingWith(await generateSystemFiles(DESTROY_SRC), "lib/api_web/router.ex");
    const rootBlock = router.slice(router.indexOf('scope "/" do'), router.indexOf('scope "/api"'));
    const apiBlock = router.slice(router.indexOf('scope "/api"'));
    // Explicit destroy route: root scope, absolute declared path, Web-qualified.
    expect(rootBlock).toContain(
      'delete "/orders/:order_id", ApiWeb.SalesApiRoutesController, :destroy_order',
    );
    // Auto-CRUD delete: distinct path, under /api — no shared clause with the above.
    expect(apiBlock).toContain('delete "/orders/:id", OrderController, :delete');
    expect(apiBlock).not.toContain("SalesApiRoutesController");
  });
});

// An `extern` handler is bodyless: the generated dispatch delegates to a
// scaffold-once, user-owned impl the user fills in (extern-handler Phase 1).
const EXTERN_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order { code: string }
      repository Orders for Order { }
      extern commandHandler PlaceOrder(code: string): Order id;
      extern queryHandler GetQuote(orderId: Order id): string;
    }
  }
  api SalesApi from Sales {
    route POST "/orders" -> Ordering.PlaceOrder
    route GET  "/orders/{orderId}/quote" -> Ordering.GetQuote
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;
describe("elixir — extern commandHandler / queryHandler", () => {
  it("the dispatch module delegates to the scaffold-once impl via config", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const dispatch = fileEndingWith(m, "lib/api/ordering/handlers/place_order.ex");
    expect(dispatch).toContain(
      "Application.get_env(:api, __MODULE__, Api.Ordering.Handlers.PlaceOrderImpl).run(params)",
    );
  });

  it("emits a scaffold-once impl module that raises", async () => {
    const m = await generateSystemFiles(EXTERN_SRC);
    const impl = fileEndingWith(m, "lib/api/ordering/handlers/place_order_impl.ex");
    expect(impl.split("\n")[0]).toContain("loom:scaffold-once");
    expect(impl).toContain("defmodule Api.Ordering.Handlers.PlaceOrderImpl do");
    expect(impl).toContain("raise ");
  });
});
