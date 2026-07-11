// Generator coverage for the `mutating` tier of `domainService` on the Python /
// FastAPI + SQLAlchemy backend (domain-services.md rev. 4, Slice 2).
//
// A `mutating` service mutates the aggregate args the orchestrator passes in
// (their own ops).  The workflow loads the targets, calls the service (a bare
// module function on Python), and persists the mutated args.  The objects are
// session-tracked, so the orchestrator's `session.commit()` flushes them; the
// explicit `repository.save(...)` is the per-arg unit-of-work registration.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

const MUTATING = `system PyMutating {
  subdomain Banking {
    context Banking {
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

describe("python generator — domainService mutating tier", () => {
  it("calls the bare module fn and saves the mutated args in the session UoW", async () => {
    const wf = (await build(MUTATING)).get("api/app/http/workflows_routes.py")!;
    expect(wf).toBeDefined();
    // The service module function is imported by name (bare-fn call resolves).
    expect(wf).toContain("from app.domain.services.transfer import run");
    // The service op renders as a bare module function call with the loaded args.
    expect(wf).toContain("run(s, d, amount)");
    // The mutated aggregate args persist via the repository save (session UoW).
    expect(wf).toContain("await accounts.save(s)");
    expect(wf).toContain("await accounts.save(d)");
    // The scalar (read-only) arg is never saved.
    expect(wf).not.toContain("save(amount)");
  });
});
