// ---------------------------------------------------------------------------
// Java backend — domain-layer emission (slice S3 of
// docs/old/plans/java-backend-implementation.md): ids, enums, value objects,
// events, aggregate roots + parts.  The same fixture compiles under
// `mvn compile` in the opt-in LOOM_JAVA_BUILD suite; these unit tests pin
// the emitted Java shape.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = (directoryLayout: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      enum Status { pending, confirmed, shipped }
      valueobject Address {
        city: string
        zip: string
        invariant zip.length > 0
      }
      event OrderConfirmed { order: Order id, at: datetime }
      aggregate Order {
        code: string
        status: Status
        shipTo: Address
        notes: string?
        total: money
        placedAt: datetime
        contains lineItems: LineItem[]

        entity LineItem {
          sku: string
          qty: int
          price: money
          invariant qty > 0
        }

        derived itemCount: int = lineItems.count
        derived lineTotal: money = lineItems.sum(i => i.price)
        invariant code.length > 0
        function isMutable(): bool = status == pending

        operation confirm() {
          precondition isMutable()
          precondition lineItems.count > 0
          status := confirmed
          emit OrderConfirmed { order: id, at: now() }
        }

        operation addItem(sku: string, qty: int, price: money) {
          precondition qty > 0
          lineItems += LineItem { sku: sku, qty: qty, price: price }
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable shopApi {
    platform: java {
      directoryLayout: ${directoryLayout}
    }
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

const ROOT = "shop_api/src/main/java/com/loom/shopapi";

async function byFeatureFiles(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC("byFeature"));
}

describe("java generator — domain layer (S3)", () => {
  it("emits the typed id record with a newId factory", async () => {
    const id = (await byFeatureFiles()).get(`${ROOT}/domain/ids/OrderId.java`)!;
    expect(id).toContain("public record OrderId(UUID value) implements Serializable {");
    expect(id).toContain("import com.fasterxml.uuid.Generators;");
    expect(id).toContain("return new OrderId(Generators.timeBasedEpochGenerator().generate());");
  });

  it("emits enums with DSL-cased constants (wire parity)", async () => {
    const status = (await byFeatureFiles()).get(`${ROOT}/domain/enums/Status.java`)!;
    expect(status).toContain("public enum Status {");
    expect(status).toContain("    pending,");
    expect(status).toContain("    shipped");
  });

  it("emits value objects as records running invariants in the compact constructor", async () => {
    const vo = (await byFeatureFiles()).get(`${ROOT}/domain/valueobjects/Address.java`)!;
    expect(vo).toContain("@ValueObject");
    expect(vo).toContain("public record Address(String city, String zip) {");
    // Compact-constructor scope: bare params, not `this.` (unassignable there).
    expect(vo).toContain(
      'if (!(zip.length() > 0)) throw new DomainException("Invariant violated: zip.length > 0");',
    );
  });

  it("emits events as records implementing the DomainEvent marker", async () => {
    const ev = (await byFeatureFiles()).get(`${ROOT}/domain/events/OrderConfirmed.java`)!;
    expect(ev).toContain("@org.jmolecules.event.annotation.DomainEvent");
    expect(ev).toContain(
      "public record OrderConfirmed(OrderId order, Instant at) implements DomainEvent {",
    );
  });

  it("emits the aggregate root with fields, accessors, derived, and the create factory", async () => {
    const order = (await byFeatureFiles()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain("@org.jmolecules.ddd.annotation.AggregateRoot");
    expect(order).toContain("public class Order {");
    expect(order).toContain("    OrderId id;");
    expect(order).toContain("    List<LineItem> lineItems = new ArrayList<>();");
    expect(order).toContain(
      "    private final transient List<DomainEvent> _domainEvents = new ArrayList<>();",
    );
    // Record-style accessors; collection accessors defensive-copy.
    expect(order).toContain("public OrderId id() {");
    expect(order).toContain("return List.copyOf(lineItems);");
    // Derived: typed-sum reduction resolved from the part's declared field type.
    expect(order).toContain(
      "return this.lineItems.stream().map(i -> i.price()).reduce(BigDecimal.ZERO, BigDecimal::add);",
    );
    // Public create factory mints the id then asserts invariants.
    expect(order).toContain(
      "public static Order create(String code, Status status, Address shipTo, String notes, BigDecimal total, Instant placedAt) {",
    );
    expect(order).toContain("e.id = OrderId.newId();");
    expect(order).toContain("e._assertInvariants();");
  });

  it("renders operation bodies: preconditions, assignment, emit in declared event order", async () => {
    const order = (await byFeatureFiles()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain(
      'if (!(this.isMutable())) throw new DomainException("Precondition failed: isMutable()");',
    );
    expect(order).toContain("this.status = Status.confirmed;");
    expect(order).toContain("this._domainEvents.add(new OrderConfirmed(this.id, Instant.now()));");
    // Mutating ops re-assert invariants on exit.
    expect(order).toContain("this._assertInvariants();");
  });

  it("emits parts with parentId + the positional _create factory the `new <Part>` arm targets", async () => {
    const files = await byFeatureFiles();
    const item = files.get(`${ROOT}/features/orders/LineItem.java`)!;
    expect(item).toContain("@org.jmolecules.ddd.annotation.Entity");
    expect(item).toContain("    OrderId parentId;");
    expect(item).toContain(
      "public static LineItem _create(OrderId parentId, String sku, int qty, BigDecimal price) {",
    );
    expect(item).toContain("p.id = LineItemId.newId();");
    // The aggregate's addItem routes through it.
    const order = files.get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain("this.lineItems.add(LineItem._create(this.id, sku, qty, price));");
  });

  it("byLayer layout rehomes per-aggregate files under domain/<plural> with matching packages", async () => {
    const files = await generateSystemFiles(SRC("byLayer"));
    const order = files.get(`${ROOT}/domain/orders/Order.java`)!;
    expect(order).toContain("package com.loom.shopapi.domain.orders;");
    expect(files.has(`${ROOT}/features/orders/Order.java`)).toBe(false);
    // Shared categories stay put under both layouts.
    expect(files.has(`${ROOT}/domain/ids/OrderId.java`)).toBe(true);
  });

  it("emits shared exception types + package markers for wildcard imports", async () => {
    const files = await byFeatureFiles();
    expect(files.get(`${ROOT}/domain/common/DomainException.java`)).toContain(
      "public class DomainException extends RuntimeException {",
    );
    expect(files.get(`${ROOT}/domain/common/ForbiddenException.java`)).toContain(
      "public class ForbiddenException extends RuntimeException {",
    );
    expect(files.get(`${ROOT}/domain/enums/_Namespace.java`)).toContain(
      "public final class _Namespace {",
    );
  });
});
