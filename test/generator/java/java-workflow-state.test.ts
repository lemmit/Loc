// Java saga-state persistence (workflow-debt-backend-parity.md, Java saga
// slice 1): a correlation-bearing workflow gets a JPA `@Entity` bound to the
// Flyway-owned saga table (correlation field as `@EmbeddedId`, the rest as
// mapped columns) + a Spring Data repository keyed by the correlation id. The
// foundation the in-process dispatcher + instance reads build on.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = `system S { subdomain O { context O {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  aggregate Shipment { orderRef: Order id  status: string  operation mark() { status := "T" } }
  repository Shipments for Shipment { }
  event OrderPlaced { order: Order id }
  event ShipmentRequested { shipment: Shipment id, order: Order id }
  channel L { carries: OrderPlaced, ShipmentRequested  delivery: broadcast  retention: ephemeral }
  enum FulfillmentStatus { Pending, Shipped }
  workflow OrderFulfillment { orderId: Order id  attempts: int  status: FulfillmentStatus
    create(p: OrderPlaced) by p.order { let s = Shipment.create({ orderRef: p.order, status: "P" }) emit ShipmentRequested { shipment: s.id, order: p.order } }
    on(s: ShipmentRequested) by s.order { let sh = Shipments.getById(s.shipment) sh.mark() } }
} } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;

async function gen(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

describe("java saga-state persistence", () => {
  it("emits a @Entity bound to the saga table, keyed by the correlation field", async () => {
    const files = await gen();
    const entity = [...files.entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentState.java"),
    )?.[1];
    expect(entity, "saga-state entity not emitted").toBeDefined();
    expect(entity).toContain("package com.loom.api.infrastructure.persistence;");
    expect(entity).toContain('@Table(name = "order_fulfillments")');
    expect(entity).toContain("public class OrderFulfillmentState {");
    // Correlation field is the @EmbeddedId, mapped to its snake column.
    expect(entity).toContain("@EmbeddedId");
    expect(entity).toContain(
      '@AttributeOverride(name = "value", column = @Column(name = "order_id"))',
    );
    expect(entity).toContain("OrderId orderId;");
    // Remaining state fields are mapped columns (enum → @Enumerated STRING).
    expect(entity).toContain('@Column(name = "attempts")');
    expect(entity).toContain("int attempts;");
    expect(entity).toContain("@Enumerated(EnumType.STRING)");
    expect(entity).toContain("FulfillmentStatus status;");
    // Package-private no-arg ctor + public accessors (aggregate-entity shape).
    expect(entity).toContain("OrderFulfillmentState() {");
    expect(entity).toContain("public OrderId orderId() {");
    expect(entity).toContain("public FulfillmentStatus status() {");
  });

  it("emits a Spring Data repository keyed by the correlation id", async () => {
    const files = await gen();
    const repo = [...files.entries()].find(([k]) =>
      k.endsWith("OrderFulfillmentStateRepository.java"),
    )?.[1];
    expect(repo, "saga-state repository not emitted").toBeDefined();
    expect(repo).toContain("package com.loom.api.infrastructure.repositories;");
    expect(repo).toContain("import com.loom.api.infrastructure.persistence.OrderFulfillmentState;");
    expect(repo).toContain("import com.loom.api.domain.ids.OrderId;");
    expect(repo).toContain(
      "public interface OrderFulfillmentStateRepository extends JpaRepository<OrderFulfillmentState, OrderId> {",
    );
  });

  it("does not emit saga state for a workflow without a correlation field", async () => {
    const PLAIN = `system S { subdomain O { context O {
      aggregate Customer { name: string  operation rename(n: string) { name := n } }
      repository Customers for Customer { }
      workflow renameCustomer { create(customerId: Customer id, newName: string) { let c = Customers.getById(customerId) c.rename(newName) } }
    } } api A from O storage pg { type: postgres } deployable api { platform: java contexts: [O] serves: A port: 8080 } }`;
    const { model } = await parseString(PLAIN);
    const keys = [...generateSystems(model).files.keys()];
    expect(keys.some((k) => /State\.java$|StateRepository\.java$/.test(k))).toBe(false);
  });
});
