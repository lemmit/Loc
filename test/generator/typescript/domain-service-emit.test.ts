// Generator coverage for `domainService` on the TS / Hono backend
// (domain-services.md, v1 Shape A): the `domain/services.ts` file emits an
// exported namespace of pure functions, and a member call from an aggregate
// operation renders as `Pricing.quote(...)`.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Sales {
    error CouponExpired { code: string }
    aggregate Customer { tier: string }
    aggregate Cart {
      subtotal: money
      operation reprice() {
        let total = Pricing.quote(this, this)
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

describe("typescript generator — domainService", () => {
  it("emits an exported namespace of pure functions in domain/services.ts", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const services = files.get("domain/services.ts");
    expect(services).toBeDefined();
    expect(services!).toContain("export namespace Pricing {");
    expect(services!).toContain("export function quote(cart: Cart, customer: Customer)");
    // The or-union return reuses the exception-less union shape.
    expect(services!).toMatch(/applyCoupon\(price: Decimal\):.*type: "CouponExpired"/s);
  });

  it("renders a domain-service member call as Pricing.quote(...)", async () => {
    const { model } = await parseString(SRC);
    const files = generateHono(model);
    // The aggregate file carries the lowered call site.
    const cart = files.get("domain/cart.ts")!;
    expect(cart).toContain("Pricing.quote(");
  });
});
