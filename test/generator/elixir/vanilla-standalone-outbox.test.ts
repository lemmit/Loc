import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Elixir-vanilla backend — standalone (no-broker) transactional outbox
// (M-T4.3, dispatch-delivery-semantics.md §1-2). A durable channel
// (retention: log|work) with NO channelSource used to silently downgrade to
// at-most-once inline dispatch on elixir; now it gets crash-safe in-process
// delivery (parity with node/dotnet/python/java):
//   - `<App>.Channels.dispatch/2` records a durable event in __loom_outbox
//     (the emit seams route through it) instead of fanning out inline;
//   - `<App>.LocalOutboxRelay` drains → decodes → broadcasts to the hosted
//     dispatcher post-commit, parking the row id for the saga marker.
// ---------------------------------------------------------------------------

/** Durable channel (retention: log) with NO channelSource — standalone. */
const STANDALONE = `system Acme { subdomain Sales { context Orders {
  aggregate Order with crudish { customerId: string  status: string
    operation place() { precondition status == "Draft"  status := "Placed"  emit OrderPlaced { order: id } } }
  repository Orders for Order {}
  event OrderPlaced { order: Order id }
  channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: log }
  workflow Fulfil { orderId: Order id  status: string  create(p: OrderPlaced) by p.order { status := "Pending" } }
} } storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable salesApi { platform: elixir contexts: [Orders] dataSources: [oState] port: 4000 } }`;

/** Ephemeral channel — no durability, no outbox (at-most-once, byte-identical). */
const EPHEMERAL = STANDALONE.replace(
  "delivery: broadcast  retention: log",
  "delivery: broadcast  retention: ephemeral",
);

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  return key ? (files.get(key) ?? "") : "";
}

describe("elixir standalone (no-broker) outbox (M-T4.3)", () => {
  it("routes the emit seam through the standalone Channels tee", async () => {
    const files = await build(STANDALONE);
    // The context module's emit site records durable events via the tee.
    expect(file(files, "lib/sales_api/orders.ex")).toContain(
      "SalesApi.Channels.dispatch(loom_event_0, SalesApi.Orders.Dispatcher)",
    );
    const tee = file(files, "lib/sales_api/channels.ex");
    expect(tee).toContain('@durable MapSet.new(["OrderPlaced"])');
    // Durable → record into __loom_outbox; ephemeral → the local dispatcher.
    expect(tee).toContain("if MapSet.member?(@durable, type) do");
    expect(tee).toContain("|> SalesApi.Repo.insert!()");
    expect(tee).toContain("def encode_data(%SalesApi.Orders.Events.OrderPlaced{} = ev) do");
    expect(tee).toContain('def decode("OrderPlaced", data) do');
  });

  it("delivers drained rows to the hosted dispatcher via dispatch_from_relay", async () => {
    const files = await build(STANDALONE);
    const tee = file(files, "lib/sales_api/channels.ex");
    expect(tee).toContain("def dispatch_from_relay(type, data) do");
    expect(tee).toContain(
      "Enum.each([SalesApi.Orders.Dispatcher], fn dispatcher -> dispatcher.dispatch(ev) end)",
    );
    const relay = file(files, "lib/sales_api/local_outbox_relay.ex");
    expect(relay).toContain("defmodule SalesApi.LocalOutboxRelay do");
    // The row id rides the process dictionary → the saga last_event_id marker.
    expect(relay).toContain("Process.put(:loom_event_id, row.id)");
    expect(relay).toContain("SalesApi.Channels.dispatch_from_relay(row.type, row.payload)");
    // The outbox Ecto schema + the supervision child.
    expect(file(files, "lib/sales_api/loom_outbox.ex")).toContain('schema "__loom_outbox" do');
    expect(file(files, "lib/sales_api/application.ex")).toContain("SalesApi.LocalOutboxRelay");
  });

  it("emits no outbox for an ephemeral channel (byte-identical at-most-once)", async () => {
    const files = await build(EPHEMERAL);
    expect(file(files, "lib/sales_api/channels.ex")).toBe("");
    expect(file(files, "lib/sales_api/local_outbox_relay.ex")).toBe("");
    expect(file(files, "lib/sales_api/loom_outbox.ex")).toBe("");
    // The emit seam dispatches straight to the local dispatcher (no tee).
    expect(file(files, "lib/sales_api/orders.ex")).toContain(
      "SalesApi.Orders.Dispatcher.dispatch(loom_event_0)",
    );
  });
});
