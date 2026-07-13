// ---------------------------------------------------------------------------
// Java backend — persistence emission (slice S4 of
// docs/old/plans/java-backend-implementation.md): JPA annotations bound to the
// MigrationsIR-derived schema, the repository triple (domain port /
// Spring Data interface with @Query JPQL / impl), Flyway migration files,
// and the single-containment fail-fast gate.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      enum Status { pending, confirmed }
      valueobject Address {
        city: string
        zip: string
      }
      aggregate Order {
        code: string
        status: Status
        shipTo: Address
        total: money
        customer: Customer id
        tagIds: Tag id[]
        contains lineItems: LineItem[]
        entity LineItem {
          sku: string
          qty: int
        }
      }
      aggregate Customer { name: string }
      aggregate Tag { label: string }
      repository Orders for Order {
        find byCode(code: string): Order[] where this.code == code
        find confirmed(): Order[] where this.status == confirmed
        find inCity(city: string): Order[] where this.shipTo.city == city
      }
      repository Customers for Customer { }
      repository Tags for Tag { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable shopApi {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

const ROOT = "shop_api/src/main/java/com/loom/shopapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — JPA mapping (S4)", () => {
  it("annotates the root against the schema the migrations create", async () => {
    const order = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain('@Table(name = "orders", schema = "orders")');
    expect(order).toContain("    @EmbeddedId");
    expect(order).toContain(
      '    @AttributeOverride(name = "value", column = @Column(name = "id"))',
    );
  });

  it("maps enums STRING and flattens embedded value objects onto prefixed columns", async () => {
    const order = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain("    @Enumerated(EnumType.STRING)");
    expect(order).toContain("    @Embedded");
    expect(order).toContain(
      '    @AttributeOverride(name = "city", column = @Column(name = "ship_to_city"))',
    );
    expect(order).toContain(
      '    @AttributeOverride(name = "zip", column = @Column(name = "ship_to_zip"))',
    );
  });

  it("maps `X id` references as embedded id records over one column", async () => {
    const order = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain(
      '    @AttributeOverride(name = "value", column = @Column(name = "customer"))',
    );
  });

  it("maps reference collections onto the association join table, ordered by the target FK id", async () => {
    const order = (await files()).get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain(
      '    @CollectionTable(name = "order_tag_ids", schema = "orders", joinColumns = @JoinColumn(name = "order_id"))',
    );
    // `Tag id[]` is a set (membership only, no order): no `ordinal` column —
    // @OrderBy (no argument) sorts by the element value (the target FK id),
    // the same deterministic read-back projection every other backend applies.
    expect(order).toContain("    @OrderBy");
    expect(order).not.toContain('@OrderColumn(name = "ordinal")');
    expect(order).toContain(
      '    @AttributeOverride(name = "value", column = @Column(name = "tag_id"))',
    );
  });

  it("maps containments as unidirectional one-to-many owning the part FK", async () => {
    const files_ = await files();
    const order = files_.get(`${ROOT}/features/orders/Order.java`)!;
    expect(order).toContain(
      "    @OneToMany(cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.EAGER)",
    );
    // nullable=false is load-bearing: it makes Hibernate write the FK in
    // the child INSERT (the DDL's NOT NULL would reject insert-then-update).
    expect(order).toContain('    @JoinColumn(name = "order_id", nullable = false)');
    const part = files_.get(`${ROOT}/features/orders/LineItem.java`)!;
    expect(part).toContain('@Table(name = "line_items", schema = "orders")');
    expect(part).toContain(
      '    @AttributeOverride(name = "value", column = @Column(name = "order_id", insertable = false, updatable = false))',
    );
  });

  it("ids and value objects are JPA embeddable records", async () => {
    const files_ = await files();
    expect(files_.get(`${ROOT}/domain/ids/OrderId.java`)).toContain(
      "public record OrderId(UUID value) implements Serializable {",
    );
    expect(files_.get(`${ROOT}/domain/ids/OrderId.java`)).toContain("@Embeddable");
    expect(files_.get(`${ROOT}/domain/valueobjects/Address.java`)).toContain("@Embeddable");
  });
});

describe("java generator — repository triple (S4)", () => {
  it("domain port: save / findById / getById / findAll / delete + declared finds", async () => {
    const port = (await files()).get(`${ROOT}/features/orders/OrderRepository.java`)!;
    expect(port).toContain("@org.jmolecules.ddd.annotation.Repository");
    expect(port).toContain("public interface OrderRepository {");
    expect(port).toContain("Order save(Order aggregate);");
    expect(port).toContain("Optional<Order> findById(OrderId id);");
    expect(port).toContain("Order getById(OrderId id);");
    expect(port).toContain("List<Order> findAll();");
    expect(port).toContain("List<Order> byCode(String code);");
  });

  it("Spring Data interface renders IR-derived finds as @Query JPQL", async () => {
    const jpa = (await files()).get(`${ROOT}/features/orders/OrderJpaRepository.java`)!;
    expect(jpa).toContain(
      "public interface OrderJpaRepository extends JpaRepository<Order, OrderId> {",
    );
    expect(jpa).toContain('@Query("select e from Order e where e.code = :code")');
    // Enum literal — fully qualified, as JPQL requires.
    expect(jpa).toContain(
      '@Query("select e from Order e where e.status = com.loom.shopapi.domain.enums.Status.confirmed")',
    );
    // VO sub-column navigates the embedded path.
    expect(jpa).toContain('@Query("select e from Order e where e.shipTo.city = :city")');
    expect(jpa).toContain('List<Order> byCode(@Param("code") String code);');
  });

  it("impl maps the getById miss to AggregateNotFoundException", async () => {
    const impl = (await files()).get(`${ROOT}/features/orders/OrderRepositoryImpl.java`)!;
    expect(impl).toContain("@Repository");
    expect(impl).toContain("public class OrderRepositoryImpl implements OrderRepository {");
    // getById now captures the optional (to log aggregate_loaded) then throws
    // on the miss.
    expect(impl).toContain("var found = jpa.findById(id);");
    expect(impl).toContain("return found.orElseThrow(() ->");
    expect(impl).toContain('new AggregateNotFoundException("Order " + id + " not found"));');
  });
});

describe("java generator — Flyway migrations (S4)", () => {
  it("emits versioned SQL from the shared MigrationsIR and ships the flyway deps", async () => {
    const files_ = await files();
    const sql = files_.get(
      "shop_api/src/main/resources/db/migration/V20260101000000.1__Sales_Initial.sql",
    )!;
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "orders";');
    expect(sql).toContain('CREATE TABLE "orders"."orders" (');
    expect(sql).toContain('CREATE TABLE "orders"."order_tag_ids" (');
    const build = files_.get("shop_api/build.gradle.kts")!;
    expect(build).toContain(
      'implementation("org.springframework.boot:spring-boot-starter-flyway")',
    );
    expect(build).toContain('implementation("org.flywaydb:flyway-database-postgresql")');
  });
});

describe("java validator — single-containment gate (S4)", () => {
  it("accepts a root-declared non-collection containment (mapped since the @OneToOne slice)", async () => {
    const loom = await buildLoomModel(`
      system S {
        subdomain Core {
          context People {
            aggregate Person {
              name: string
              contains profile: Profile
              entity Profile { bio: string }
            }
            repository People for Person { }
          }
        }
        api PeopleApi from Core
        storage primary { type: postgres }
        resource peopleState { for: People, kind: state, use: primary }
        deployable api {
          platform: java
          contexts: [People]
          dataSources: [peopleState]
          serves: PeopleApi
          port: 8081
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(diags.some((d) => d.code === "loom.java-single-containment-unsupported")).toBe(false);
  });
});
