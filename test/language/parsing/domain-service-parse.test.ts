// Grammar coverage for the `domainService` declaration (domain-services.md,
// v1 Shape A — the pure-calculator floor).  Statement-body operations only,
// cross-aggregate params spelled as plain aggregate names, an `or`-union
// return, and coexistence with the `X id` containment restriction.

import { describe, expect, it } from "vitest";
import { isBoundedContext, isDomainService } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

describe("parsing — domainService declaration", () => {
  it("parses a multi-operation service with cross-aggregate params + or-union return", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        valueobject Money { amount: decimal }
        error CouponExpired { code: string }
        aggregate Customer { tier: string }
        aggregate Cart { subtotal: money }
        repository Customers for Customer { }
        repository Carts for Cart { }

        domainService Pricing {
          operation quote(cart: Cart, customer: Customer): money {
            return cart.subtotal
          }
          operation applyCoupon(price: money, code: string): money or CouponExpired {
            return price
          }
        }
      }
    `);
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const svc = ctx.members.filter(isDomainService);
    expect(svc.map((s) => s.name)).toEqual(["Pricing"]);
    const ops = svc[0]!.operations;
    expect(ops.map((o) => o.name)).toEqual(["quote", "applyCoupon"]);
    // Cross-aggregate params resolve as plain aggregate names.
    expect(ops[0]!.params.map((p) => p.name)).toEqual(["cart", "customer"]);
    // The or-union return parses (head + one alternative).
    expect(ops[1]!.returnType?.alternatives?.length).toBe(1);
  });

  it("coexists with the `X id` cross-aggregate containment restriction", async () => {
    // A domainService cross-aggregate param (`customer: Customer`) is a
    // different grammar position from a containment partType, where a bare
    // cross-aggregate reference is still rejected and `X id` is required.
    const { errors } = await parseString(`
      context Sales {
        aggregate Customer { name: string }
        aggregate Order {
          customer: Customer id
        }
        repository Customers for Customer { }
        repository Orders for Order { }

        domainService Reporting {
          operation describe(order: Order, customer: Customer): string {
            return customer.name
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});
