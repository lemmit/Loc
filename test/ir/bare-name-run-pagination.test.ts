// B15 (full-review-remediation §B15): `Repo.run(<BareNameRetrieval>, page: {…})`
// must read the `page:` arg like its two sibling branches (the anonymous-
// retrieval and the `Name(args)` forms).  Before the fix the bare-`Name`
// branch returned early and silently dropped pagination.

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

// A PARAMETERLESS retrieval (`Recent`) — the bare-`Name` run form — with a
// call-site `page:` argument.
const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      operation deactivate() { active := false }
    }
    repository Customers for Customer { }
    criterion Active of Customer = active == true
    retrieval Recent of Customer = Active

    workflow sweep {
      create(x: int) {
        let matched = Customers.run(Recent, page: { offset: 5, limit: 20 })
        for c in matched {
          c.deactivate()
        }
      }
    }
  }
`;

describe("B15 — bare-name Repo.run(Name, page:) keeps pagination", () => {
  it("parses cleanly", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("lowers the bare-name run to a repo-run carrying the page: offset + limit", async () => {
    const loom = await buildLoomModel(SRC);
    const w = allContexts(loom).find((c) => c.name === "Sales")!.workflows[0]!;
    const run = w.statements.find((s) => s.kind === "repo-run");
    expect(run).toBeDefined();
    if (run?.kind !== "repo-run") throw new Error("expected repo-run");
    expect(run.retrievalName).toBe("Recent");
    // No criterion args (parameterless retrieval) — this is the bare-`Name` form.
    expect(run.retrievalArgs).toHaveLength(0);
    // The regression: `page:` must survive on the bare-`Name` branch.
    expect(run.page).toBeDefined();
    expect(run.page?.offset).toBeDefined();
    expect(run.page?.limit).toBeDefined();
  });
});
