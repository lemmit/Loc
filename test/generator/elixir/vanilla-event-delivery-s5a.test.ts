import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// S5a — Phoenix domain-event delivery: persist-then-dispatch
// (docs/plans/phoenix-event-delivery-s5a.md, audit §S5).
//
// A state-persisted operation body that `emit`s a domain event used to
// broadcast BEFORE `persist_change` (phantom events on failed writes) into a
// subscriber-less raw "events" topic (severed saga seam).  The fix reorders to
// persist-first, dispatch-only-on-{:ok, saved}, routing each event through the
// context `Dispatcher` (saga seam) in addition to the PubSub broadcast — the
// same after-commit guarantee the event-sourced path already gives.
// ---------------------------------------------------------------------------

// Context WITHOUT a saga — no Dispatcher module, so the op dispatches via the
// raw broadcast only (post-commit).
const NO_SAGA = `
system Shop {
  subdomain Sales {
    context Ordering {
      event OrderPlaced { order: Order id, at: datetime }
      aggregate Order with crudish {
        total: int
        status: string
        operation place() {
          status := "placed"
          emit OrderPlaced { order: this.id, at: now() }
        }
        operation touch() {
          status := "touched"
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordState { for: Ordering, kind: state, use: primarySql }
  deployable api {
    platform: elixir
    contexts: [Ordering]
    dataSources: [ordState]
    serves: SalesApi
    port: 4000
  }
}
`;

// Context WITH a saga subscribing to the op-emitted event — `contextHasDispatcher`
// is true, so the op body ALSO routes the event through the context Dispatcher.
const WITH_SAGA = `
system FulfillmentSys {
  subdomain Fulfillment {
    context Fulfillment {
      aggregate Order with crudish {
        status: string
        operation place() {
          status := "Placed"
          emit OrderPlaced { order: this.id, at: now() }
        }
      }
      repository Orders for Order { }

      event OrderPlaced { order: Order id, at: datetime }
      event ShipmentRequested { order: Order id, at: datetime }

      channel Lifecycle {
        carries: OrderPlaced, ShipmentRequested
        delivery: broadcast
        retention: ephemeral
      }

      workflow OrderFulfillment {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.order {
          emit ShipmentRequested { order: p.order, at: now() }
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

const get = (m: Map<string, string>, suffix: string) =>
  m.get([...m.keys()].find((k) => k.endsWith(suffix))!)!;

describe("vanilla — S5a persist-then-dispatch", () => {
  it("a state-persisted op that emits persists FIRST, then broadcasts inside {:ok, saved}", async () => {
    const ctx = get(await generateSystemFiles(NO_SAGA), "lib/api/ordering.ex");
    const body = ctx.slice(ctx.indexOf("def place_order(%"), ctx.indexOf("def touch_order(%"));

    // persist_change is `case`d, not the terminal `|> persist_change()` pipe.
    expect(body).toContain("case Api.Ordering.OrderRepository.persist_change(changeset) do");
    // The broadcast/log sit inside the {:ok, saved} arm, AFTER the persist.
    const persistAt = body.indexOf("persist_change(changeset)");
    const logAt = body.indexOf('Logger.info("event_dispatched"');
    const bcastAt = body.indexOf("Phoenix.PubSub.broadcast");
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(logAt);
    expect(logAt).toBeLessThan(bcastAt);
    // event_dispatched catalog line kept byte-similar (literal event_type).
    expect(body).toContain(
      'Logger.info("event_dispatched", event: "event_dispatched", event_type: "OrderPlaced", aggregate: "Order")',
    );
    // No saga here → broadcast only, no Dispatcher.
    expect(body).not.toContain("Dispatcher.dispatch");
  });

  it("routes the event through the context Dispatcher when a saga subscribes (hasDispatcher)", async () => {
    const ctx = get(await generateSystemFiles(WITH_SAGA), "lib/api/fulfillment.ex");
    const body = ctx.slice(ctx.indexOf("def place_order(%"));

    // Both the saga seam (Dispatcher) and the raw broadcast fire, both post-commit.
    expect(body).toContain("Api.Fulfillment.Dispatcher.dispatch(loom_event_0)");
    expect(body).toContain('Phoenix.PubSub.broadcast(Api.PubSub, "events", loom_event_0)');
    const persistAt = body.indexOf("persist_change(changeset)");
    const dispatchAt = body.indexOf("Dispatcher.dispatch(loom_event_0)");
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(dispatchAt);
  });

  it("an explicit `return this` mutating+emitting op persists then dispatches post-commit (S12)", async () => {
    // A returning op whose body ends in `return this` used to keep the inline
    // pre-persist emit + in-memory return (the S5a residual); it now normalizes
    // onto the persist-then-dispatch path.
    const src = `
system FulfillmentSys {
  subdomain Fulfillment {
    context Fulfillment {
      error Rejected { reason: string }
      aggregate Order with crudish {
        status: string
        operation place(): Order or Rejected {
          status := "Placed"
          emit OrderPlaced { order: this.id, at: now() }
          return this
        }
      }
      repository Orders for Order { }

      event OrderPlaced { order: Order id, at: datetime }
      event ShipmentRequested { order: Order id, at: datetime }

      channel Lifecycle {
        carries: OrderPlaced, ShipmentRequested
        delivery: broadcast
        retention: ephemeral
      }

      workflow OrderFulfillment {
        orderId: Order id
        attempts: int
        create(p: OrderPlaced) by p.order {
          emit ShipmentRequested { order: p.order, at: now() }
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
    const ctx = get(await generateSystemFiles(src), "lib/api/fulfillment.ex");
    const body = ctx.slice(ctx.indexOf("def place_order(%"));
    // The explicit-return shape now persists (S12) — no more inline pre-persist
    // emit + in-memory return.
    expect(body).toContain("case Api.Fulfillment.OrderRepository.persist_change(changeset) do");
    const persistAt = body.indexOf("persist_change(changeset)");
    const dispatchAt = body.indexOf("Dispatcher.dispatch(loom_event_0)");
    expect(persistAt).toBeGreaterThan(-1);
    expect(persistAt).toBeLessThan(dispatchAt);
    // Wire projected off the SAVED struct, not the in-memory record.
    expect(body).toContain("{:ok, saved} ->");
    expect(body).toContain("{:ok, %{id: saved.id");
  });

  it("a NON-emitting op keeps the byte-identical plain persist pipe (no case restructure)", async () => {
    const ctx = get(await generateSystemFiles(NO_SAGA), "lib/api/ordering.ex");
    const body = ctx.slice(ctx.indexOf("def touch_order(%"));

    // The plain terminal pipe — unchanged from before S5a.
    expect(body).toContain(`    record
    |> Ecto.Changeset.change(%{})
    |> Ecto.Changeset.put_change(:status, record.status)
    |> Api.Ordering.OrderRepository.persist_change()`);
    // No persist_change `case`, no broadcast/dispatch.
    expect(body).not.toContain("case Api.Ordering.OrderRepository.persist_change");
    expect(body).not.toContain("Phoenix.PubSub.broadcast");
  });
});
