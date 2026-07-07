import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Channels-on-vanilla — the in-process `Dispatcher` that fans an emitted
// event struct to per-context handler modules.  The vanilla mirror of the
// Phoenix/Ash slice covered by `test/generator/elixir/phoenix-dispatch-
// emission.test.ts`.
//
// On vanilla:
//   - each `on(e: Event)` reactor / event-triggered `create(e: Event) by`
//     starter emits a handler module with `handle(event)`,
//   - a per-context `Dispatcher` routes each event-struct type to its
//     handler(s) (and a no-op fall-through for events with no subscriber),
//   - a handler that `emit`s re-enters the dispatcher (choreography),
//   - correlation persists through a saga-state `Ecto.Schema` keyed by the
//     correlation field (load-or-allocate for `create`, route-or-drop+log
//     for `on`).
//
// The dispatch code is foundation-agnostic plain Elixir (no Ash anywhere
// in the emitted output).  The `mix compile --warnings-as-errors` gate
// lives in `elixir-vanilla-build.yml` (vanilla-channels.ddd fixture).
// ---------------------------------------------------------------------------

const DISPATCH_SOURCE = `
system FulfillmentSys {
  subdomain Fulfillment {
    context Fulfillment {
      aggregate Order with crudish {
        customerId: string
        status: string
        total: int
      }
      repository Orders for Order { }

      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
        operation markTracked() { status := "Tracked" }
      }
      repository Shipments for Shipment { }

      event OrderPlaced { order: Order id, at: datetime }
      event ShipmentRequested { shipment: Shipment id, order: Order id, at: datetime }

      channel Lifecycle {
        carries: OrderPlaced, ShipmentRequested
        delivery: broadcast
        retention: ephemeral
      }

      workflow OrderFulfillment {
        orderId: Order id
        attempts: int

        create(p: OrderPlaced) by p.order {
          let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
          emit ShipmentRequested { shipment: ship.id, order: p.order, at: now() }
        }

        on(s: ShipmentRequested) by s.order {
          let ship = Shipments.getById(s.shipment)
          ship.markTracked()
        }
      }
    }
  }
  api FulfillmentApi from Fulfillment
  storage primary { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Fulfillment]
    dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 4000
  }
}
`;

async function generate(): Promise<Map<string, string>> {
  return generateSystemFiles(DISPATCH_SOURCE);
}

const base = "api/lib/api/fulfillment";

