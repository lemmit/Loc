// Generator coverage for the `mutating` tier of `domainService` on the TS /
// Hono backend (domain-services.md rev. 4, Slice 2).
//
// A `mutating` service mutates the aggregates the orchestrator PASSES IN, via
// their own ops (`source.withdraw(amount)`).  The workflow loads the targets,
// calls the service, and — because the mutation set is exactly the aggregate
// args the service wrote — persists THOSE args at exit.  On Drizzle/Hono there
// is no change-tracking, so the orchestrator calls `repository.save(agg)` per
// mutated arg INSIDE the transaction.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const MUTATING = `
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
`;

describe("typescript generator — domainService mutating tier", () => {
  it("emits the service call and saves the mutated args inside the transaction", async () => {
    const { model, errors } = await parseString(MUTATING);
    expect(errors).toEqual([]);
    const wf = generateHono(model).get("http/workflows.ts")!;
    expect(wf).toBeDefined();
    // The service is imported and called with the loaded aggregate args.
    expect(wf).toContain('import { Transfer } from "../domain/services";');
    expect(wf).toContain("Transfer.run(s, d, amount);");
    // The mutated aggregate args persist via explicit `repository.save(...)`
    // (no change-tracking on Drizzle), inside the workflow transaction.
    expect(wf).toContain("await accounts.save(s);");
    expect(wf).toContain("await accounts.save(d);");
    // The scalar (read-only) arg is never saved.
    expect(wf).not.toContain("save(amount)");
    // The save sits inside the db.transaction scope.
    expect(wf).toMatch(/db\.transaction\(async \(tx\) => \{[\s\S]*await accounts\.save\(s\);/);
  });
});
