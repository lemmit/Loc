import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python value-object + domain-service unit-test emission (test-placement.md,
// Phase 2).  A VO test → tests/test_<vo>.py importing from app.domain.value_objects;
// a service test → tests/test_<svc>.py importing the bare op functions from
// app.domain.services.<svc>.
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
  deployable api { platform: python contexts: [Orders] serves: ShopApi dataSources: [st] port: 8083 }
}`;

const get = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("python: value-object + domain-service unit tests", () => {
  it("emits tests/test_money.py importing the VO", async () => {
    const files = await generateSystemFiles(SRC);
    const vo = get(files, "tests/test_money.py");
    expect(vo, "test_money.py").toBeDefined();
    expect(vo).toContain("from app.domain.value_objects import Money");
    expect(vo).toContain("def test_rejects_negative()");
  });

  it("emits tests/test_pricing.py importing the service op function", async () => {
    const files = await generateSystemFiles(SRC);
    const svc = get(files, "tests/test_pricing.py");
    expect(svc, "test_pricing.py").toBeDefined();
    expect(svc).toContain("from app.domain.services.pricing import with_tax");
    expect(svc).toContain("with_tax(100.0)");
  });
});
