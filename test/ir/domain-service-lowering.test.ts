// Lowering coverage for `domainService` (domain-services.md, v1 Shape A):
// the DomainServiceIR record on the bounded context, and the call-site
// resolution of a member call `Pricing.quote(...)` to a Call with
// `callKind: "domain-service"` + the structured `serviceRef`.

import { describe, expect, it } from "vitest";
import { allContexts, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  context Sales {
    valueobject Money { amount: decimal }
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
    }
  }
`;

// A `reading`-tier service: its body runs a read-only repository query, which
// lowers to a resolved `repo-read` Call (domain-services.md rev. 4, Slice 1).
const READING_SRC = `
  context Banking {
    aggregate Account { holder: string }
    repository Accounts for Account {
      find byHolder(holder: string): Account? where this.holder == holder
    }
    domainService Registration {
      operation isTaken(holder: string): bool {
        return Accounts.byHolder(holder) == null
      }
    }
  }
`;

describe("lowering — domainService", () => {
  it("records domain services on the bounded-context IR", async () => {
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    expect(ctx.domainServices.map((s) => s.name)).toEqual(["Pricing"]);
    const pricing = ctx.domainServices[0]!;
    expect(pricing.operations.map((o) => o.name)).toEqual(["quote"]);
    const quote = pricing.operations[0]!;
    expect(quote.params.map((p) => p.name)).toEqual(["cart", "customer"]);
    // Cross-aggregate params type as entities.
    expect(quote.params[0]!.type).toEqual({ kind: "entity", name: "Cart" });
    expect(quote.returnType).toEqual({ kind: "primitive", name: "money" });
    // Statement body lowers through the ordinary path.
    expect(quote.body[0]!.kind).toBe("return");
    // Derive-not-stamp: mutation legality is a validator concern, never a
    // stamped field on the operation IR — there is no `mutating`/`kind`
    // discriminator to drift out of sync with the body.
    expect(quote).not.toHaveProperty("mutating");
    expect(quote).not.toHaveProperty("kind");
  });

  it("lowers a member call to callKind domain-service + serviceRef", async () => {
    const loom = await buildLoomModel(SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Sales")!;
    const cart = ctx.aggregates.find((a) => a.name === "Cart")!;
    const reprice = cart.operations.find((o) => o.name === "reprice")!;
    const letStmt = reprice.statements.find((s) => s.kind === "let")!;
    const call = (letStmt as Extract<typeof letStmt, { kind: "let" }>).expr as Extract<
      ExprIR,
      { kind: "call" }
    >;
    expect(call.kind).toBe("call");
    expect(call.callKind).toBe("domain-service");
    expect(call.serviceRef).toEqual({ service: "Pricing", op: "quote" });
    expect(call.args.length).toBe(2);
    // The op's declared return type (`money`) flows to the call's result
    // type — `let total = Pricing.quote(...)` binds `total` as money.
    expect((letStmt as Extract<typeof letStmt, { kind: "let" }>).type).toEqual({
      kind: "primitive",
      name: "money",
    });
  });

  it("lowers a repository READ in a reading-tier body to a repo-read Call", async () => {
    const loom = await buildLoomModel(READING_SRC);
    const ctx = allContexts(loom).find((c) => c.name === "Banking")!;
    const reg = ctx.domainServices.find((s) => s.name === "Registration")!;
    const op = reg.operations.find((o) => o.name === "isTaken")!;
    // `return Accounts.byHolder(holder) == null` — the read is the LHS of the
    // binary equality on the returned value.
    const ret = op.body.find((s) => s.kind === "return")! as Extract<
      (typeof op.body)[number],
      { kind: "return" }
    >;
    const cmp = ret.value as Extract<ExprIR, { kind: "binary" }>;
    expect(cmp.kind).toBe("binary");
    const read = cmp.left as Extract<ExprIR, { kind: "call" }>;
    expect(read.kind).toBe("call");
    expect(read.callKind).toBe("repo-read");
    // Fully resolved: the per-backend emitters render against this contract.
    expect(read.repoRead).toEqual({
      repo: "Accounts",
      aggregate: "Account",
      method: "byHolder",
      readKind: "named",
    });
    expect(read.name).toBe("byHolder");
    expect(read.args.length).toBe(1);
  });
});
