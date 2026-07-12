// IR-layer coverage for the `mutating` domain-service tier persistence rule
// (domain-services.md rev. 4, Slice 2): a workflow that calls a `mutating`
// domain service must persist exactly the aggregate ARGS the service mutated
// (their own ops) — and NOT the read-only args.
//
// `Transfer.run(s, d, amount)` mutates its `source`/`dest` aggregate params via
// `source.withdraw(...)` / `dest.deposit(...)`; the workflow passes its loaded
// `s`/`d` into those positions, so `s`/`d` land in `savesAtExit` while the
// scalar `amount` does not.  The mutated arg set is DERIVED in `computeSaves`
// from the resolved service op + aggregate ops, never stamped.

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
      operation deposit(amount: decimal) {
        balance := balance + amount
      }
      derived label: string = holder
    }
    repository Accounts for Account { }

    // mutating tier — mutates the passed-in aggregate args via their own ops.
    domainService Transfer {
      operation run(source: Account, dest: Account, amount: decimal) {
        source.withdraw(amount)
        dest.deposit(amount)
      }
    }

    // read-only tier — calls a NON-mutating member (a derived read) on its arg.
    domainService Inspect {
      operation describe(acct: Account): string {
        return acct.label
      }
    }

    workflow MoveMoney transactional {
      create(src: Account id, dst: Account id, amount: decimal) {
        let s = Accounts.getById(src)
        let d = Accounts.getById(dst)
        Transfer.run(s, d, amount)
      }
    }

    // A workflow whose only service call is read-only — nothing to save.
    workflow LookAtIt transactional {
      create(one: Account id) {
        let a = Accounts.getById(one)
        Inspect.describe(a)
      }
    }
  }
`;

async function ctx() {
  return allContexts(await buildLoomModel(SRC))[0]!;
}

describe("mutating domain-service persistence — computeSaves derivation", () => {
  it("lowers a bare service call to a `domain-service-call` (not a Transfer op-call)", async () => {
    const wf = (await ctx()).workflows.find((w) => w.name === "MoveMoney")!;
    const create = wf.creates.find((c) => c.name === null)!;
    const kinds = create.statements.map((s) => s.kind);
    expect(kinds).toEqual(["repo-let", "repo-let", "domain-service-call"]);
    const call = create.statements.find((s) => s.kind === "domain-service-call")!;
    expect(call).toMatchObject({ service: "Transfer", op: "run" });
  });

  it("saves exactly the MUTATED aggregate args (s, d) — and not the scalar arg", async () => {
    const wf = (await ctx()).workflows.find((w) => w.name === "MoveMoney")!;
    const create = wf.creates.find((c) => c.name === null)!;
    const saved = create.savesAtExit.map((s) => s.name).sort();
    expect(saved).toEqual(["d", "s"]);
    // The scalar (read-only) arg never persists.
    expect(saved).not.toContain("amount");
    // Each save carries the resolved aggregate + its repository.
    expect(create.savesAtExit).toContainEqual({
      name: "s",
      aggName: "Account",
      repoName: "Accounts",
    });
  });

  it("saves NOTHING when the only service call is read-only", async () => {
    const wf = (await ctx()).workflows.find((w) => w.name === "LookAtIt")!;
    const create = wf.creates.find((c) => c.name === null)!;
    expect(create.savesAtExit).toEqual([]);
  });
});
