import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Elixir-vanilla backend — idempotent-consumer markers (M-T4.3,
// dispatch-delivery-semantics.md §3), closing the slice-7d residual (elixir's
// saga last_event_id dedup was unwired — the ack-semantics stance).
//
// Where a deployable HOSTS a durable channel's context AND a saga consumes it,
// the ChannelConsumer parks the envelope id (= the producer's outbox row id) in
// the process dictionary, the saga-state Ecto schema maps `last_event_id`, and
// each handler no-ops on a redelivery of the recorded id and stamps it before
// the state save — at-least-once becomes effectively-once.
// ---------------------------------------------------------------------------

/** Co-located durable producer+consumer (queue/work + a rabbitmq channelSource)
 *  — the marker engages on the `create` starter AND the `on` reactor. */
const DURABLE = `system Acme { subdomain Sales { context Orders {
  aggregate Order with crudish { customerId: string  status: string }
  repository Orders for Order {}
  aggregate Shipment with crudish { orderRef: Order id  status: string
    operation markTracked() { status := "Tracked" } }
  repository Shipments for Shipment {}
  event OrderPlaced { order: Order id }
  event ShipmentRequested { shipment: Shipment id, order: Order id }
  channel Lifecycle { carries: OrderPlaced, ShipmentRequested  delivery: queue  retention: work }
  workflow Fulfil {
    orderId: Order id
    status: string
    create(p: OrderPlaced) by p.order {
      let ship = Shipment.create({ orderRef: p.order, status: "Pending" })
      emit ShipmentRequested { shipment: ship.id, order: p.order }
    }
    on(s: ShipmentRequested) by s.order {
      let ship = Shipments.getById(s.shipment)
      ship.markTracked()
    }
  }
} } storage pg { type: postgres }
  storage bus { type: rabbitmq }
  resource oState { for: Orders, kind: state, use: pg }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [oState] channels: [lifecycleBus] port: 4000 } }`;

/** Same shape, but the channel is ephemeral (no durability) — no outbox, no
 *  markers: the at-most-once path stays byte-identical. */
const EPHEMERAL = DURABLE.replace(
  "delivery: queue  retention: work",
  "delivery: broadcast  retention: ephemeral",
)
  .replace("storage bus { type: rabbitmq }", "storage bus { type: redis }")
  .replace("channels: [lifecycleBus] ", "");

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  return key ? (files.get(key) ?? "") : "";
}

describe("elixir idempotent-consumer markers (M-T4.3)", () => {
  it("maps last_event_id on the saga-state Ecto schema under a durable channel", async () => {
    const files = await build(DURABLE);
    expect(file(files, "fulfil_state.ex")).toContain("field :last_event_id, :string");
  });

  it("wraps the create starter in the marker check + stamp", async () => {
    const files = await build(DURABLE);
    const start = file(files, "start_order_placed.ex");
    expect(start).toContain("event_id = Process.get(:loom_event_id)");
    expect(start).toContain("if event_id && state.last_event_id == event_id do");
    expect(start).toContain(
      "Repo.update!(Ecto.Changeset.change(state, %{last_event_id: event_id}))",
    );
  });

  it("wraps the on reactor in the marker check + stamp", async () => {
    const files = await build(DURABLE);
    const on = file(files, "on_shipment_requested.ex");
    expect(on).toContain("event_id = Process.get(:loom_event_id)");
    expect(on).toContain("if event_id && state.last_event_id == event_id do");
    expect(on).toContain("Repo.update!(Ecto.Changeset.change(state, %{last_event_id: event_id}))");
  });

  it("parks the envelope id on the process dictionary in the consumer", async () => {
    const files = await build(DURABLE);
    expect(file(files, "channel_consumer.ex")).toContain(
      'Process.put(:loom_event_id, envelope["id"])',
    );
  });

  it("stays byte-identical for an ephemeral channel (no outbox, no markers)", async () => {
    const files = await build(EPHEMERAL);
    expect(file(files, "fulfil_state.ex")).not.toContain("last_event_id");
    expect(file(files, "start_order_placed.ex")).not.toContain("loom_event_id");
    expect(file(files, "on_shipment_requested.ex")).not.toContain("loom_event_id");
    expect(file(files, "channel_consumer.ex")).not.toContain("loom_event_id");
  });
});
