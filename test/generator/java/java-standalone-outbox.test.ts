// M-T4.3 — standalone (no-broker) transactional outbox on the Java backend
// (dispatch-delivery-semantics.md §1-2), closing the last M-T4.3 residual: a
// durable channel (`retention: log | work`) with NO `channelSource` used to
// silently downgrade to at-most-once inline dispatch on java. Now it gets the
// same crash-safe in-process outbox node/dotnet/python emit:
//   - LoomEventOutbox (@EventListener) records durable events in __loom_outbox;
//   - the reactor's inline @EventListener is DROPPED (delivery is post-commit);
//   - LocalOutboxRelay drains and invokes the reactor methods directly, threading
//     the outbox row id on OutboxDelivery (the saga marker dedups redelivery).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A durable channel (retention: log) with NO channelSource — standalone. */
const STANDALONE = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() { precondition status == "Draft"  status := "Placed"  emit OrderPlaced { order: id } }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id }
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: log }
      workflow Fulfil {
        orderId: Order id
        status: string
        create(p: OrderPlaced) by p.order { status := "Pending" }
      }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] port: 3000 }
}
`;

/** Same durable channel but WITH a rabbitmq channelSource — the broker path
 *  owns delivery; the standalone tier must NOT emit. */
const BROKER = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() { precondition status == "Draft"  status := "Placed"  emit OrderPlaced { order: id } }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id }
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: work }
      workflow Fulfil { orderId: Order id  status: string  create(p: OrderPlaced) by p.order { status := "Pending" } }
    }
  }
  storage primary { type: postgres }
  storage bus { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
}
`;

/** Ephemeral channel — no durability, no outbox at all. */
const EPHEMERAL = STANDALONE.replace(
  "delivery: broadcast  retention: log",
  "delivery: broadcast  retention: ephemeral",
);

function find(files: Map<string, string>, suffix: string): string {
  for (const [path, content] of files) if (path.endsWith(suffix)) return content;
  return "";
}

describe("java standalone (no-broker) outbox (M-T4.3)", () => {
  it("emits the outbox tee that records durable events in the producer tx", async () => {
    const files = await generateSystemFiles(STANDALONE);
    const tee = find(files, "LoomEventOutbox.java");
    expect(tee).toContain("@EventListener");
    expect(tee).toContain('private static final Set<String> DURABLE = Set.of("OrderPlaced")');
    // Records via a generic Jackson map (no bespoke wire codec — the row round-trips
    // java→db→java only); ephemeral events fall through to Spring's local fan-out.
    expect(tee).toContain("if (!DURABLE.contains(type)) {");
    expect(tee).toContain("outbox.save(new LoomOutboxMessage(type, payload));");
  });

  it("drops the reactor's inline @EventListener so durable delivery is post-commit only", async () => {
    const files = await generateSystemFiles(STANDALONE);
    const dispatcher = find(files, "OrdersDispatcher.java");
    expect(dispatcher).toContain("public void onFulfilStartOrderPlaced(OrderPlaced p) {");
    // The handler carries NO @EventListener (it is relay-delivered).
    expect(dispatcher).not.toContain("@EventListener\n    public void onFulfilStartOrderPlaced");
  });

  it("emits the local relay that invokes the reactor directly with the marker", async () => {
    const files = await generateSystemFiles(STANDALONE);
    const relay = find(files, "LocalOutboxRelay.java");
    expect(relay).toContain("implements SmartLifecycle");
    expect(relay).toContain("OutboxDelivery.setCurrentEventId(row.getId().toString());");
    expect(relay).toContain('case "OrderPlaced" -> {');
    expect(relay).toContain("var e = mapper.convertValue(payload, OrderPlaced.class);");
    expect(relay).toContain("ordersDispatcher.onFulfilStartOrderPlaced(e);");
    // The shared outbox entity + repo ride along; the broker relay does not.
    expect(find(files, "LoomOutboxMessage.java")).toContain('@Table(name = "__loom_outbox")');
    expect(find(files, "OutboxDelivery.java")).toContain("ThreadLocal<String>");
    expect(find(files, "OutboxRelayService.java")).toBe("");
  });

  it("uses the BROKER path (not the standalone tier) when a channelSource is wired", async () => {
    const files = await generateSystemFiles(BROKER);
    expect(find(files, "LoomEventOutbox.java")).toBe("");
    expect(find(files, "LocalOutboxRelay.java")).toBe("");
    // The broker tee + relay own delivery instead.
    expect(find(files, "ChannelPublishTee.java")).not.toBe("");
    expect(find(files, "OutboxRelayService.java")).not.toBe("");
  });

  it("emits no outbox for an ephemeral channel (at-most-once, byte-identical)", async () => {
    const files = await generateSystemFiles(EPHEMERAL);
    expect(find(files, "LoomEventOutbox.java")).toBe("");
    expect(find(files, "LocalOutboxRelay.java")).toBe("");
    expect(find(files, "OutboxDelivery.java")).toBe("");
    // The reactor keeps its inline @EventListener (durable-free path).
    expect(find(files, "OrdersDispatcher.java")).toContain("@EventListener");
  });
});
