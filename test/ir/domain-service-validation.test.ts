// IR-validator coverage for the `domainService` no-infra contract, rev. 4
// tiers (domain-services.md; the `reading` tier is Slice 1).  Diagnostic codes:
//   loom.domain-service-no-emit, loom.domain-service-no-mutation,
//   loom.domain-service-no-repo-write (recast from -no-repo: reads now allowed,
//   writes still rejected), loom.domain-service-no-workflow-start,
//   loom.domain-service-infra-call-from-aggregate, and the
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
      aggregate Cart {
        subtotal: money
        operation clear() { subtotal := money("0") }
      }
      repository Customers for Customer {
        find byTier(tier: string): Customer? where this.tier == tier
      }
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

  it("allows a repository READ in a domain-service operation body (the reading tier)", async () => {
    // rev. 4 `reading` tier: a read-only repository query is now legal — it
    // lowers to a `repo-read` Call and no longer trips the repo gate.  Both the
    // criterionless `findAll()` and a named find are reads.
    const d = await diags(`
      domainService Registration {
        operation isTaken(holder: string): bool {
          let found = Customers.byTier(holder)
          return found == null
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo-write")).toBe(false);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo")).toBe(false);
  });

  it("rejects a repository WRITE in a domain-service operation body", async () => {
    // Writes (save/insert/update/delete/add/remove/commit) stay forbidden — the
    // orchestrator owns persistence.
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart, customer: Customer): money {
          let r = Carts.save(cart)
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo-write")).toBe(true);
  });

  it("rejects calling a reading domain service from an aggregate operation body", async () => {
    // A `reading` service runs infrastructure, so it must be orchestrated by the
    // application layer — never called from inside an aggregate operation.
    const d = await diags(`
      domainService Registration {
        operation isTaken(holder: string): bool {
          let found = Customers.byTier(holder)
          return found == null
        }
      }
      aggregate Account {
        holder: string
        operation rename(name: string) {
          let taken = Registration.isTaken(name)
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-infra-call-from-aggregate")).toBe(true);
  });

  it("does NOT flag a PURE domain service called from an aggregate operation body", async () => {
    // Pure services carry no infrastructure, so the infra-call gate exempts them.
    const d = await diags(`
      domainService Pricing {
        operation surcharge(base: money): money { return base }
      }
      aggregate Account {
        holder: string
        balance: money
        operation reprice() {
          let q = Pricing.surcharge(balance)
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-infra-call-from-aggregate")).toBe(false);
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

  // ── mutating tier (domain-services.md rev. 4, Slice 2) ──
  // A `mutating` service mutates the aggregates the orchestrator PASSES IN, by
  // calling a MUTATING operation on an aggregate PARAMETER (`cart.clear()`).
  // The param-op call is a `method-call`, not an assign/add/remove STATEMENT, so
  // it never trips `no-mutation`; the service stays orchestrator-only.

  it("accepts a mutating-tier service calling a mutating op on an aggregate param", async () => {
    const d = await diags(`
      domainService CartReset {
        operation reset(cart: Cart, other: Cart) {
          cart.clear()
          other.clear()
        }
      }
    `);
    expect(d.filter((x) => x.code.startsWith("loom.domain-service-")).map((x) => x.code)).toEqual(
      [],
    );
  });

  it("rejects a mutating-tier service called from an aggregate operation body", async () => {
    // The mutating tier reaches beyond the aggregate boundary (it mutates other
    // passed-in aggregates), so it must be orchestrated by the application layer.
    const d = await diags(`
      aggregate Account {
        holder: string
        operation rename(name: string) { holder := name }
        operation wipe() {
          AccountReset.reset(this)
        }
      }
      domainService AccountReset {
        operation reset(acct: Account) {
          acct.rename("")
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-infra-call-from-aggregate")).toBe(true);
  });

  it("still rejects a repository WRITE inside a mutating-tier service", async () => {
    const d = await diags(`
      domainService CartReset {
        operation reset(cart: Cart) {
          cart.clear()
          let r = Carts.save(cart)
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo-write")).toBe(true);
  });

  it("still rejects an emit inside a mutating-tier service", async () => {
    const d = await diags(`
      domainService CartReset {
        operation reset(cart: Cart) {
          cart.clear()
          emit Quoted { at: now() }
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-emit")).toBe(true);
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
