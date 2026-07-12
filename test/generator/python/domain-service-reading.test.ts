// Generator coverage for the `reading` tier of `domainService` on the Python /
// FastAPI backend (domain-services.md rev. 4, Slice 1 — mirrors the TS / Hono
// trailblazer in the Python idiom).
//
// A `reading`-tier operation runs read-only repository queries (lowered to
// `repo-read` Calls).  Its generated declaration gains a READ-PORT parameter per
// repository it reads (`accounts: AccountRepository`), AHEAD of the user params;
// the body renders the read against that handle (`await accounts.by_holder(...)`),
// the op becomes `async def`, and the orchestrating workflow constructs the repo
// and supplies the handle at the call site.  A PURE-tier service stays
// byte-identical (no port, no `async`, no `await`).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const READING = `system PyReading {
  subdomain Banking {
    context Banking {
      valueobject Money { amount: decimal currency: string }

      aggregate Account ids guid with crudish {
        holder: string
        balance: Money
      }

      repository Accounts for Account {
        find byHolder(holder: string): Account? where this.holder == holder
      }

      // reading tier — read-only repo query, orchestrator-only.
      domainService Registration {
        operation bothAvailable(source: string, dest: string): bool {
          return Accounts.byHolder(source) == null && Accounts.byHolder(dest) == null
        }
      }

      // pure tier — no repo read; must stay byte-identical.
      domainService FeeQuote {
        operation forAmount(amount: Money): Money {
          return Money { amount: amount.amount, currency: amount.currency }
        }
      }

      workflow RegisterAccount transactional {
        create(source: string, dest: string, balance: Money) {
          precondition Registration.bothAvailable(source, dest)
          let acct = Account.create({ holder: source, balance: balance })
        }
      }
    }
  }

  api BankingApi from Banking

  storage pg { type: postgres }
  resource bankingState { for: Banking, kind: state, use: pg }

  deployable api {
    platform: python
    contexts: [Banking]
    dataSources: [bankingState]
    serves: BankingApi
    port: 8000
  }
}
`;

async function build(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python generator — domainService reading tier", () => {
  it("declares read-port params and renders the read against the handle (async def)", async () => {
    const files = await build(READING);
    const svc = files.get("api/app/domain/services/registration.py");
    expect(svc).toBeDefined();
    // Reading op: read-port param ahead of the user params, `async def`.  The
    // handle is annotated with the domain-side PORT (Protocol) — audit S7 — not
    // the concrete infra repository.
    expect(svc!).toContain(
      "async def both_available(accounts: AccountRepositoryPort, source: str, dest: str) -> bool:",
    );
    // The `repo-read` arm renders against the threaded handle, await-wrapped.
    expect(svc!).toContain("await accounts.by_holder(source)");
    expect(svc!).toContain("await accounts.by_holder(dest)");
    // The PORT Protocol is imported from the domain layer — the concrete
    // `app.db.repositories` class is NOT (that backward edge is the S7 defect).
    expect(svc!).toContain("from app.domain.repository_ports import AccountRepositoryPort");
    expect(svc!).not.toContain("app.db.repositories");
  });

  it("keeps the PURE-tier operation byte-identical (no port, no async, no await)", async () => {
    const files = await build(READING);
    const svc = files.get("api/app/domain/services/fee_quote.py")!;
    // Plain `def` (not `async def`), no read-port repository in the signature.
    expect(svc).toContain("def for_amount(amount: Money) -> Money:");
    expect(svc).not.toContain("async def for_amount");
    expect(svc).not.toMatch(/for_amount\([^)]*Repository/);
    expect(svc).not.toContain("Repository");
    expect(svc).not.toContain("await");
  });

  it("wires the read-port handle at the workflow call site", async () => {
    const files = await build(READING);
    const wf = files.get("api/app/http/workflows_routes.py")!;
    expect(wf).toBeDefined();
    // The workflow constructs the read-port repo even though its own body never
    // reads it directly, and supplies it ahead of the user args, await-wrapped.
    expect(wf).toContain("accounts = AccountRepository(session, ");
    expect(wf).toContain("(await both_available(accounts, source, dest))");
    // The bare service function is imported by name (PY call-site convention).
    expect(wf).toContain("from app.domain.services.registration import both_available");
  });
});

// Byte-identical guard: a PURE-only service's emitted module must carry no
// port-import line and no `async` — the pre-reading-slice shape unchanged.  This
// pins the "only `reading` services get handles" constraint.
describe("python generator — pure domainService stays byte-identical", () => {
  const PURE = `system PyPure {
    subdomain Sales {
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

  it("emits no read-port import and no async for a pure-only context", async () => {
    const files = await build(PURE);
    const svc = files.get("api/app/domain/services/pricing.py")!;
    expect(svc).toContain("def quote(cart: Cart, customer: Customer) -> Decimal:");
    expect(svc).not.toContain("Repository");
    expect(svc).not.toContain("async");
    expect(svc).not.toContain("await");
  });
});
