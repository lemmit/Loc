// Regression: an OUTER binding mutated inside a `for-each` body must persist.
//
// `computeSaves` (`src/ir/lower/lower-members.ts`) used to collect op-call
// targets from the CURRENT statement level only.  A workflow that loads an
// aggregate, then mutates it inside a loop over a different collection —
//
//   let acct = Accounts.getById(id)
//   for o in orders { o.markShipped(); acct.charge(o.total) }
//
// — saved `o` per iteration (the loop-local) but NEVER saved `acct`: the
// charges were applied in memory and silently dropped (audit finding 2, lost
// saves).  The fix descends into `for-each`/`if-let` bodies when collecting
// mutation targets, so `acct` (an outer `repo-let`) lands in `savesAtExit`.

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shipping {
    aggregate Account with crudish {
      balance: decimal
      operation charge(amount: decimal) { balance := balance - amount }
    }
    repository Accounts for Account { }

    aggregate Order with crudish {
      total: decimal
      shipped: bool
      operation markShipped() { shipped := true }
    }
    repository Orders for Order { }
    criterion Unshipped of Order = shipped == false
    retrieval Pending of Order = Unshipped

    workflow ShipAll {
      create(acctId: Account id) {
        let acct = Accounts.getById(acctId)
        let orders = Orders.run(Pending)
        for o in orders {
          o.markShipped()
          acct.charge(o.total)
        }
      }
    }
  }
`;

describe("typescript generator — outer binding mutated inside a for-each persists", () => {
  it("saves the loop-local `o` per iteration AND the outer `acct` at exit", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const wf = generateHono(model).get("http/workflows.ts")!;
    expect(wf).toBeDefined();
    // The loop-local order still saves per iteration (inside the loop body).
    expect(wf).toContain("await orders.save(o);");
    // The outer account — mutated by `acct.charge(...)` INSIDE the loop — now
    // persists.  Before the fix this line was absent (silent data loss).
    expect(wf).toContain("await accounts.save(acct);");
  });
});
