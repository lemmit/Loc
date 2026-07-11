// ---------------------------------------------------------------------------
// Vanilla Elixir — event-sourced workflows (workflow-and-applier.md A2-S5b;
// elixir-vanilla joined the foundation-aware ES-workflow gate).  An
// `eventSourced` workflow persists as an append-only `<wf>_events` stream folded
// through its `apply(...)` blocks — the saga analogue of a `persistedAs(eventLog)`
// aggregate — instead of a mutable `<wf>_state` Ecto row.  Asserts the `<Wf>State`
// fold struct, the `<Wf>Fold` / `<Wf>Stream` modules, the absence of a state
// schema, and the fold-on-load / append-own-events handlers.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `system FulfillmentSys {
  subdomain Fulfillment {
    context Fulfillment {
      event OrderPlaced { order: Order id, at: datetime }
      event PaymentRegistered { order: Order id, amount: int }
      event FulfillmentCancelled { order: Order id }
      aggregate Order {
        status: string
        create place() { status := "Placed"  emit OrderPlaced { order: id, at: now() } }
      }
      repository Orders for Order { }
      channel Lifecycle { carries: OrderPlaced, PaymentRegistered, FulfillmentCancelled  delivery: broadcast  retention: ephemeral }
      workflow OrderFulfillment eventSourced {
        orderId: Order id
        paid: int
        cancelled: bool
        create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
        on(pr: PaymentRegistered) by pr.order { precondition paid >= 0  emit FulfillmentCancelled { order: pr.order } }
        apply(pr: PaymentRegistered) { paid := paid + pr.amount }
        apply(fc: FulfillmentCancelled) { cancelled := true }
      }
    }
  }
  api FulfillmentApi from Fulfillment
  storage pg { type: postgres }
  resource fulfillmentState { for: Fulfillment, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Fulfillment]
    dataSources: [fulfillmentState]
    serves: FulfillmentApi
    port: 4000
  }
}`;

const WF = "api/lib/api/fulfillment/workflows";

async function gen(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("vanilla elixir event-sourced workflows", () => {
  it("emits a <Wf>State plain fold struct (no Ecto schema)", async () => {
    const files = await gen();
    const s = files.get(`${WF}/order_fulfillment_state.ex`)!;
    expect(s).toContain("defmodule Api.Fulfillment.Workflows.OrderFulfillmentState do");
    expect(s).toContain("defstruct [:order_id, :paid, :cancelled]");
    // Plain struct — not an Ecto saga schema.
    expect(s).not.toContain("use Ecto.Schema");
    expect(s).not.toContain('schema "order_fulfillments"');
  });

  it("emits a <Wf>Fold with appliers + from_events seeding key + defaults", async () => {
    const f = (await gen()).get(`${WF}/order_fulfillment_fold.ex`)!;
    expect(f).toContain(
      "def apply_event(state, %Api.Fulfillment.Events.PaymentRegistered{} = pr) do",
    );
    expect(f).toContain("state = %{state | paid: state.paid + pr.amount}");
    expect(f).toContain("state = %{state | cancelled: true}");
    expect(f).toContain(
      "%Api.Fulfillment.Workflows.OrderFulfillmentState{order_id: key, paid: 0, cancelled: false}",
    );
  });

  it("emits a <Wf>Stream (load + gap-free append + Jason codec) + event-log schema", async () => {
    const files = await gen();
    const st = files.get(`${WF}/order_fulfillment_stream.ex`)!;
    expect(st).toContain("def load(stream_id) when is_binary(stream_id) do");
    expect(st).toContain("def append(stream_id, events)");
    expect(st).toContain(
      'defp event_type(%Api.Fulfillment.Events.PaymentRegistered{}), do: "PaymentRegistered"',
    );
    const log = files.get(`${WF}/order_fulfillment_event_log.ex`)!;
    expect(log).toContain('schema "order_fulfillment_events" do');
  });

  it("the <Wf>Stream exposes list_instances/0 + instance_by_id/1 (fold-on-load reads)", async () => {
    // workflow-instance-visibility.md: the ES instance reads fold the stream.
    // LIST = load all rows, group by stream_id, fold each (mirrors the
    // ES-aggregate repository list); byId = single-stream load + fold, nil on
    // an empty stream.
    const st = (await gen()).get(`${WF}/order_fulfillment_stream.ex`)!;
    expect(st).toContain("def list_instances do");
    expect(st).toContain(
      "Repo.all(from(r in OrderFulfillmentEventLog, order_by: [asc: r.stream_id, asc: r.version]))",
    );
    expect(st).toContain("|> Enum.group_by(& &1.stream_id)");
    expect(st).toContain("OrderFulfillmentFold.from_events(sid, Enum.map(rows, &row_to_event/1))");
    expect(st).toContain("def instance_by_id(id) when is_binary(id) do");
    expect(st).toContain("case load(id) do");
    expect(st).toContain("[] -> nil");
    expect(st).toContain("loaded -> OrderFulfillmentFold.from_events(id, loaded)");
  });

  it("the create starter folds the stream and appends its own events", async () => {
    const h = (await gen()).get(`${WF}/order_fulfillment/start_order_placed.ex`)!;
    expect(h).toContain("def handle(%Api.Fulfillment.Events.OrderPlaced{} = event) do");
    expect(h).toContain("key = event.order");
    expect(h).toContain("OrderFulfillmentFold.from_events(key,");
    expect(h).toContain(
      "events = [%Api.Fulfillment.Events.PaymentRegistered{order: event.order, amount: 0}]",
    );
    expect(h).toContain("OrderFulfillmentStream.append(sid, events)");
    expect(h).toContain("Enum.each(events, &Api.Fulfillment.Dispatcher.dispatch/1)");
  });

  it("the on-reactor drops + logs on an empty stream and reads folded state", async () => {
    const h = (await gen()).get(`${WF}/order_fulfillment/on_payment_registered.ex`)!;
    expect(h).toContain("case Api.Fulfillment.Workflows.OrderFulfillmentStream.load(sid) do");
    expect(h).toContain("[] ->");
    expect(h).toContain("event_unrouted");
    // The precondition reads the folded state.
    expect(h).toContain("ensure(state.paid >= 0, :precondition_failed)");
  });

  it("emits no mutable saga-state Ecto schema for the ES workflow", async () => {
    const s = (await gen()).get(`${WF}/order_fulfillment_state.ex`)!;
    // The state path's schema would carry `use Ecto.Schema` + timestamps(); the
    // ES fold struct carries neither.
    expect(s).not.toContain("timestamps()");
  });
});
