// Generator coverage for `domainService` on the Phoenix / Elixir backend
// (domain-services.md, v1 Shape A): a stateless pure-calculator module under
// `<App>.Domain.Services.*` — a plain `defmodule` (NO `use Ash.Resource`, NO
// GenServer), one `def <op>` per operation with an `@spec`, a `precondition`
// guard that raises, and an `or`-union return that rides the tagged-tuple
// convention.  The emitted module path MUST match what the ELIXIR_TARGET call
// leaf renders (`<App>.Domain.Services.<Name>`), so a call from an aggregate
// op resolves.  (`platform: elixir` is plain Phoenix LiveView on Ecto — the
// Ash foundation was removed; this module touches no persistence anyway.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function srcFor(): string {
  return `
system Orders {
  subdomain Sales {
    context Pricing {
      error CouponExpired { code: string }
      aggregate Customer ids guid { tier: string }
      aggregate Cart ids guid {
        subtotal: money
        operation reprice() {
          let total = Quotes.quote(this, this)
        }
      }
      repository Customers for Customer { }
      repository Carts for Cart { }

      domainService Quotes {
        operation quote(cart: Cart, customer: Customer): money {
          precondition cart.subtotal > 0
          return cart.subtotal
        }
        operation applyCoupon(price: money): money or CouponExpired {
          return price
        }
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Pricing, kind: state, use: primary }
  deployable shop {
    platform: elixir
    contexts: [Pricing]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;
}

function bySuffix(f: Map<string, string>, suffix: string): string {
  const key = [...f.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return f.get(key)!;
}

describe("phoenix generator — domainService (domain-services.md)", () => {
  it("emits a plain stateless module — no Ash.Resource / GenServer / state", async () => {
    const files = await generateSystemFiles(srcFor());
    const svc = bySuffix(files, "domain/services/quotes.ex");
    // App prefix = toModulePrefix(toSnakeApp("shop")) = "Shop".
    expect(svc).toContain("defmodule Shop.Domain.Services.Quotes do");
    expect(svc).not.toContain("use Ash.Resource");
    expect(svc).not.toContain("use GenServer");
    expect(svc).not.toContain("postgres do");
  });

  it("emits one `def` per operation with an `@spec`", async () => {
    const files = await generateSystemFiles(srcFor());
    const svc = bySuffix(files, "domain/services/quotes.ex");
    // The signature spec carries each param type + the return type.
    expect(svc).toContain(
      "@spec quote(Shop.Pricing.Cart.t(), Shop.Pricing.Customer.t()) :: Decimal.t()",
    );
    expect(svc).toContain("def quote(cart, customer) do");
    // A plain return is the bare value (Elixir last-expression result).
    expect(svc).toContain("cart.subtotal");
    // `precondition` raises the same ArgumentError guard the aggregate op
    // body emits.
    expect(svc).toMatch(
      /if not \(.*\), do: raise\(ArgumentError, "Precondition failed: cart\.subtotal > 0"\)/,
    );
    // The unused `customer` param is discarded so --warnings-as-errors stays clean.
    expect(svc).toContain("_ = customer");
  });

  it("renders an `or`-union return as the tagged-tuple convention", async () => {
    const files = await generateSystemFiles(srcFor());
    const svc = bySuffix(files, "domain/services/quotes.ex");
    // Union return → `{:ok, value}` for the success arm (the spec is the
    // transport-only `map()` carrier).
    expect(svc).toContain("@spec apply_coupon(Decimal.t()) :: map()");
    expect(svc).toContain("def apply_coupon(price) do");
    expect(svc).toContain("{:ok, price}");
  });

  it("the emitted module path matches the call-site qualification", async () => {
    const files = await generateSystemFiles(srcFor());
    // The call site in Cart.reprice (the context module's named-op function)
    // renders the fully-qualified module — the SAME `<App>.Domain.Services.
    // <Name>` the declaration emits, so the call resolves at compile time.
    const cart = bySuffix(files, "shop/pricing.ex");
    expect(cart).toContain("Shop.Domain.Services.Quotes.quote(");
    const svc = bySuffix(files, "domain/services/quotes.ex");
    expect(svc).toContain("defmodule Shop.Domain.Services.Quotes do");
  });

  it("emits the identical module on the vanilla foundation (no persistence)", async () => {
    const files = await generateSystemFiles(srcFor());
    const svc = bySuffix(files, "domain/services/quotes.ex");
    expect(svc).toContain("defmodule Shop.Domain.Services.Quotes do");
    expect(svc).toContain("def quote(cart, customer) do");
    expect(svc).not.toContain("use Ash.Resource");
  });
});
