// ---------------------------------------------------------------------------
// Realtime LiveView wire — Phoenix's native realtime path (channels.md
// Part I, "The Phoenix path").
//
// Unlike the SPA frontends (EventSource client against GET /realtime/events),
// a LiveView does realtime natively: on mount it `Phoenix.PubSub.subscribe`s
// to the SAME `"events"` topic every domain `emit` already broadcasts on, and
// handles each carried event via `handle_info` — collapsing the SSE relay to
// one in-process hop.  A `toast(<expr>)` handler becomes a `put_flash(:info,…)`
// and a `refetch(<Agg>)` re-loads the page's list/detail assign for that
// aggregate.  A ui with no `on` handlers emits byte-identical output (no
// subscribe, no handle_info).  The reactor/saga choreography path is untouched:
// it uses direct `Dispatcher.dispatch/1` calls, not this PubSub topic.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A Phoenix system with an Order aggregate + a broadcast channel; `uiExtra`
 *  splices extra members (channel param + `on` handlers) into the scaffolded
 *  ui. */
const sys = (uiExtra: string): string => `
system RtShop {
  subdomain Sales {
    context Sales {
      aggregate Order {
        customerId: string
        status: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle {
        carries: OrderPlaced
        delivery: broadcast
        retention: ephemeral
      }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin with scaffold(subdomains: [Sales]) {${uiExtra}
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
`;

const WITH_HANDLER = `
    channel Live: Sales.Lifecycle
    on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }`;

const TOAST_ONLY = `
    channel Live: Sales.Lifecycle
    on Live.OrderPlaced(e) { toast("placed") }`;

function get(fs: Map<string, string>, suffix: string): string {
  const key = [...fs.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending in ${suffix}; have:\n${[...fs.keys()].join("\n")}`);
  return fs.get(key)!;
}

describe("realtime LiveView wire — Phoenix (`on <channel>.<Event>`)", () => {
  it("(a) subscribes on connect and emits a handle_info clause per event type", async () => {
    const list = get(await generateSystemFiles(sys(WITH_HANDLER)), "/live/order_list_live.ex");

    // mount subscribes to the domain `emit` topic — only on the live
    // (websocket-connected) mount, not the initial static render.
    expect(list).toContain(
      'if connected?(socket), do: Phoenix.PubSub.subscribe(PhoenixApp.PubSub, "events")',
    );

    // One handle_info clause matching the broadcast struct, plus a catch-all
    // so an unmatched broadcast can't crash the LiveView process.
    expect(list).toContain(
      "def handle_info(%PhoenixApp.Sales.Events.OrderPlaced{} = e, socket) do",
    );
    expect(list).toContain("def handle_info(_msg, socket), do: {:noreply, socket}");
  });

  it("(b) a scaffold-only ui (no `on` handlers) is byte-identical — no subscribe/handle_info", async () => {
    const list = get(await generateSystemFiles(sys("")), "/live/order_list_live.ex");
    expect(list).not.toContain("Phoenix.PubSub.subscribe");
    expect(list).not.toContain("handle_info");
    // The pre-realtime mount head is unchanged.
    expect(list).toContain("def mount(_params, _session, socket) do\n    socket =");
  });

  it("(c) toast(<expr>) lowers to put_flash(:info, …) with Elixir string concat", async () => {
    const list = get(await generateSystemFiles(sys(WITH_HANDLER)), "/live/order_list_live.ex");
    expect(list).toContain('put_flash(:info, "Order " <> to_string(e.order) <> " placed")');
  });

  it("(d) refetch(<Agg>) re-loads the page's data assign inside handle_info", async () => {
    const list = get(await generateSystemFiles(sys(WITH_HANDLER)), "/live/order_list_live.ex");
    // The handle_info clause re-runs the same list load the initial
    // handle_params ran — the realtime twin of a mutation's cache refresh.
    const clause = list.slice(list.indexOf("def handle_info(%PhoenixApp.Sales.Events.OrderPlaced"));
    expect(clause).toContain("case PhoenixApp.Sales.list_orders() do");
    expect(clause).toContain("{:ok, items} -> assign(socket, :items, items)");
  });

  it("a toast-only handler captures no struct binding (no unused-variable warning)", async () => {
    const list = get(await generateSystemFiles(sys(TOAST_ONLY)), "/live/order_list_live.ex");
    // No refetch, and the message is a bare literal that doesn't read the
    // binding → the head discards the struct (`%…{}`, no `= e`).
    expect(list).toContain("def handle_info(%PhoenixApp.Sales.Events.OrderPlaced{}, socket) do");
    expect(list).toContain('put_flash(:info, "placed")');
    // A toast-only handler needs no query client / reload.
    const clause = list.slice(list.indexOf("def handle_info(%PhoenixApp.Sales.Events.OrderPlaced"));
    expect(clause).not.toContain("list_orders()");
  });

  it("a page that doesn't display the refetched aggregate still subscribes + toasts (reload no-op)", async () => {
    const home = get(await generateSystemFiles(sys(WITH_HANDLER)), "/live/home_live.ex");
    expect(home).toContain('Phoenix.PubSub.subscribe(PhoenixApp.PubSub, "events")');
    expect(home).toContain('put_flash(:info, "Order " <> to_string(e.order) <> " placed")');
    // Home loads no Order assign, so the refetch reloads nothing here.
    expect(home).not.toContain("list_orders()");
  });
});
