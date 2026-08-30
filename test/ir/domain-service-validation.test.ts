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

// ---------------------------------------------------------------------------
// `loom.domain-service-cross-context-read` — the `reading` tier is scoped to
// the service's OWN context.
//
// `lowerDomainService` indexes the repositories it resolves reads against from
// `env.ctx.members` alone, so a body naming ANOTHER context's repository never
// lowers to a `repo-read`: the receiver stays a `ref` with
// `refKind: "unknown"`, the tier classifier calls the op `pure`, no read-port
// is derived, and all five backends render the unresolved name verbatim
// (TS2304 / CS0103 / "cannot find symbol" / NameError / "undefined variable" —
// see the emitted-output half in
// `test/generator/domain-service-cross-context-read.test.ts`).  It used to pass
// validation with ZERO diagnostics.
// ---------------------------------------------------------------------------

/** Two contexts in one subdomain: `Billing` declares `Customers`, `Ordering`
 *  declares `Orders` and hosts the service under test. */
async function crossDiags(orderingBody: string) {
  const { model, errors } = await parseString(`
    system Shop {
      subdomain Sales {
        context Billing {
          aggregate Customer { name: string }
          repository Customers for Customer {
            find byName(name: string): Customer? where this.name == name
          }
        }
        context Ordering {
          aggregate Order { ref: string }
          repository Orders for Order {
            find byRef(ref: string): Order? where this.ref == ref
          }
          ${orderingBody}
        }
      }
    }
  `);
  expect(errors).toEqual([]);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const crossCode = "loom.domain-service-cross-context-read";

describe("IR validator — domainService cross-context repository reads", () => {
  it("rejects a domain-service body reading another context's repository", async () => {
    const d = await crossDiags(`
      domainService Naming {
        operation isFree(r: string): bool {
          return Customers.byName(r) == null
        }
      }
    `);
    const hit = d.find((x) => x.code === crossCode);
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    // The message must name BOTH sides of the boundary and the workaround —
    // the whole point of an honest gate is that the source tells you what to do.
    expect(hit!.message).toContain("'Customers'");
    expect(hit!.message).toContain("'Billing'");
    expect(hit!.message).toContain("'Ordering'");
    expect(hit!.message).toContain("pass the value in");
    expect(hit!.source).toBe("Ordering/Naming.isFree");
  });

  it("does NOT flag a read of the service's OWN context repository", async () => {
    const d = await crossDiags(`
      domainService Naming {
        operation isFree(r: string): bool {
          return Orders.byRef(r) == null
        }
      }
    `);
    expect(d.some((x) => x.code === crossCode)).toBe(false);
  });

  it("catches a cross-context WRITE too — the repo-write gate is context-local", async () => {
    // `loom.domain-service-no-repo-write` keys on `ctx.repositories`, so a
    // cross-context `Customers.save(x)` is invisible to it.  This gate is the
    // only thing standing between that body and five dangling identifiers.
    const d = await crossDiags(`
      domainService Naming {
        operation isFree(r: string): bool {
          let x = Customers.save(r)
          return true
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo-write")).toBe(false);
    expect(d.some((x) => x.code === crossCode)).toBe(true);
  });

  it("reports one diagnostic per foreign repository, not per mention", async () => {
    const d = await crossDiags(`
      domainService Naming {
        operation isFree(r: string): bool {
          let a = Customers.byName(r)
          let b = Customers.byName(r)
          return a == null && b == null
        }
      }
    `);
    expect(d.filter((x) => x.code === crossCode)).toHaveLength(1);
  });

  it("does NOT flag a local name that merely shadows a foreign repository", async () => {
    // A parameter named `Customers` resolves (`refKind: "param"`), so it is not
    // an unresolved cross-context receiver — the gate must leave it alone.
    const d = await crossDiags(`
      domainService Naming {
        operation isFree(Customers: string): bool {
          return Customers == ""
        }
      }
    `);
    expect(d.some((x) => x.code === crossCode)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `loom.domain-service-read-unsupported` (domainservice-member-chained-repo-read).
//
// `matchRepoRead` (src/ir/lower/repo-read.ts) requires the repository call to
// be the WHOLE postfix chain (`suffixes.length === 1`), so a read used as a
// MEMBER RECEIVER — `Customers.byTier(t).tier` — never lowers to a `repo-read`
// Call.  It stays a `method-call` on an `unknown` ref, which means
// `classifyDomainServiceTier` types the service `pure`, no backend threads a
// read port in, and all five emit the bare source name: node/dotnet/java a
// dangling identifier (TS2304 / CS0103 / "cannot find symbol"), python F821
// with no port param at all, elixir `customers.by_tier(t).tier` — not valid
// Elixir, and the misclassification splits ONE service across two modules.
//
// The `let`-bound sibling one line away IS threaded correctly, which is what
// made this silent rather than obviously broken.  Until the detector is widened
// (the real fix), refuse it by name.
// ---------------------------------------------------------------------------
describe("a repository read in MEMBER-RECEIVER position is refused, not mis-emitted", () => {
  const CODE = "loom.domain-service-read-unsupported";

  it("flags `Repo.find(...).member` in a domain-service body", async () => {
    const d = await diags(`
      domainService Lookup {
        operation tierOf(t: string): string {
          return Customers.byTier(t).tier
        }
      }
    `);
    const hit = d.find((x) => x.code === CODE);
    expect(hit, `got: ${d.map((x) => x.code).join(", ") || "(none)"}`).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.source).toBe("Sales/Lookup.tierOf");
    expect(hit!.message).toContain("Customers.byTier");
    // The message must name the WORKING spelling, not just the rule.
    expect(hit!.message).toContain("let x = Customers.byTier(…)");
  });

  it("CONTROL — the `let`-bound spelling is the supported one and stays clean", async () => {
    const d = await diags(`
      domainService Lookup {
        operation isFree(t: string): bool {
          let c = Customers.byTier(t)
          return c == null
        }
      }
    `);
    expect(d.some((x) => x.code === CODE)).toBe(false);
  });

  it("CONTROL — a whole-chain read in return position stays clean", async () => {
    const d = await diags(`
      domainService Lookup {
        operation isFree(t: string): bool {
          return Customers.byTier(t) == null
        }
      }
    `);
    expect(d.some((x) => x.code === CODE)).toBe(false);
  });

  it("CONTROL — a repository WRITE keeps its own, more specific diagnostic", async () => {
    const d = await diags(`
      domainService Pricing {
        operation quote(cart: Cart): money {
          let r = Carts.save(cart)
          return cart.subtotal
        }
      }
    `);
    expect(d.some((x) => x.code === "loom.domain-service-no-repo-write")).toBe(true);
    expect(d.some((x) => x.code === CODE)).toBe(false);
  });
});
