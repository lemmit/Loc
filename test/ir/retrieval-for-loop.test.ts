// Parsing + lowering coverage for the workflow `for` loop and the
// `Repo.run(<Retrieval>(args), page?)` call it consumes (retrieval.md /
// PR3-B).

import { describe, expect, it } from "vitest";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      operation deactivate() { active := false }
    }
    repository Customers for Customer { }
    criterion InRegion(rgn: string) of Customer = region == rgn
    retrieval ByRegion(rgn: string) of Customer { where: InRegion(rgn) sort: [name asc] }

    workflow deactivateRegion {
      create(rgn: string) {
      let matched = Customers.run(ByRegion(rgn), page: { offset: 0, limit: 100 })
      for c in matched {
        c.deactivate()
      }
    }
    }
  }
`;

async function wf() {
  const loom = await buildLoomModel(SRC);
  return allContexts(loom).find((c) => c.name === "Sales")!.workflows[0]!;
}

describe("workflow for-loop — parsing + lowering", () => {
  it("parses the `for x in <iterable> { body }` form", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("lowers `Repo.run(...)` to a repo-run statement carrying the retrieval + page", async () => {
    const w = await wf();
    const run = w.statements.find((s) => s.kind === "repo-run");
    expect(run).toBeDefined();
    if (run?.kind === "repo-run") {
      expect(run.retrievalName).toBe("ByRegion");
      expect(run.repoName).toBe("Customers");
      expect(run.aggName).toBe("Customer");
      expect(run.retrievalArgs).toHaveLength(1);
      expect(run.page?.offset).toBeDefined();
      expect(run.page?.limit).toBeDefined();
      expect(run.returnType).toEqual({
        kind: "array",
        element: { kind: "entity", name: "Customer" },
      });
    }
  });

  it("lowers the loop to a for-each with element type + per-iteration save", async () => {
    const w = await wf();
    const loop = w.statements.find((s) => s.kind === "for-each");
    expect(loop).toBeDefined();
    if (loop?.kind === "for-each") {
      expect(loop.var).toBe("c");
      expect(loop.varAggName).toBe("Customer");
      // body op-call mutates `c` → `c` is saved at iteration end.
      expect(loop.savesPerIteration).toEqual([
        { name: "c", aggName: "Customer", repoName: "Customers" },
      ]);
      expect(loop.body.some((s) => s.kind === "op-call")).toBe(true);
    }
  });

  it("produces no validation diagnostics for the well-formed loop", async () => {
    const loom = await buildLoomModel(SRC);
    const diags = validateLoomModel(loom).filter((d) => d.source.includes("deactivateRegion"));
    expect(diags).toEqual([]);
  });
});

describe("workflow for-loop — validation negatives", () => {
  it("rejects a `for` over a non-array binding", async () => {
    const loom = await buildLoomModel(`
      context Sales {
        aggregate Customer { active: bool
          operation deactivate() { active := false }
        }
        repository Customers for Customer { }
        workflow bad {
      create(id: Customer id) {
          let one = Customers.getById(id)
          for c in one { c.deactivate() }
        }
    }
      }
    `);
    const diags = validateLoomModel(loom).filter((d) => d.source.includes("bad"));
    expect(diags.some((d) => /must iterate a 'let .* = Repo\.run/.test(d.message))).toBe(true);
  });

  it("rejects `Repo.run` of a retrieval whose target ≠ the repository aggregate", async () => {
    const loom = await buildLoomModel(`
      context Sales {
        aggregate Customer { active: bool }
        aggregate Order { total: decimal }
        repository Customers for Customer { }
        repository Orders for Order { }
        criterion Big of Order = total > 100
        retrieval BigOrders of Order = Big
        workflow bad {
      create() {
          let xs = Customers.run(BigOrders)
          for x in xs { }
        }
    }
      }
    `);
    const diags = validateLoomModel(loom).filter((d) => d.source.includes("bad"));
    expect(
      diags.some((d) =>
        /is over 'Order', but 'Customers' is a repository for 'Customer'/.test(d.message),
      ),
    ).toBe(true);
  });
});
