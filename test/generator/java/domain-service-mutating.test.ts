// Generator coverage for the `mutating` tier of `domainService` on the Java /
// Spring + JPA backend (domain-services.md rev. 4, Slice 2).
//
// A `mutating` service mutates the aggregate args the orchestrator passes in
// (their own ops).  The workflow loads the targets, calls the service, and
// persists the mutated args.  The passed-in entities are JPA-managed, so
// dirty-checking flushes at the `@Transactional` boundary; the explicit
// `repository.save(...)` the workflow emits is harmless (and needed for a
// newly-created aggregate).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Banking {
  subdomain Accounts {
    context Accounts {
      aggregate Account with crudish {
        holder: string
        balance: decimal
        operation withdraw(amount: decimal) {
          balance := balance - amount
        }
        operation deposit(amount: decimal) {
          balance := balance + amount
        }
      }
      repository Accounts for Account { }
      domainService Transfer {
        operation run(source: Account, dest: Account, amount: decimal) {
          source.withdraw(amount)
          dest.deposit(amount)
        }
      }
      workflow MoveMoney transactional {
        create(src: Account id, dst: Account id, amount: decimal) {
          let s = Accounts.getById(src)
          let d = Accounts.getById(dst)
          Transfer.run(s, d, amount)
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

const ROOT = "api/src/main/java/com/loom/api";

describe("java generator — domainService mutating tier", () => {
  it("calls the static service and saves the mutated args under @Transactional", async () => {
    const files = await generateSystemFiles(SRC);
    const wf = files.get(`${ROOT}/application/workflows/AccountsWorkflows.java`)!;
    expect(wf).toBeDefined();
    // The workflow class is transactional — managed entities flush at the boundary.
    expect(wf).toContain("@Transactional");
    // The static service class is imported (so the static call resolves).
    expect(wf).toContain("import com.loom.api.domain.services.Transfer;");
    // The service is called statically with the loaded aggregate args.
    expect(wf).toContain("Transfer.run(s, d, amount);");
    // The mutated aggregate args persist (explicit save covers new aggregates).
    expect(wf).toContain("accountsRepository.save(s);");
    expect(wf).toContain("accountsRepository.save(d);");
    // The scalar (read-only) arg is never saved.
    expect(wf).not.toContain("save(amount)");
  });
});
