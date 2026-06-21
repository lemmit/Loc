// ---------------------------------------------------------------------------
// Java backend — `domainService` (domain-services.md, v1 Shape A).  A
// `domainService Pricing { operation quote(...) {...} }` emits a stateless
// `public final class Pricing` of `public static` methods in
// `<base>.domain.services`, reusing the `<Agg>Criteria` envelope (public
// final class + private ctor).  Method bodies render through the shared Java
// statement/expression path; a `require` lowers to the
// `if (!(...)) throw new DomainException(...)` shape; an `or`-union return
// reuses the shipped exception-less sealed-union machinery (sealed interface
// + variant records in the same package).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system PR {
  subdomain D {
    context Sales {
      error CouponExpired { code: string }
      aggregate Cart {
        subtotal: money
        operation reprice() {
          let total = Pricing.quote(this)
        }
      }
      repository Carts for Cart { }

      domainService Pricing {
        operation quote(cart: Cart): money {
          precondition cart.subtotal >= money("0")
          return cart.subtotal
        }
        operation applyCoupon(price: money): money or CouponExpired {
          return price
        }
      }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  deployable pricingApi {
    platform: java
    contexts: [Sales]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;

const ROOT = "pricing_api/src/main/java/com/loom/pricingapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — domainService", () => {
  it("emits a public final class with a private ctor and a public static method", async () => {
    const svc = (await files()).get(`${ROOT}/domain/services/Pricing.java`);
    expect(svc).toBeDefined();
    expect(svc!).toContain("public final class Pricing {");
    expect(svc!).toContain("private Pricing() {");
    expect(svc!).toContain("public static BigDecimal quote(Cart cart) {");
    // The aggregate type named in the signature is imported from its
    // (byFeature) home package.
    expect(svc!).toContain("import com.loom.pricingapi.features.carts.Cart;");
  });

  it("imports the services package into a calling aggregate", async () => {
    const cart = (await files()).get(`${ROOT}/features/carts/Cart.java`)!;
    expect(cart).toContain("import com.loom.pricingapi.domain.services.*;");
    expect(cart).toContain("Pricing.quote(this)");
  });

  it("renders a require as the DomainException guard shape", async () => {
    const svc = (await files()).get(`${ROOT}/domain/services/Pricing.java`)!;
    expect(svc).toMatch(/if \(!\(.*\)\) throw new DomainException\(/);
    expect(svc).toContain("return cart.subtotal();");
  });

  it("reuses the exception-less sealed union for an `or`-union return", async () => {
    const files_ = await files();
    const svc = files_.get(`${ROOT}/domain/services/Pricing.java`)!;
    // The method returns the sealed interface type, not the raw scalar.
    expect(svc).toMatch(/public static \w+ applyCoupon\(BigDecimal price\) \{/);
    // The sealed interface + variant records land in the same package.
    const unionName = svc.match(/public static (\w+) applyCoupon/)![1]!;
    const iface = files_.get(`${ROOT}/domain/services/${unionName}.java`)!;
    expect(iface).toContain(`public sealed interface ${unionName} permits`);
    const errVariant = files_.get(`${ROOT}/domain/services/${unionName}_CouponExpired.java`)!;
    expect(errVariant).toContain(`implements ${unionName} {`);
  });
});
