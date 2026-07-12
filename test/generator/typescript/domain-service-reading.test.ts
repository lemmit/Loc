// Generator coverage for the `reading` tier of `domainService` on the TS / Hono
// backend (domain-services.md rev. 4, Slice 1 — the trailblazer).
//
// A `reading`-tier operation runs read-only repository queries (lowered to
// `repo-read` Calls).  Its generated declaration gains a READ-PORT parameter per
// repository it reads (`accounts: AccountRepository`), the body renders the read
// against that handle (`await accounts.byHolder(holder)`), and the orchestrating
// workflow supplies the handle at the call site.  A PURE-tier service stays
// byte-identical (no port, no `async`, no `await`).

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const READING_SRC = `
  context Banking {
    valueobject Money { amount: decimal currency: string }
    aggregate Account ids guid with crudish {
      holder: string
      balance: Money
    }
    repository Accounts for Account {
      find byHolder(holder: string): Account? where this.holder == holder
    }
    domainService Registration {
      operation isEmailAvailable(holder: string): bool {
        return Accounts.byHolder(holder) == null
      }
    }
    domainService FeeQuote {
      operation forAmount(amount: Money): Money {
        return Money { amount: amount.amount, currency: amount.currency }
      }
    }
    workflow RegisterAccount transactional {
      create(holder: string, balance: Money) {
        precondition Registration.isEmailAvailable(holder)
        let acct = Account.create({ holder: holder, balance: balance })
      }
    }
  }
`;

describe("typescript generator — domainService reading tier", () => {
  it("declares a read-port parameter and renders the read against it", async () => {
    const { model, errors } = await parseString(READING_SRC);
    expect(errors).toEqual([]);
    const files = generateHono(model);
    const services = files.get("domain/services.ts")!;
    expect(services).toBeDefined();
    // Reading op: read-port param ahead of the user param, `async`, `Promise<…>`.
    // The handle is typed against the domain-side PORT (audit S7), NOT the
    // concrete infra repository.
    expect(services).toContain(
      "export async function isEmailAvailable(accounts: AccountRepositoryPort, holder: string): Promise<boolean>",
    );
    // The `repo-read` arm renders against the threaded handle, await-wrapped.
    expect(services).toContain("return (await accounts.byHolder(holder)) === null;");
    // The PORT is imported from the domain layer — the concrete `db/repositories`
    // class is NOT (that backward edge is the S7 defect being fixed).
    expect(services).toContain('import type { AccountRepositoryPort } from "./repository-ports";');
    expect(services).not.toContain("db/repositories");
  });

  it("keeps the PURE-tier operation byte-identical (no port, no async, no await)", async () => {
    const { model } = await parseString(READING_SRC);
    const services = generateHono(model).get("domain/services.ts")!;
    // FeeQuote takes no read-port, is a plain `export function`, returns the
    // value directly — the pure-tier shell unchanged by the reading slice.
    expect(services).toContain("export namespace FeeQuote {");
    // Plain `export function` (not `async`), value return (not `Promise<…>`),
    // and no read-port repository in the signature — the pure-tier shell.
    expect(services).toContain("export function forAmount(amount: Money): Money {");
    expect(services).not.toContain("export async function forAmount");
    expect(services).not.toMatch(/forAmount\([^)]*Repository/);
  });

  it("wires the read-port handle at the workflow call site", async () => {
    const { model } = await parseString(READING_SRC);
    const wf = generateHono(model).get("http/workflows.ts")!;
    expect(wf).toBeDefined();
    // The workflow constructs the read-port repo even though its own body never
    // reads it directly, and supplies it ahead of the user args, await-wrapped.
    expect(wf).toContain("const accounts = new AccountRepository(tx, events);");
    expect(wf).toContain("(await Registration.isEmailAvailable(accounts, holder))");
    // The service namespace is imported into the workflow file.
    expect(wf).toContain('import { Registration } from "../domain/services";');
  });
});

// Byte-identical guard: a PURE-only service's emitted `services.ts` must be
// EXACTLY what the pre-reading-slice emitter produced (no port-import line, no
// async).  This pins the "only `reading` services get handles" constraint.
describe("typescript generator — pure domainService stays byte-identical", () => {
  const PURE_SRC = `
    context Sales {
      error CouponExpired { code: string }
      aggregate Customer { tier: string }
      aggregate Cart { subtotal: money }
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

  it("emits no read-port import and no async for a pure-only context", async () => {
    const { model } = await parseString(PURE_SRC);
    const services = generateHono(model).get("domain/services.ts")!;
    expect(services).toContain("export function quote(cart: Cart, customer: Customer): Decimal {");
    expect(services).not.toContain("Repository");
    expect(services).not.toContain("async");
    expect(services).not.toContain("await");
  });
});