describe("vanilla — in-process event dispatch", () => {
  it("emits one handler module per reactor / event-create", async () => {
    const files = await generate();

    const start = files.get(`${base}/workflows/order_fulfillment/start_order_placed.ex`);
    expect(start).toBeDefined();
    expect(start!).toContain(
      "defmodule Api.Fulfillment.Workflows.OrderFulfillment.StartOrderPlaced do",
    );
    expect(start!).toContain("def handle(%Api.Fulfillment.Events.OrderPlaced{} = event) do");
    expect(start!).toContain(
      'Api.Fulfillment.create_shipment(%{order_ref: event.order, status: "Pending"})',
    );
    expect(start!).toMatch(
      /Api\.Fulfillment\.Dispatcher\.dispatch\(%Api\.Fulfillment\.Events\.ShipmentRequested\{shipment: ship\.id, order: event\.order/,
    );

    const onH = files.get(`${base}/workflows/order_fulfillment/on_shipment_requested.ex`);
    expect(onH).toBeDefined();
    expect(onH!).toContain(
      "defmodule Api.Fulfillment.Workflows.OrderFulfillment.OnShipmentRequested do",
    );
    expect(onH!).toContain("def handle(%Api.Fulfillment.Events.ShipmentRequested{} = event) do");
    // A reactor is a per-dispatch boundary: its body runs in a child execution
    // frame (parent_id <- the dispatching request's scope).
    expect(onH!).toContain("Api.RequestContext.with_child_frame(fn ->");
    expect(onH!).toContain("Api.Fulfillment.get_shipment(event.shipment)");
    // Vanilla context facade ops are arity-2 (`(record, params)`); the
    // op has no params so the trailing map is empty.
    expect(onH!).toContain("Api.Fulfillment.mark_tracked_shipment(ship, %{})");
  });

  it("emits a per-context dispatcher routing each event struct to its handler(s)", async () => {
    const files = await generate();
    const disp = files.get(`${base}/dispatcher.ex`);
    expect(disp).toBeDefined();
    expect(disp!).toContain("defmodule Api.Fulfillment.Dispatcher do");
    expect(disp!).toContain("def dispatch(%Api.Fulfillment.Events.OrderPlaced{} = event) do");
    expect(disp!).toContain(
      "Api.Fulfillment.Workflows.OrderFulfillment.StartOrderPlaced.handle(event)",
    );
    expect(disp!).toContain("def dispatch(%Api.Fulfillment.Events.ShipmentRequested{} = event) do");
    expect(disp!).toContain(
      "Api.Fulfillment.Workflows.OrderFulfillment.OnShipmentRequested.handle(event)",
    );
    expect(disp!).toContain("def dispatch(_event), do: :ok");
  });

  it("persists correlation: saga Ecto.Schema keyed by the correlation field", async () => {
    const files = await generate();
    const state = files.get(`${base}/workflows/order_fulfillment_state.ex`);
    expect(state).toBeDefined();
    expect(state!).toContain("defmodule Api.Fulfillment.Workflows.OrderFulfillmentState do");
    expect(state!).toContain("use Ecto.Schema");
    expect(state!).toContain("@primary_key {:order_id, :binary_id, autogenerate: false}");
    expect(state!).toContain('schema "order_fulfillments" do');
    expect(state!).toContain("field :attempts, :integer");
  });

  it("create loads-or-allocates the saga row; on routes-or-drops+logs", async () => {
    const files = await generate();

    const start = files.get(`${base}/workflows/order_fulfillment/start_order_placed.ex`) ?? "";
    expect(start).toContain("key = event.order");
    expect(start).toContain(
      "case Api.Repo.get(Api.Fulfillment.Workflows.OrderFulfillmentState, key) do",
    );
    expect(start).toContain(
      "nil -> Api.Repo.insert!(%Api.Fulfillment.Workflows.OrderFulfillmentState{order_id: key, attempts: 0})",
    );

    const onH = files.get(`${base}/workflows/order_fulfillment/on_shipment_requested.ex`) ?? "";
    expect(onH).toContain("require Logger");
    expect(onH).toMatch(/Logger\.warning\("event_unrouted".*workflow: "OrderFulfillment"/);
    expect(onH).toMatch(/nil ->[\s\S]*:ok/);
  });

  it("the emitted dispatcher / handlers / saga schema contain no Ash references", async () => {
    const files = await generate();
    const disp = files.get(`${base}/dispatcher.ex`) ?? "";
    const start = files.get(`${base}/workflows/order_fulfillment/start_order_placed.ex`) ?? "";
    const onH = files.get(`${base}/workflows/order_fulfillment/on_shipment_requested.ex`) ?? "";
    const state = files.get(`${base}/workflows/order_fulfillment_state.ex`) ?? "";
    for (const body of [disp, start, onH, state]) {
      expect(body).not.toContain("Ash.");
      expect(body).not.toContain("use Ash.Resource");
      expect(body).not.toContain("AshPostgres");
    }
    // Repo references use the plain vanilla `Api.Repo` (Ecto.Repo), not
    // the AshPostgres flavour.
    expect(start).toContain("Api.Repo");
    expect(start).not.toContain("Api.AshRepo");
  });
});

describe("vanilla — channel-less project emits no dispatch wiring (byte-shape regression)", () => {
  it("no dispatcher, no reactor handlers, no saga schema", async () => {
    const files = await generateSystemFiles(`
      system Tasks {
        subdomain Productivity {
          context Tracker {
            aggregate Task with crudish {
              title: string
              done: bool
            }
            repository Tasks for Task { }
          }
        }
        api TrackerApi from Productivity
        storage primary { type: postgres }
        resource trackerState { for: Tracker, kind: state, use: primary }
        deployable api {
          platform: elixir
          contexts: [Tracker]
          dataSources: [trackerState]
          serves: TrackerApi
          port: 4000
        }
      }
    `);
    const keys = [...files.keys()];
    expect(keys.some((k) => k.endsWith("/dispatcher.ex"))).toBe(false);
    expect(keys.some((k) => /workflows\/.+\/(start|on)_.+\.ex$/.test(k))).toBe(false);
    expect(keys.some((k) => /workflows\/[^/]+_state\.ex$/.test(k))).toBe(false);
  });
});
