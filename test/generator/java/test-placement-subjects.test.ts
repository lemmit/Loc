import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Java value-object + domain-service unit-test emission (test-placement.md,
// Phase 2).  A VO/service `test` emits a colocated JUnit class; the service
// class adds the `domain.services.*` wildcard so `<Service>.<op>(…)` resolves.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales { context Orders {
    valueobject Money {
      amount: decimal  currency: string  invariant amount >= 0.0
      test "rejects negative" { expect(Money { amount: -1.0, currency: "USD" }).toThrow() }
    }
    aggregate Order { code: string  total: Money }
    domainService Pricing {
      operation withTax(base: decimal): decimal { return base * 1.1 }
      test "adds ten percent" { expect(Pricing.withTax(100.0)).toBe(110.0) }
    }
    repository Orders for Order { }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Orders, kind: state, use: db }
  deployable api { platform: java contexts: [Orders] serves: ShopApi dataSources: [st] port: 8082 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("java: value-object + domain-service unit tests", () => {
  it("emits a VO test class", async () => {
    const files = await generateSystemFiles(SRC);
    const vo = get(files, "MoneyTests.java");
    expect(vo, "MoneyTests.java").toBeDefined();
    expect(vo).toContain("public class MoneyTests {");
    expect(vo).toContain("import com.loom.api.domain.valueobjects.*;");
    expect(vo).toContain("assertThrows(DomainException.class");
  });

  it("emits a service test class importing domain.services", async () => {
    const files = await generateSystemFiles(SRC);
    const svc = get(files, "PricingTests.java");
    expect(svc, "PricingTests.java").toBeDefined();
    expect(svc).toContain("import com.loom.api.domain.services.*;");
    expect(svc).toContain("Pricing.withTax(");
  });
});
