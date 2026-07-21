import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// .NET value-object + domain-service unit-test emission (test-placement.md,
// Phase 2).  A VO/service `test` emits a colocated xUnit class under
// Tests/<ns>.Tests/{ValueObjects,Services}/, and the test csproj gate widens to
// count them.
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
  deployable api { platform: dotnet contexts: [Orders] serves: ShopApi dataSources: [st] port: 8081 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("dotnet: value-object + domain-service unit tests", () => {
  it("emits a VO test class importing Domain.ValueObjects", async () => {
    const files = await generateSystemFiles(SRC);
    const vo = get(files, "ValueObjects/MoneyTests.cs");
    expect(vo, "MoneyTests.cs").toBeDefined();
    expect(vo).toContain("using Api.Domain.ValueObjects;");
    expect(vo).toContain("public sealed class MoneyTests");
    expect(vo).toContain("Assert.Throws<DomainException>");
  });

  it("emits a service test class importing Domain.Services", async () => {
    const files = await generateSystemFiles(SRC);
    const svc = get(files, "Services/PricingTests.cs");
    expect(svc, "PricingTests.cs").toBeDefined();
    expect(svc).toContain("using Api.Domain.Services;");
    expect(svc).toContain("Pricing.WithTax(");
  });

  it("emits the test csproj (gate widened to VO/service tests)", async () => {
    const files = await generateSystemFiles(SRC);
    expect(get(files, "Api.Tests.csproj"), "test csproj").toBeDefined();
  });
});
