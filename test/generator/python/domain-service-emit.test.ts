// Generator coverage for `domainService` on the Python / FastAPI backend
// (domain-services.md, v1 Shape A): one module of stateless module-level
// functions per service under app/domain/services/, an `or`-union return
// reusing the exception-less tagged-dict shape, and the call-site importer
// wiring (the bare `quote(...)` call brings the function into the caller's
// scope via `from app.domain.services.pricing import quote`).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const FIXTURE = `system PyServices {
  subdomain Sales {
    context Sales {
      error CouponExpired { code: string }

      aggregate Customer { tier: string }

      aggregate Cart {
        subtotal: money
        operation reprice() {
          subtotal := Pricing.quote(this)
        }
      }

      repository Customers for Customer { }
      repository Carts for Cart { }

      domainService Pricing {
        operation quote(cart: Cart): money {
          return cart.subtotal
        }
        operation discountFor(cart: Cart, customer: Customer): money {
          return cart.subtotal
        }
        operation applyCoupon(price: money): money or CouponExpired {
          precondition price > 0
          return price
        }
      }
    }
  }

  api SalesApi from Sales

  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }

  deployable api {
    platform: python
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8000
  }
}
`;

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python generator — domainService", () => {
  it("emits a module of stateless module-level functions (no class, no self)", async () => {
    const files = await build();
    const svc = files.get("api/app/domain/services/pricing.py");
    expect(svc).toBeDefined();
    // Bare module-level function — no class wrapper, no `self`.
    expect(svc!).not.toContain("class ");
    expect(svc!).not.toContain("self");
    expect(svc!).toContain("def quote(cart: Cart) -> Decimal:");
    expect(svc!).toContain("def discount_for(cart: Cart, customer: Customer) -> Decimal:");
    // The package marker exists so `app.domain.services` is importable.
    expect(files.get("api/app/domain/services/__init__.py")).toBe("");
  });

  it("imports the aggregate classes its signatures reference", async () => {
    const files = await build();
    const svc = files.get("api/app/domain/services/pricing.py")!;
    expect(svc).toContain("from app.domain.cart import Cart");
    expect(svc).toContain("from app.domain.customer import Customer");
  });

  it("renders an or-union return as the exception-less tagged dict shape", async () => {
    const files = await build();
    const svc = files.get("api/app/domain/services/pricing.py")!;
    // Union return type degrades to `dict[str, object]` (parity with the
    // aggregate-operation union return), and the precondition gate raises
    // DomainError — both reuse shipped machinery.
    expect(svc).toContain("def apply_coupon(price: Decimal) -> dict[str, object]:");
    expect(svc).toContain("from app.domain.errors import DomainError");
    expect(svc).toMatch(/raise DomainError\(/);
  });

  it("wires the call-site importer so the bare quote(...) call resolves", async () => {
    const files = await build();
    const cart = files.get("api/app/domain/cart.py")!;
    // The PY_TARGET leaf renders the call bare; the aggregate module must
    // import the function by name.
    expect(cart).toContain("from app.domain.services.pricing import quote");
    expect(cart).toContain("quote(self)");
  });
});
