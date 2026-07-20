import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Context integration test emission on the Java/Spring Boot backend
// (test-placement.md, Phase 3b). A `context`-nested `test` (no `for`) emits a
// `@SpringBootTest` class at the base package that autowires the JPA
// repositories, binds `spring.datasource.*` from LOOM_PG_URL via
// `@DynamicPropertySource` (Flyway migrates on boot), and persists→reads. A
// create persists via `save`; a find→`findById(...).orElseThrow()`.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales { context Ordering {
    aggregate Order { code: string  qty: int }
    repository Orders for Order { }
    test "persists and reads back an order" {
      let o = Order.create({ code: "abc", qty: 2 })
      let found = Order.findById(o.id)
      expect(found.qty).toBe(2)
    }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Ordering, kind: state, use: db }
  deployable api { platform: java contexts: [Ordering] serves: ShopApi dataSources: [st] port: 8080 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("java: context integration test emission (Phase 3b)", () => {
  it("emits a @SpringBootTest at the base package with autowired repos + LOOM_PG_URL binding", async () => {
    const files = await generateSystemFiles(SRC);
    const f = get(files, "src/test/java/com/loom/api/OrderingIntegrationTests.java");
    expect(f, "OrderingIntegrationTests.java").toBeDefined();
    expect(f).toContain("package com.loom.api;");
    expect(f).toContain("@SpringBootTest");
    expect(f).toContain("private OrderRepository orderRepository;");
    expect(f).toContain("@DynamicPropertySource");
    expect(f).toContain('System.getenv("LOOM_PG_URL")');
    expect(f).toContain('registry.add("spring.datasource.url"');
    expect(f).toContain("import com.loom.api.features.orders.*;");
  });

  it("renders create→save, find→findById().orElseThrow(), and the assertion", async () => {
    const f = (await generateSystemFiles(SRC)).get(
      "api/src/test/java/com/loom/api/OrderingIntegrationTests.java",
    )!;
    expect(f).toMatch(/var o = Order\.create\([^)]*\);/);
    expect(f).toContain("orderRepository.save(o);");
    expect(f).toContain("var found = orderRepository.findById(o.id()).orElseThrow();");
    expect(f).toContain("assertEquals(2, found.qty());");
  });

  it("emits nothing for a context with no integration test", async () => {
    const files = await generateSystemFiles(SRC.replace(/test "persists[\s\S]*?\}\n/, ""));
    expect(get(files, "IntegrationTests.java")).toBeUndefined();
  });

  it("op-transition context renders mutate-in-place + save", async () => {
    const withOp = `
system Ship {
  subdomain F { context Fulfillment {
    aggregate Order {
      customerId: string  status: string
      operation place() { precondition status == "Draft"  status := "Placed" }
    }
    repository Orders for Order { }
    test "placing transitions to Placed" {
      let o = Order.create({ customerId: "c1", status: "Draft" })
      o.place()
      let found = Order.findById(o.id)
      expect(found.status).toBe("Placed")
    }
  } }
  api FApi from F
  storage pg { type: postgres }
  resource st { for: Fulfillment, kind: state, use: pg }
  deployable d { platform: java contexts: [Fulfillment] serves: FApi dataSources: [st] port: 4000 }
}`;
    const f = get(await generateSystemFiles(withOp), "FulfillmentIntegrationTests.java");
    expect(f, "FulfillmentIntegrationTests.java").toBeDefined();
    expect(f).toContain("o.place();");
    expect(f).toContain("orderRepository.save(o);");
  });
});
