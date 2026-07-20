// M-T4.4 slice 6c — Redis/Valkey broker transport on the Phoenix (Elixir)
// backend, mirroring the Hono pins in ../channels-transport.test.ts and the
// Python/.NET/Java legs.
//
// An elixir deployable that wires a redis-bound `broadcast`/`ephemeral`
// channelSource via `channels:` gets: `lib/<app>/channels.ex` (the
// CloudEvents envelope codec + Redix publish + the §4 delivery-uniformity
// tee `Channels.dispatch/2` that every producer-side emit seam routes
// through), the `channel_consumer.ex` GenServer where a hosted reactor
// subscribes, the supervision children + wiring-gated `redix` hex dep, and
// the foreign event struct under the OWNING context's namespace.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id, at: now() }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id, at: datetime }
      channel Lifecycle { carries: OrderPlaced }
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish {
        orderRef: Order id
        status: string
      }
      repository Shipments for Shipment {}
      workflow Fulfil {
        orderId: Order id
        create(p: OrderPlaced) by p.order {
          let s = Shipment.create({ orderRef: p.order, status: "Pending" })
        }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: elixir contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

describe("redis broker transport — elixir leg (M-T4.4 slice 6c)", () => {
  it("emits the tee module on both wired deployables; the producer routes op emits through it", async () => {
    const files = await generateSystemFiles(FIXTURE);
    for (const [dep, app] of [
      ["sales_api", "SalesApi"],
      ["ship_api", "ShipApi"],
    ] as const) {
      const channels = files.get(`${dep}/lib/${dep}/channels.ex`) ?? "";
      expect(channels, `${dep} channels.ex`).toContain(`defmodule ${app}.Channels do`);
      expect(channels).toContain('"OrderPlaced" => {"loom.Orders.Lifecycle"');
      expect(channels).toContain('"specversion" => "1.0"');
      expect(files.get(`${dep}/mix.exs`)).toContain('{:redix, "~> 1.5"}');
      expect(files.get(`${dep}/lib/${dep}/application.ex`)).toContain(
        'System.fetch_env!("LOOM_CHANNEL_LIFECYCLE_BUS_URL")',
      );
    }
    // The producer's op emit routes through the tee (no local dispatcher →
    // nil), and never calls a local Dispatcher directly.
    const orders = files.get("sales_api/lib/sales_api/orders.ex") ?? "";
    expect(orders).toContain("SalesApi.Channels.dispatch(loom_event_0, nil)");
    expect(orders).not.toContain("Dispatcher.dispatch(loom_event_0)");
  });

  it("gates the consumer GenServer on reactor presence", async () => {
    const files = await generateSystemFiles(FIXTURE);
    expect(files.get("sales_api/lib/sales_api/channel_consumer.ex")).toBeUndefined();
    const consumer = files.get("ship_api/lib/ship_api/channel_consumer.ex") ?? "";
    expect(consumer).toContain("defmodule ShipApi.ChannelConsumer do");
    expect(consumer).toContain(
      'Redix.PubSub.subscribe(pubsub_loom_channels_0, "loom.Orders.Lifecycle", self())',
    );
    // Consumed events feed the LOCAL dispatcher directly (loop-safe).
    expect(consumer).toContain("ShipApi.Shipping.Dispatcher.dispatch(ev)");
    expect(files.get("ship_api/lib/ship_api/application.ex")).toContain("ShipApi.ChannelConsumer");
  });

  it("gives the consumer the foreign event vocabulary under the owning context", async () => {
    const files = await generateSystemFiles(FIXTURE);
    // shipApi does NOT host Orders, yet consumes OrderPlaced: the struct
    // module emits under the OWNING context's namespace, and the dispatcher +
    // handler pattern-match with the same qualification.
    expect(files.get("ship_api/lib/ship_api/orders/events/order_placed.ex")).toContain(
      "defmodule ShipApi.Orders.Events.OrderPlaced do",
    );
    const dispatcher = files.get("ship_api/lib/ship_api/shipping/dispatcher.ex") ?? "";
    expect(dispatcher).toContain("def dispatch(%ShipApi.Orders.Events.OrderPlaced{} = event)");
    const handler =
      files.get("ship_api/lib/ship_api/shipping/workflows/fulfil/start_order_placed.ex") ?? "";
    expect(handler).toContain("def handle(%ShipApi.Orders.Events.OrderPlaced{} = event)");
  });

  it("keeps a channel-less elixir system free of transport artifacts", async () => {
    const bare = `
system Bare {
  subdomain S {
    context C {
      aggregate Item with crudish { name: string }
      repository Items for Item {}
    }
  }
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable api { platform: elixir contexts: [C] dataSources: [cState] port: 3000 }
}
`;
    const files = await generateSystemFiles(bare);
    expect(files.get("api/lib/api/channels.ex")).toBeUndefined();
    expect(files.get("api/lib/api/channel_consumer.ex")).toBeUndefined();
    expect(files.get("api/mix.exs")).not.toContain("redix");
  });
});
