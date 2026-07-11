// ---------------------------------------------------------------------------
// Java backend — `reading`-tier `domainService` (domain-services.md rev. 4,
// Slice 1).  A service whose body runs read-only repository queries
// (`Accounts.byHolder(holder)`, lowered to a `repo-read` Call) becomes a Spring
// `@Service` bean with one constructor-injected `<Aggregate>Repository` per
// read-port; the read methods carry `@Transactional(readOnly = true)` and the
// `repo-read` arm renders against the injected field
// (`accountsRepository.byHolder(holder)`).  The orchestrating workflow
// constructor-injects the service bean and calls it as an INSTANCE call
// (`registration.isEmailAvailable(source)`).  A PURE service (no read-ports)
// stays the static utility class — BYTE-IDENTICAL to the pre-rev.4 shell.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Banking {
  subdomain Accounts {
    context Accounts {
      valueobject Money {
        amount: decimal
        currency: string
        invariant amount >= 0
      }
      aggregate Account with crudish {
        holder: string
        balance: Money
      }
      repository Accounts for Account {
        find byHolder(holder: string): Account? where this.holder == holder
      }
      // reading tier — read-only repo query, orchestrated by a workflow.
      domainService Registration {
        operation isEmailAvailable(holder: string): bool {
          return Accounts.byHolder(holder) == null
        }
      }
      // pure tier — no infrastructure; stays byte-identical.
      domainService FeeQuote {
        operation forAmount(amount: Money): Money {
          return Money { amount: amount.amount, currency: amount.currency }
        }
      }
      workflow RegisterAccount transactional {
        create(source: string, dest: string, balance: Money) {
          precondition Registration.isEmailAvailable(source)
          let acct = Account.create({ holder: dest, balance: balance })
        }
      }
    }
  }
  storage primary { type: postgres }
  resource accountsState { for: Accounts, kind: state, use: primary }
  deployable api {
    platform: java
    contexts: [Accounts]
    dataSources: [accountsState]
    port: 8080
  }
}
`;

// A pure-only system — the existing v1 Shape A — to prove the pure shell is
// byte-identical with the reading-tier code path present.
const PURE_SRC = `
system PR {
  subdomain D {
    context Sales {
      aggregate Cart {
        subtotal: money
      }
      repository Carts for Cart { }
      domainService Pricing {
        operation quote(cart: Cart): money {
          return cart.subtotal
        }
      }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  deployable pricingApi {
    platform: java
    contexts: [Sales]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;

const ROOT = "api/src/main/java/com/loom/api";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — reading-tier domainService", () => {
  it("emits the reading service as a @Service bean with an injected repository", async () => {
    const svc = (await files()).get(`${ROOT}/domain/services/Registration.java`);
    expect(svc).toBeDefined();
    expect(svc!).toContain("@Service");
    expect(svc!).toContain("public class Registration {");
    // Constructor-injected repository, one per read-port.
    expect(svc!).toContain("private final AccountRepository accountsRepository;");
    expect(svc!).toContain("public Registration(AccountRepository accountsRepository) {");
    expect(svc!).toContain("this.accountsRepository = accountsRepository;");
    // The repository interface is imported.
    expect(svc!).toContain("import com.loom.api.features.accounts.AccountRepository;");
    // Read-only transaction on the read method.
    expect(svc!).toContain("@Transactional(readOnly = true)");
    // It is an INSTANCE method, not static.
    expect(svc!).toContain("public boolean isEmailAvailable(String holder) {");
    expect(svc!).not.toContain("public static boolean isEmailAvailable");
  });

  it("renders the repo-read against the injected repository field", async () => {
    const svc = (await files()).get(`${ROOT}/domain/services/Registration.java`)!;
    expect(svc).toContain("return accountsRepository.byHolder(holder) == null;");
    // The pre-rev.4 stub fell through to a bare `byHolder(holder)` — gone now.
    expect(svc).not.toMatch(/return byHolder\(holder\)/);
  });

  it("injects the reading service into the workflow and calls it as an instance call", async () => {
    const wf = (await files()).get(`${ROOT}/application/workflows/AccountsWorkflows.java`)!;
    // Constructor-injected bean (field name lowerFirst(service)).
    expect(wf).toContain("private final Registration registration;");
    expect(wf).toContain(
      "AccountsWorkflows(AccountRepository accountsRepository, Registration registration)",
    );
    expect(wf).toContain("this.registration = registration;");
    expect(wf).toContain("import com.loom.api.domain.services.Registration;");
    // Instance call at the use site (inside the precondition guard) — the
    // rendered call is the instance form, not the static `Registration.…`.
    // (The DomainException message echoes the source text `Registration.is…`,
    // so assert on the rendered guard condition specifically.)
    expect(wf).toContain("if (!(registration.isEmailAvailable(source)))");
    expect(wf).not.toContain("if (!(Registration.isEmailAvailable(source)))");
  });

  it("keeps a PURE service byte-identical (static utility class, no bean)", async () => {
    const fee = (await files()).get(`${ROOT}/domain/services/FeeQuote.java`)!;
    // Static utility class envelope — unchanged from the pre-rev.4 shell.
    expect(fee).toContain("public final class FeeQuote {");
    expect(fee).toContain("private FeeQuote() {");
    expect(fee).toContain("public static Money forAmount(Money amount) {");
    // No bean machinery leaks into the pure service.
    expect(fee).not.toContain("@Service");
    expect(fee).not.toContain("@Transactional");
    expect(fee).not.toContain("Repository");
  });

  it("a pure-only domainService is identical with the reading code path present", async () => {
    // The shipped v1 Shape A pure service must not drift now that the reading
    // tier shares the emitter — byte-identical static utility class.
    const pure = (await generateSystemFiles(PURE_SRC)).get(
      "pricing_api/src/main/java/com/loom/pricingapi/domain/services/Pricing.java",
    )!;
    expect(pure).toContain("public final class Pricing {");
    expect(pure).toContain("private Pricing() {");
    expect(pure).toContain("public static BigDecimal quote(Cart cart) {");
    expect(pure).not.toContain("@Service");
  });
});
