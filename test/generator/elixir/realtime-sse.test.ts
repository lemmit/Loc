// ---------------------------------------------------------------------------
// Realtime SSE wire — vanilla Phoenix (channels.md Part I).
//
// A `delivery: broadcast` channel makes its carried events UI-observable at
// GET /api/realtime/events.  Before this slice the Elixir backend served no SSE
// endpoint at all, so an SPA frontend (react/vue/svelte/angular/feliz) pointed
// at `platform: elixir` had its `on <channel>.<Event>` handler silently dropped
// behind a WARNING (`loom.ui-realtime-unsupported#backend-serves-no-sse`).
//
// The wire matches the four other backends and the frontends' EventSource
// client (`src/generator/_frontend/realtime.ts`): `event: <Type>` frames +
// camelCase JSON `data:`, a 15s `event: ping` keep-alive.  The tee is Phoenix's
// own PubSub — every domain `emit` already broadcasts the event struct on the
// shared "events" topic, so the controller subscribes there rather than
// decorating the dispatcher.  A `queue`-only (or channel-less) deployable emits
// none of it.
//
// A LiveView ui is untouched: it keeps subscribing to the same topic in-process
// (`realtime-liveview.ts`) — that path needs no HTTP stream.
//
// Runtime-proven locally (2026-08-18): docker postgres + `mix phx.server`, then
// `GET /api/realtime/events` → 200 `text/event-stream`, `POST /api/orders/:id/place`
// → the connected stream received `event: OrderPlaced` with
// `{"type":"OrderPlaced","customer":"alice",…}`.  `mix compile
// --warnings-as-errors` is gated per-PR by `corpus-elixir-build.yml` (the
// `saga` / `projection` / `read-gates` / `lifecycle-guard` fixtures all declare
// a broadcast channel, so they all now emit this controller).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const BROADCAST = `channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }`;
/** Backend-only, `delivery: queue` — work distribution, never UI-observable
 *  (a ui may not even subscribe to one, so this system carries no ui). */
