// M-T4.3 — idempotent-consumer markers on the Java (Spring Boot) backend
// (dispatch-delivery-semantics.md §3), closing the slice-7c residual (java's
// saga `last_event_id` dedup was NOT wired — it relied on broker ack semantics
// + idempotent reactors).
//
// Where a deployable HOSTS a durable channel's context AND a non-event-sourced
// saga consumes it, the outbox relay rides the outbox row id as the envelope id,
// the ChannelConsumerService parks it on `OutboxDelivery` around each dispatch,
// and the saga handler compares/stamps its `last_event_id` — at-least-once
// redelivery becomes effectively-once.  A FOREIGN consumer (its module owns no
// outbox table) keeps the ack-semantics stance byte-identically.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A single deployable that BOTH hosts the durable channel (`Lifecycle` in
 *  `Orders`) AND consumes it (the `Fulfil` non-ES saga) — the marker engages. */
const COLOCATED = `
system Acme {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation place() {
          precondition status == "Draft"
          status := "Placed"
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order {}
      event OrderPlaced { order: Order id }
      channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: work }
      workflow Fulfil {
        orderId: Order id
        status: string
        create(p: OrderPlaced) by p.order { status := "Pending" }
      }
    }
  }
  storage primary { type: postgres }
  storage bus { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
}
`;

/** The producer (`salesApi`) hosts the durable channel; the consumer (`shipApi`)
 *  wires it as a FOREIGN channel — its module owns no outbox table, so the
 *  marker must stay off (the slice-3 stance). */
const FOREIGN = `
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
    }
  }
  subdomain Fulfilment {
    context Shipping {
      aggregate Shipment with crudish { orderRef: Order id  status: string }
      repository Shipments for Shipment {}
      workflow Fulfil { orderId: Order id  status: string  create(p: OrderPlaced) by p.order { status := "Pending" } }
    }
  }
  storage primary { type: postgres }
  storage bus { type: rabbitmq }
  resource ordersState { for: Orders, kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
  deployable shipApi  { platform: java contexts: [Shipping] dataSources: [shippingState] channels: [lifecycleBus] port: 3001 }
}
`;

/** An EPHEMERAL-only channel (no `retention: log | work`): no outbox, no
 *  markers — the at-most-once path stays byte-identical. */
const EPHEMERAL = `
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
      channel Lifecycle { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
      workflow Fulfil { orderId: Order id  status: string  create(p: OrderPlaced) by p.order { status := "Pending" } }
    }
  }
  storage primary { type: postgres }
  storage bus { type: redis }
  resource ordersState { for: Orders, kind: state, use: primary }
  channelSource lifecycleBus { for: Lifecycle, use: bus }
  deployable salesApi { platform: java contexts: [Orders] dataSources: [ordersState] channels: [lifecycleBus] port: 3000 }
}
`;

/** Finds the single generated file whose path starts with the deployable dir
 *  and ends with the given suffix (empty string when absent). */
function find(files: Map<string, string>, dep: string, suffix: string): string {
  for (const [path, content] of files) {
    if (path.startsWith(`${dep}/`) && path.endsWith(suffix)) return content;
  }
  return "";
}

describe("java idempotent-consumer markers (M-T4.3)", () => {
  it("maps last_event_id on the hosted saga-state entity under a durable channel", async () => {
    const files = await generateSystemFiles(COLOCATED);
    const state = find(files, "sales_api", "FulfilState.java");
    expect(state).toContain('@Column(name = "last_event_id")');
    expect(state).toContain("String lastEventId;");
    // Record-style accessor (read) + JavaBean setter (write from the dispatcher).
    expect(state).toContain("public String lastEventId() {");
    expect(state).toContain("public void setLastEventId(String lastEventId) {");
  });

  it("emits the OutboxDelivery marker carrier and the dispatcher check + stamp", async () => {
    const files = await generateSystemFiles(COLOCATED);
    const delivery = find(files, "sales_api", "OutboxDelivery.java");
    expect(delivery).toContain("private static final ThreadLocal<String> CURRENT");
    expect(delivery).toContain("public static String currentEventId() {");
    expect(delivery).toContain("public static void setCurrentEventId(String id) {");

    const dispatcher = find(files, "sales_api", "OrdersDispatcher.java");
    expect(dispatcher).toContain("import com.loom.salesapi.domain.common.OutboxDelivery;");
    // Preamble: no-op on a redelivery of the recorded id.
    expect(dispatcher).toContain("var __eventId = OutboxDelivery.currentEventId();");
    expect(dispatcher).toContain(
      "if (__eventId != null && __eventId.equals(state.lastEventId())) {",
    );
    // Stamp before the state save (same tx window as the saga mutation).
    expect(dispatcher).toContain("if (__eventId != null) state.setLastEventId(__eventId);");
  });

  it("threads the envelope id through the broker consumer around each dispatch", async () => {
    const files = await generateSystemFiles(COLOCATED);
    const consumer = find(files, "sales_api", "ChannelConsumerService.java");
    expect(consumer).toContain("import com.loom.salesapi.domain.common.OutboxDelivery;");
    expect(consumer).toContain("OutboxDelivery.setCurrentEventId(envelope.id());");
    expect(consumer).toContain("OutboxDelivery.clear();");
  });

  it("keeps a FOREIGN consumer marker-free (the ack-semantics stance)", async () => {
    const files = await generateSystemFiles(FOREIGN);
    // shipApi hosts no durable channel — its module owns no outbox table.
    expect(find(files, "ship_api", "FulfilState.java")).not.toContain("last_event_id");
    expect(find(files, "ship_api", "ChannelConsumerService.java")).not.toContain("OutboxDelivery");
    expect(find(files, "ship_api", "OutboxDelivery.java")).toBe("");
  });

  it("stays byte-identical for an ephemeral-only channel (no outbox, no markers)", async () => {
    const files = await generateSystemFiles(EPHEMERAL);
    expect(find(files, "sales_api", "FulfilState.java")).not.toContain("last_event_id");
    expect(find(files, "sales_api", "OutboxDelivery.java")).toBe("");
    expect(find(files, "sales_api", "OrdersDispatcher.java")).not.toContain("OutboxDelivery");
  });
});
