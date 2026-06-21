// IR-validator coverage for the `domainService` no-infra contract
// (domain-services.md, v1 Shape A).  Diagnostic codes:
//   loom.domain-service-no-emit, loom.domain-service-no-mutation,
//   loom.domain-service-no-repo, loom.domain-service-no-workflow-start,
//   loom.domain-service-single-aggregate (warning).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function diags(body: string) {
  const { model, errors } = await parseString(`
    context Sales {
      event Quoted { at: datetime }
      aggregate Customer { tier: string }
      aggregate Cart { subtotal: money }
      repository Customers for Customer { }
      repository Carts for Cart { }
      workflow Onboarding { create(c: Customer) { let z = 1 } }
      ${body}
    }
  `);
  expect(errors).toEqual([]);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("IR validator — domainService no-infra contract", () => {
  it("rejects an `emit` in a domain-service operation body", async () => {
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          emit Quoted { at: now() }
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-emit")).toBe(true);
  });

  it("rejects a repository call in a domain-service operation body", async () => {
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          let all = Carts.findAll()
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo")).toBe(true);
  });

  it("rejects a write to aggregate state in a domain-service operation body", async () => {
    // A domain service has no `this` to mutate — any `target := value`
    // (the `assign` statement) is the pure-calculator floor's hard error.
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          cart.subtotal := cart.subtotal
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-mutation")).toBe(true);
  });

  it("rejects starting a workflow from a domain-service operation body", async () => {
    // `Onboarding.start(...)` — a call whose receiver names a context
    // workflow reaches the application layer, which the domain-layer
    // service may not do.
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          let r = Onboarding.start(customer)
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-workflow-start")).toBe(true);
  });

  it("warns when every operation takes a single aggregate parameter (anemic)", async () => {
    const d = await diags(`
      domainService CartOps {
        operation total(cart: Cart): money {
          return cart.subtotal
        }
      }
    `);
    const w = d.find((x) => x.code === "loom.domain-service-single-aggregate");
    expect(w).toBeDefined();
    expect(w!.severity).toBe("warning");
  });

  it("accepts a clean pure-calculator service (no diagnostics from this leaf)", async () => {
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          return cart.subtotal
        }
      }
    `);
    expect(d.filter((x) => x.code.startsWith("loom.domain-service-"))).toEqual([]);
  });
});