const QUEUE_SYS = `
system RtQueue {
  subdomain Sales {
    context Sales {
      aggregate Order { customerId: string  status: string }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: ephemeral }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable backend {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

/** A Phoenix backend + a react SPA pointed at it, with one broadcast channel. */
const sys = (channel: string, extraFields = ""): string => `
system RtShop {
  subdomain Sales {
    context Sales {
      aggregate Order {
        customerId: string
        status: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, at: datetime${extraFields} }
      ${channel}
    }
  }
  api SalesApi from Sales
  ui SalesAdmin {
    api Sales: SalesApi
    channel Live: Sales.Lifecycle
    on Live.OrderPlaced(e) { toast("order placed") }
    page Home { route: "/" body: Heading { "hi" } }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable backend {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
  deployable web {
    platform: react
    ui: SalesAdmin { Sales: backend }
    targets: backend
    port: 3000
  }
}
`;

/** A tenant-owned context — the emitter must degrade the tenant-scoped event to
 *  a refetch ticket (type + `<Agg> id` refs only), never a scalar payload. */
const TENANT_SYS = `
system RtTenant {
  user { id: string  tenantId: string }
  tenancy by user.tenantId of Tenant
  subdomain Sales {
    context Sales {
      aggregate Tenant with tenantRegistry { name: string }
      repository Tenants for Tenant { }
      aggregate Order with tenantOwned {
        customerId: string
        status: string
      }
      repository Orders for Order { }
      event OrderPlaced { order: Order id, customerId: string, status: string }
      ${BROADCAST}
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable backend {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

const get = (files: Map<string, string>, suffix: string): string =>
  files.get([...files.keys()].find((k) => k.endsWith(suffix)) ?? "") ?? "";

describe("realtime SSE wire — vanilla Phoenix (delivery: broadcast)", () => {
  it("emits the RealtimeController: PubSub tee, chunked stream, per-event frames", async () => {
    const files = await generateSystemFiles(sys(BROADCAST));
    const ctrl = get(files, "lib/backend_web/controllers/realtime_controller.ex");
    expect(ctrl, "realtime_controller.ex emitted").not.toBe("");

    // (a) The tee — subscribing to the SAME topic every domain `emit` broadcasts
    //     on, so no dispatcher decorator is needed.
    expect(ctrl).toContain(`Phoenix.PubSub.subscribe(Backend.PubSub, "events")`);

    // (b) A real chunked SSE response, not a JSON action.
    expect(ctrl).toContain(`put_resp_header("content-type", "text/event-stream")`);
    expect(ctrl).toContain("send_chunked(200)");
    expect(ctrl).toContain("chunk(conn, data)");

    // (c) The wire contract: `event: <Type>` + a JSON body carrying `type`.
    expect(ctrl).toContain("defp frame(%Backend.Sales.Events.OrderPlaced{} = event) do");
    expect(ctrl).toContain(`encode("OrderPlaced", %{"order" => event.order, "at" => event.at})`);
    expect(ctrl).toContain(
      `"event: " <> type <> "\\ndata: " <> Jason.encode!(Map.put(fields, "type", type)) <> "\\n\\n"`,
    );

    // (d) The 15s keep-alive ping — same cadence as the other four backends.
    expect(ctrl).toContain("@keepalive_ms 15_000");
    expect(ctrl).toContain(`send_frame(conn, "event: ping\\ndata: \\n\\n")`);

    // (e) The UI-observable set.
    expect(ctrl).toContain(`@realtime_event_types ["OrderPlaced"]`);

    // (f) A message that is not a carried event is skipped, not crashed on.
    expect(ctrl).toContain("defp frame(_other), do: nil");
  });

  it("routes the stream through its own :sse pipeline (the :api `accepts` 406s EventSource)", async () => {
    const router = get(await generateSystemFiles(sys(BROADCAST)), "lib/backend_web/router.ex");
    expect(router).toContain("pipeline :sse do");
    expect(router).toContain(`get "/api/realtime/events", BackendWeb.RealtimeController, :events`);
    // The route must NOT sit inside `scope "/api"` (which pipes through `:api`,
    // whose `plug :accepts, ["json"]` answers 406 to `Accept: text/event-stream`).
    const apiScope = router.slice(router.indexOf(`scope "/api", BackendWeb do`));
    expect(apiScope).not.toContain("realtime");
  });

  it("makes the react frontend's realtime client + handlers reach an elixir backend", async () => {
    const files = await generateSystemFiles(sys(BROADCAST));
    // The gap this slice closes: before, `backendServesRealtime("elixir")` was
    // false, so BOTH of these were skipped and the `on` handler vanished.
    expect(get(files, "web/src/api/realtime.ts")).toContain("/realtime/events");
    expect(get(files, "web/src/components/RealtimeHandlers.tsx")).toContain(`case "OrderPlaced":`);
  });

  it("coerces money and decimal to the same wire form the REST serializer uses", async () => {
    const ctrl = get(
      await generateSystemFiles(sys(BROADCAST, ", total: money, rate: decimal")),
      "realtime_controller.ex",
    );
    // RS-12 fixed money scale (a JSON string) / RS-24 plain decimal (a number).
    expect(ctrl).toContain(`"total" => __money_round(event.total)`);
    expect(ctrl).toContain(`"rate" => __decimal_num(event.rate)`);
    expect(ctrl).toContain("defp __money_round(%Decimal{} = dec), do: Decimal.round(dec, 4)");
    expect(ctrl).toContain("defp __decimal_num(%Decimal{} = dec), do: Decimal.to_float(dec)");
  });

  it("emits nothing for a queue-only channel (byte-identical, no route, no pipeline)", async () => {
    const files = await generateSystemFiles(QUEUE_SYS);
    expect([...files.keys()].some((k) => k.endsWith("realtime_controller.ex"))).toBe(false);
    const router = get(files, "lib/backend_web/router.ex");
    expect(router).not.toContain("pipeline :sse");
    expect(router).not.toContain("realtime");
  });

  it("degrades a tenant-scoped event to a refetch ticket — never a cross-tenant payload", async () => {
    const ctrl = get(await generateSystemFiles(TENANT_SYS), "realtime_controller.ex");
    expect(ctrl, "realtime_controller.ex emitted").not.toBe("");
    // The `<Agg> id` reference survives; the scalar payload does NOT.
    expect(ctrl).toContain(`encode("OrderPlaced", %{"order" => event.order})`);
    expect(ctrl).not.toContain("event.customer_id");
    expect(ctrl).not.toContain("event.status");
    expect(ctrl).toContain("refetch ticket");
  });
});
