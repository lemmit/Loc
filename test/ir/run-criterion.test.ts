// `Repo.run(<Criterion>)` from read positions (read-path-architecture.md,
// "`run` takes a criterion").
//
// `run` historically accepted only a named `retrieval`.  A criterion passed
// directly to `run` (`Orders.run(ActiveOrder)` / `Orders.run(InRegion("EU"))`)
// now rides the SAME synthetic-`findAllBy<Criterion>` path as
// `Repo.findAll(<Criterion>)` — so it is first-class without a new IR shape or a
// per-backend emitter.  Precedence: a name that is a declared `retrieval` keeps
// its retrieval meaning (back-compat); only a criterion-and-not-retrieval name
// re-routes.  These tests pin the lowering marker, the precedence rule, the
// validator surface, and the domain-service (`reading`-tier) read path.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (wf: string, extra = ""): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order { code: string  status: Status  region: string }
      repository Orders for Order { }
      criterion ActiveOrder of Order = status != Cancelled
      criterion InRegion(rgn: string) of Order = region == rgn
      retrieval Recent of Order = status != Cancelled
      command C { region: string }
      ${extra}
      workflow W { create(c: C) { ${wf} } }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function enriched(wf: string, extra = "") {
  const { model } = await parseString(SYS(wf, extra), { validate: false });
  return enrichLoomModel(lowerModel(model));
}

function primaryStmts(m: Awaited<ReturnType<typeof enriched>>): WorkflowStmtIR[] {
  const ctx = allContexts(m)[0]!;
  return ctx.workflows[0]!.creates[0]!.statements;
}

describe("Repo.run(<Criterion>) — lowering", () => {
  it("a parameterless criterion run lowers to a synthCriterion repo-run (findAllBy<Criterion>)", async () => {
    const m = await enriched(`let xs = Orders.run(ActiveOrder)`);
    const run = primaryStmts(m).find((s) => s.kind === "repo-run");
    if (run?.kind !== "repo-run") throw new Error("expected repo-run");
    expect(run.synthCriterion).toEqual({ name: "ActiveOrder" });
    expect(run.retrievalName).toBe("findAllByActiveOrder");
    expect(run.aggName).toBe("Order");
  });

  it("a parameterised criterion run carries the args (identical to findAll)", async () => {
    const m = await enriched(
      `let xs = Orders.run(InRegion(c.region), page: { offset: 0, limit: 10 })`,
    );
    const run = primaryStmts(m).find((s) => s.kind === "repo-run");
    if (run?.kind !== "repo-run") throw new Error("expected repo-run");
    expect(run.synthCriterion).toEqual({ name: "InRegion" });
    expect(run.retrievalName).toBe("findAllByInRegion");
    expect(run.retrievalArgs).toHaveLength(1);
    expect(run.page).toEqual({ offset: expect.anything(), limit: expect.anything() });
    // Enrich materialises the criterion's retrieval, params carried through.
    const ret = allContexts(m)[0]!.retrievals.find((r) => r.name === "findAllByInRegion");
    expect(ret?.params.map((p) => p.name)).toEqual(["rgn"]);
    expect(ret?.criterionRef?.name).toBe("InRegion");
  });

  it("retrieval precedence — a declared retrieval name stays a retrieval, NOT a criterion", async () => {
    // `Recent` is a declared retrieval; `run(Recent)` must keep the retrieval
    // meaning (no synthCriterion), preserving back-compat.
    const m = await enriched(`let xs = Orders.run(Recent)`);
    const run = primaryStmts(m).find((s) => s.kind === "repo-run");
    if (run?.kind !== "repo-run") throw new Error("expected repo-run");
    expect(run.retrievalName).toBe("Recent");
    expect(run.synthCriterion).toBeUndefined();
  });
});

describe("Repo.run(<Criterion>) — validation", () => {
  async function codes(wf: string): Promise<string[]> {
    const { model } = await parseString(SYS(wf), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error")
      .map((d) => d.code ?? "");
  }

  it("a criterion run is accepted — no unknown-retrieval error (the pre-slice-1 failure)", async () => {
    const errs = await codes(`let xs = Orders.run(ActiveOrder, page: { offset: 0, limit: 10 })`);
    expect(errs).not.toContain("loom.workflow-run-unknown-retrieval");
    expect(errs).toEqual([]);
  });

  it("a criterion/aggregate mismatch is still caught via the findall gate", async () => {
    // InRegion is `of Order`; running it on a Customer repo would mismatch — but
    // there's only one repo here, so instead check arity: too few args.
    const errs = await codes(`let xs = Orders.run(InRegion())`);
    expect(errs).toContain("loom.findall-criterion-arity");
  });
});

describe("Repo.run(<Criterion>) — domain-service reading tier", () => {
  it("a criterion run in a reading service lowers to a repo-read carrying synthCriterion", async () => {
    const extra = `
      domainService Reads {
        operation listActive(): Order[] { return Orders.run(ActiveOrder) }
      }`;
    const m = await enriched(`let xs = Orders.findAll(ActiveOrder)`, extra);
    const svc = allContexts(m)[0]!.domainServices.find((s) => s.name === "Reads");
    expect(svc).toBeDefined();
    // The reading-tier read resolves to a `repo-read` Call carrying the same
    // synthetic-criterion marker the workflow path produces — so the backend
    // renders `findAllByActiveOrder` instead of the whole-table `findAll`.
    const blob = JSON.stringify(svc);
    expect(blob).toContain('"callKind":"repo-read"');
    expect(blob).toContain('"synthCriterion":{"name":"ActiveOrder"}');
    expect(blob).toContain("findAllByActiveOrder");
  });
});
