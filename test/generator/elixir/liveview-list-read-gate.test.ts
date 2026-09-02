// The LIST read's `requires` gate on the LiveView seam.
//
// #2523 gave `find all(...) requires <expr>` an emitted gate on all five
// backends — but on Elixir it landed only in `api-emit.ts`'s `index` action.
// A `platform: elixir` deployable that also mounts a `ui` serves the SAME read
// twice: over HTTP through the controller, and in-process through the LiveView,
// which calls the context facade (`list_<agg>s/…`).  That facade is a bare
// `defdelegate ... to: <Agg>Repo, as: :list` (`vanilla/context-emit.ts`), so it
// carries no gate of its own — a caller the HTTP route 403s could load the page
// and read every row.
//
// The rule this restores is the one the projection loader states in its own
// comment: "the same read, authorized on one seam only" is the bug.  All three
// LiveView seams that load a collection are gated — first load (handle_params),
// the Table sort/page controls, and the realtime refetch — because a reload
// path that skipped the gate would reopen the same hole one interaction later.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (gate: string): string => `
system Shop {
  user { role: string }
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        derived display: string = code
      }
      repository Orders for Order {
        find all(): Order[]${gate}
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  auth { oidc { issuer: "https://issuer.example", clientId: "web" } }
  ui WebApp {
    api Sales: SalesApi
    page OrderList {
      route: "/orders"
      title: "Orders"
      body: Stack {
        QueryView {
          of: Sales.Order.all,
          empty: Text { "none" },
          data: rows => Table { rows: rows, Column { "Display", o => o.display } }
        }
      }
    }
  }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp { Sales: d }
    port: 4000
    auth: required
  }
}
`;

const GATE = ` requires currentUser.role == "clerk"`;

async function liveView(gate: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(gate));
  const hit = [...files].find(([p]) => /order_list_live\.ex$/.test(p));
  if (!hit) throw new Error(`no LiveView; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("elixir LiveView — the list read carries the same gate as the HTTP index", () => {
  it("evaluates the gate before calling the context facade", async () => {
    const live = await liveView(GATE);
    expect(live).toContain(`if current_user.role == "clerk" do`);
    // The principal has to be bound for the gate to read it.
    expect(live).toContain("current_user = Map.get(socket.assigns, :current_user)");
    // Denial is fail-closed: the `:error` sentinel the page's `cond` already
    // renders, never the rows.
    expect(live).toMatch(/else\s+assign\(socket, :\w+, :error\)/);
  });

  it("gates the reload seams too, not just the first load", async () => {
    const live = await liveView(GATE);
    // Every emitted `list_orders(` call site must sit under a gate — an
    // ungated one is a sort click or a realtime push away from the same leak.
    const gated = live.split(`if current_user.role == "clerk" do`).length - 1;
    const reads = live.split("Orders.list_orders(").length - 1;
    expect(reads).toBeGreaterThan(0);
    expect(gated).toBe(reads);
  });

  it("emits no gate — and binds no principal — when the find declares none", async () => {
    const live = await liveView("");
    expect(live).not.toContain("if current_user");
    // An unused `current_user` binding fails `mix compile --warnings-as-errors`.
    expect(live).not.toContain("current_user = Map.get(socket.assigns, :current_user)");
    expect(live).toContain("Orders.list_orders(");
  });
});
