// Regression: a `mutating` domain-service call inside a workflow `for-each`
// (or `if-let`) body must persist the body-LOCAL binding it mutates.
//
// `computeSaves` only detects a mutating `domain-service-call` when a
// `saveResolver` is threaded to it.  The resolver reached every top-level
// `computeSaves`, but the three NESTED calls (`for-each` savesPerIteration,
// `if-let` savesInThen/savesInElse) were made from `lowerWorkflowStatementInner`
// which never received it — so a service mutation on a loop-local binding
// emitted no save and the write was silently discarded.  The SAME loop with a
// direct op-call persisted correctly.

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SRC = `
  context Banking {
    aggregate Account {
      holder: string
      balance: decimal
      operation withdraw(amount: decimal) {
        balance := balance - amount
      }
    }
    repository Accounts for Account { }

    // mutating tier — mutates its aggregate arg via that arg's own op.
    domainService Charge {
      operation run(acct: Account, amount: decimal) {
        acct.withdraw(amount)
      }
    }

    workflow BatchCharge transactional {
      create(ids: Account id[], amount: decimal) {
        for accId in ids {
          let acct = Accounts.getById(accId)
          Charge.run(acct, amount)
        }
      }
    }
  }
`;

async function forEachStmt() {
  const ctx = allContexts(await buildLoomModel(SRC))[0]!;
  const wf = ctx.workflows.find((w) => w.name === "BatchCharge")!;
  const create = wf.creates.find((c) => c.name === null)!;
  const forEach = create.statements.find((s) => s.kind === "for-each");
  if (!forEach || forEach.kind !== "for-each") throw new Error("for-each not lowered");
  return forEach;
}

describe("workflow nested-body domain-service saves", () => {
  it("persists a loop-local binding mutated by a mutating domain service", async () => {
    const forEach = await forEachStmt();
    // The body loads `acct` locally and a mutating service writes it, so the
    // per-iteration save set must include `acct` — otherwise every charge is
    // silently discarded.
    expect(forEach.savesPerIteration.map((s) => s.name)).toContain("acct");
  });
});
