import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Realtime SSE consumption — Feliz (F#/Fable/Elmish) frontend (channels.md
// Part I).
//
// `on <channel>.<Event>(e) { toast(…) refetch(<Agg>) }` renders a
// self-contained Elmish subscription appended to App.fs: one EventSource
// against /api/realtime/events, an addEventListener per event type, a
// built-in DOM toast, and a re-fetch that re-issues the aggregate's existing
// `Api.<all>` / `<All>Loaded` read wiring.  `Program.withSubscription` wires
// it in.  A ui with no `on` handlers (or a backend without the SSE wire)
// emits none of it.
// ---------------------------------------------------------------------------

const BASE = `
system RtFelizShop {
  subdomain Shipping {
  context Fulfillment {
    aggregate Order { customerId: string  status: string  total: int }
    repository Orders for Order { }

    event OrderPlaced { order: Order id, at: datetime }

    channel Lifecycle {
      carries: OrderPlaced
      delivery: broadcast
      retention: ephemeral
    }
  }
  }
  storage primary { type: postgres }
  resource st { for: Fulfillment, kind: state, use: primary }
  api FulfillmentApi from Shipping
  ui WebApp with scaffold(subdomains: [Shipping]) {
    api Fulfillment: FulfillmentApi
    channel Live: Fulfillment.Lifecycle
    on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }
  }
  deployable backend {
    platform: node
    contexts: [Fulfillment]
    serves: FulfillmentApi
    dataSources: [st]
    port: 3000
  }
  deployable webApp {
    platform: feliz
    targets: backend
    ui: WebApp { Fulfillment: backend }
    port: 3001
  }
}
`;

async function appFs(src: string): Promise<string> {
  const all = await generateSystemFiles(src);
  for (const [p, c] of all) if (p.endsWith("web_app/src/App.fs")) return c;
  throw new Error("no web_app/src/App.fs emitted");
}

describe("realtime SSE consumption — Feliz (`on <channel>.<Event>`)", () => {
  it("emits the EventSource subscription, a toast, and a refetch of the aggregate", async () => {
    const app = await appFs(BASE);

    // The JS-interop opens the subscription needs.
    expect(app).toContain("open Fable.Core.JsInterop");
    // Toast + EventSource interop helpers.
    expect(app).toContain("let private showToast (message: string) : unit = jsNative");
    expect(app).toContain('[<Fable.Core.Emit("new EventSource($0)")>]');
    expect(app).toContain("let private createEventSource (url: string) : obj = jsNative");
    // The subscription itself.
    expect(app).toContain("let private realtimeSub (_: Model) : Sub<Msg> =");
    expect(app).toContain('let es = createEventSource "/api/realtime/events"');
    expect(app).toContain('es?addEventListener("OrderPlaced", fun (m: obj) ->');
    // Toast: the message subset, read through the `toastField` helper.
    //
    // This was `(string (payload?order))` until the subset grew MULTI-LEVEL
    // member access (2026-09-02).  Fable's `?` cannot carry a chain — it
    // compiles to `payload.order.id` and THROWS on an absent `order` — so the
    // renderer reads every depth through one `[<Emit>]` helper instead.  Depth 1
    // changes with it, deliberately: `string undefined` rendered the literal
    // text "undefined" into user-visible toast copy, where the JS and LiveView
    // renderers both rendered "".  All four now answer "" for an absent field.
    expect(app).toContain('showToast ("Order " + (toastField payload [| "order" |]) + " placed")');
    expect(app).toContain(
      "let private toastField (payload: obj) (path: string array) : string = jsNative",
    );
    // Refetch.  This ui is SCAFFOLDED, so its list read is server-paged
    // (M-T2.6 Feliz leg) — and the subscription runs OUTSIDE `update`, with no
    // `model` in scope.  Re-issuing the read from here would have to guess the
    // page and sort, silently snapping the user back to page 1 of the default
    // order, so it asks for a refetch and `update` builds the Cmd from the
    // model it has.
    expect(app).toContain("dispatch RefetchAllOrders");
    expect(app).toContain(
      "| RefetchAllOrders -> model, Cmd.OfAsync.perform (fun () -> Api.allOrders model.PageNum 10 model.SortKey model.SortDir) () AllOrdersLoaded",
    );
    // Wired into the Elmish program.
    expect(app).toContain("|> Program.withSubscription realtimeSub");
  });

  it("an UNPAGED list read still refetches inline — the Msg hop is paged-only", async () => {
    // A hand-written (non-scaffolded) ui whose `of:` threads no page/sort has
    // nothing to preserve, so the subscription re-issues the read directly.
    // Pins that the paged branch above didn't replace the plain path.
    const src = BASE.replace(
      "ui WebApp with scaffold(subdomains: [Shipping]) {",
      `ui WebApp {
    page Orders {
      route: "/"
      body: QueryView { of: Fulfillment.Order.all, data: rows => Text { "loaded" } }
    }`,
    );
    const app = await appFs(src);
    expect(app).toContain("let! result = Api.allOrders ()");
    expect(app).toContain("dispatch (AllOrdersLoaded result)");
    expect(app).not.toContain("RefetchAllOrders");
  });

  it("a toast-only handler emits the toast but no refetch and no payload decode", async () => {
    const src = BASE.replace(
      'on Live.OrderPlaced(e) { toast("Order " + e.order + " placed") refetch(Order) }',
      'on Live.OrderPlaced(e) { toast("an order was placed") }',
    );
    const app = await appFs(src);
    expect(app).toContain("let private realtimeSub (_: Model) : Sub<Msg> =");
    expect(app).toContain('showToast ("an order was placed")');
    // No member read → no JSON.parse decode line.
    expect(app).not.toContain("Fable.Core.JS.JSON.parse");
    // No refetch dispatch for a toast-only handler (the `dispatch (…Loaded …)`
    // shape is unique to the realtime re-fetch — `init` reads via
    // `Cmd.OfAsync.perform`, not a bare dispatch).
    expect(app).not.toContain("dispatch (AllOrdersLoaded result)");
  });

  it("emits no subscription when the ui declares no `on` handlers", async () => {
    const src = BASE.replace(/ {4}channel Live:.*\n {4}on Live\..*\n/, "");
    const app = await appFs(src);
    expect(app).not.toContain("realtimeSub");
    expect(app).not.toContain("createEventSource");
    expect(app).not.toContain("Program.withSubscription");
  });
});
