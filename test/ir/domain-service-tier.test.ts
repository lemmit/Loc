// Unit coverage for `classifyDomainServiceTier` (domain-services.md rev. 4).
// The tier is DERIVED from the lowered body — pure (no infra) / reading
// (a `repo-read` Call) / mutating (a call to a mutating op on an aggregate
// PARAMETER, e.g. `src.withdraw(amount)`).  Mutation outranks reading outranks
// pure; the `mutating` tier is detectable only when the classifier is given an
// aggregate-op resolver (it must resolve `param.op(...)` to a mutating op).

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import {
  aggregateOpResolver,
  classifyDomainServiceTier,
} from "../../src/ir/util/domain-service-tier.js";
import { buildLoomModel } from "../_helpers/ir.js";

const SRC = `
  context Banking {
    valueobject Money { amount: decimal currency: string invariant amount >= 0 }
    aggregate Account {
      holder: string
      balance: Money
      operation withdraw(amount: Money) {
        balance := Money { amount: balance.amount - amount.amount, currency: balance.currency }
      }
      derived label: string = holder
    }
    repository Accounts for Account {
      find byHolder(holder: string): Account? where this.holder == holder
    }

    domainService FeeQuote {
      operation forAmount(amount: Money): Money {
        return Money { amount: amount.amount, currency: amount.currency }
      }
    }
    domainService Registration {
      operation isTaken(holder: string): bool {
        return Accounts.byHolder(holder) == null
      }
    }
    domainService Transfer {
      operation run(src: Account, dst: Account, amount: Money) {
        src.withdraw(amount)
        dst.withdraw(amount)
      }
    }
    domainService Inspect {
      // calls a NON-mutating op (a derived read) on a param — stays pure
      operation describe(acct: Account): string {
        return acct.label
      }
    }
  }
`;

async function ctx() {
  const model = await buildLoomModel(SRC);
  return allContexts(model)[0]!;
}

function op(c: Awaited<ReturnType<typeof ctx>>, svc: string) {
  return c.domainServices.find((s) => s.name === svc)!.operations[0]!;
}

describe("classifyDomainServiceTier", () => {
  it("classifies a no-infra service as pure", async () => {
    const c = await ctx();
    expect(classifyDomainServiceTier(op(c, "FeeQuote"))).toBe("pure");
    expect(classifyDomainServiceTier(op(c, "FeeQuote"), aggregateOpResolver(c))).toBe("pure");
  });

  it("classifies a read-only repository query as reading", async () => {
    const c = await ctx();
    expect(classifyDomainServiceTier(op(c, "Registration"))).toBe("reading");
  });

  it("classifies a call to a mutating op on an aggregate param as mutating — with a resolver", async () => {
    const c = await ctx();
    // Without the resolver the classifier can't see the aggregate operations,
    // so the param-op mutation is invisible (never a false `mutating`).
    expect(classifyDomainServiceTier(op(c, "Transfer"))).toBe("pure");
    // With the resolver, `src.withdraw(amount)` resolves to the mutating
    // `Account.withdraw` operation ⇒ mutating tier.
    expect(classifyDomainServiceTier(op(c, "Transfer"), aggregateOpResolver(c))).toBe("mutating");
  });

  it("does NOT classify a call to a NON-mutating member on a param as mutating", async () => {
    const c = await ctx();
    // `acct.label` is a derived read, not a mutating operation.
    expect(classifyDomainServiceTier(op(c, "Inspect"), aggregateOpResolver(c))).toBe("pure");
  });
});
