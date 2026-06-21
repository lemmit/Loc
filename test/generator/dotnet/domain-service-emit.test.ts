// Generator coverage for `domainService` on the .NET backend
// (domain-services.md, v1 Shape A): each service emits a constructor-less
// `public static class <Name>` under Domain/Services with one `public static`
// method per operation. An `or`-union return reuses the exception-less Domain
// union record shape (the absence of repository injection IS the domain-layer
// guarantee made physical).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    error CouponExpired { code: string }
    aggregate Customer { tier: string }
    aggregate Cart {
      subtotal: money
      operation reprice() {
        let total = Pricing.Quote(this, this)
      }
    }
    repository Customers for Customer { }
    repository Carts for Cart { }

    domainService Pricing {
      operation quote(cart: Cart, customer: Customer): money {
        return cart.subtotal
      }
      operation applyCoupon(price: money): money or CouponExpired {
        return price
      }
    }
  }
`;

async function files(): Promise<Map<string, string>> {
  return generateDotnet(await parseValid(SRC));
}

describe(".NET generator — domainService", () => {
  it("emits a constructor-less public static class under Domain/Services", async () => {
    const svc = (await files()).get("Domain/Services/Pricing.cs");
    expect(svc).toBeDefined();
    expect(svc!).toMatch(/public static class Pricing/);
    // No constructor / DI — the no-infra guarantee made physical.
    expect(svc!).not.toMatch(/public Pricing\(/);
  });

  it("emits one public static method per operation (PascalCased)", async () => {
    const svc = (await files()).get("Domain/Services/Pricing.cs")!;
    expect(svc).toMatch(/public static decimal Quote\(Cart cart, Customer customer\)/);
    expect(svc).toMatch(/return cart\.Subtotal;/);
    // The union return type reuses the shared `unionInstanceName` (a `money`
    // variant tags by its bare primitive name → `moneyOrCouponExpired`), so the
    // wire name matches the aggregate-operation union DTOs byte-for-byte.
    expect(svc).toMatch(/public static moneyOrCouponExpired ApplyCoupon\(decimal price\)/);
    expect(svc).toMatch(/return new moneyOrCouponExpired_money\(price\);/);
  });

  it("emits the pure Domain union record for an or-union return", async () => {
    const union = (await files()).get("Domain/Services/moneyOrCouponExpired.cs");
    expect(union).toBeDefined();
    expect(union!).toMatch(/namespace \w+\.Domain\.Services;/);
    expect(union!).toMatch(/public abstract record moneyOrCouponExpired;/);
    expect(union!).toMatch(
      /public sealed record moneyOrCouponExpired_money\(decimal Value\) : moneyOrCouponExpired;/,
    );
    expect(union!).toMatch(
      /public sealed record moneyOrCouponExpired_CouponExpired\([^)]*\) : moneyOrCouponExpired;/,
    );
  });
});
