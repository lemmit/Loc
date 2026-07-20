import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Elixir (vanilla Phoenix) value-object + domain-service unit-test emission
// (test-placement.md, Phase 2).  A VO test → `<Ctx>.<Vo>Test` asserting the
// `<VO>.new/1` invariant; a service test → `<Ctx>.<Svc>Test` calling the pure
// `App.Domain.Services.<Svc>.<op>` fn.  Both trip the `test_helper.exs` gate.
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
      operation withTax(amt: decimal): decimal { return amt * 1.1 }
      test "adds ten percent" { expect(Pricing.withTax(100.0)).toBe(110.0) }
    }
    repository Orders for Order { }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Orders, kind: state, use: db }
  deployable api { platform: elixir contexts: [Orders] serves: ShopApi dataSources: [st] port: 8085 }
}`;

const file = (files: Map<string, string>, suffix: string): string | undefined => {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  return key ? files.get(key) : undefined;
};

describe("elixir: value-object + domain-service unit tests", () => {
  it("emits a VO test module asserting the <VO>.new/1 invariant", async () => {
    const files = await generateSystemFiles(SRC);
    const vo = file(files, "test/orders/money_test.exs");
    expect(vo, "money_test.exs").toBeDefined();
    expect(vo).toContain("defmodule Api.Orders.MoneyTest do");
    expect(vo).toContain("assert {:error, _} = Api.Orders.Money.new(%{");
  });

  it("emits a service test module calling the pure Domain.Services fn", async () => {
    const files = await generateSystemFiles(SRC);
    const svc = file(files, "test/orders/pricing_test.exs");
    expect(svc, "pricing_test.exs").toBeDefined();
    expect(svc).toContain("defmodule Api.Orders.PricingTest do");
    expect(svc).toContain("Api.Domain.Services.Pricing.with_tax(");
  });

  it("emits test_helper.exs (gate widened to VO/service tests)", async () => {
    const files = await generateSystemFiles(SRC);
    expect(file(files, "test/test_helper.exs")).toBeDefined();
  });
});
