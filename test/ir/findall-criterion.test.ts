// `Repo.findAll(<Criterion>)` from workflow bodies (criterion.md, use site 3).
//
// The call desugars to a `repo-run` of a synthetic `findAllBy<Criterion>`
// retrieval that the enrich pass materialises from the context's criteria — so
// it rides the existing retrieval pipeline on every backend with no new
// per-backend emitter and no grammar change.  These tests pin the lowering
// marker, the enrich synthesis, the validator surface, and the Hono output.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (wf: string, extra = ""): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order { code: string  status: Status  region: string }
      aggregate Other { v: int }
      repository Orders for Order { }
      repository Others for Other { }
      criterion ActiveOrder of Order = status != Cancelled
      criterion InRegion(rgn: string) of Order = region == rgn
      criterion AmbientOk of bool = true
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

async function codes(wf: string, extra = ""): Promise<string[]> {
  const { model } = await parseString(SYS(wf, extra), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => /findall/.test(d.code ?? ""))
    .map((d) => `${d.severity}:${d.code}`);
}

function primaryStmts(m: Awaited<ReturnType<typeof enriched>>): WorkflowStmtIR[] {
  const ctx = allContexts(m)[0]!;
  return ctx.workflows[0]!.creates[0]!.statements;
}

describe("Repo.findAll(<Criterion>) — lowering + enrich", () => {
  it("lowers to a repo-run marked synthCriterion, naming the retrieval findAllBy<Criterion>", async () => {
    const m = await enriched(`let xs = Orders.findAll(ActiveOrder)`);
    const run = primaryStmts(m).find((s) => s.kind === "repo-run");
    expect(run).toBeDefined();
    if (run?.kind !== "repo-run") throw new Error("expected repo-run");
    expect(run.synthCriterion).toEqual({ name: "ActiveOrder" });
    expect(run.retrievalName).toBe("findAllByActiveOrder");
    expect(run.aggName).toBe("Order");
  });

  it("enrich materialises the synthetic retrieval from the criterion (params + where + criterionRef)", async () => {
    const m = await enriched(`let xs = Orders.findAll(InRegion(c.region))`);
    const ret = allContexts(m)[0]!.retrievals.find((r) => r.name === "findAllByInRegion");
    expect(ret).toBeDefined();
    // Params carried through from the criterion, candidate is the aggregate,
    // and the criterionRef keeps reifying backends calling the predicate fn.
    expect(ret?.params.map((p) => p.name)).toEqual(["rgn"]);
    expect(ret?.targetType).toEqual({ kind: "entity", name: "Order" });
    expect(ret?.criterionRef?.name).toBe("InRegion");
    expect(ret?.criterionRef?.args.map((a) => (a.kind === "ref" ? a.name : "?"))).toEqual(["rgn"]);
  });

  it("dedupes the synthetic retrieval across repeated call sites", async () => {
    const m = await enriched(
      `let a = Orders.findAll(ActiveOrder)
       let b = Orders.findAll(ActiveOrder)`,
    );
    const matches = allContexts(m)[0]!.retrievals.filter((r) => r.name === "findAllByActiveOrder");
    expect(matches).toHaveLength(1);
  });
});

describe("Repo.findAll(<Criterion>) — validation", () => {
  it("a bounded (paged) findAll is clean; an unbounded one warns", async () => {
    expect(
      await codes(`let xs = Orders.findAll(ActiveOrder, page: { offset: 0, limit: 10 })`),
    ).toEqual([]);
    expect(await codes(`let xs = Orders.findAll(ActiveOrder)`)).toEqual([
      "warning:loom.findall-no-page",
    ]);
  });

  it("rejects an unknown criterion, a non-aggregate candidate, and arity mismatch", async () => {
    expect(await codes(`let xs = Orders.findAll(Nope)`)).toContain(
      "error:loom.findall-unknown-criterion",
    );
    expect(await codes(`let xs = Orders.findAll(AmbientOk)`)).toContain(
      "error:loom.findall-criterion-mismatch",
    );
    // `ActiveOrder` is `of Order`, but `Others` is a repo for `Other`.
    expect(await codes(`let xs = Others.findAll(ActiveOrder)`)).toContain(
      "error:loom.findall-criterion-mismatch",
    );
    expect(await codes(`let xs = Orders.findAll(InRegion)`)).toContain(
      "error:loom.findall-criterion-arity",
    );
  });
});

describe("Repo.findAll(<Criterion>) — Hono emission", () => {
  it("emits the reified predicate fn, the run method, and the workflow call", async () => {
    const files = await generateSystemFiles(
      SYS(`let regional = Orders.findAll(InRegion(c.region))`),
    );
    const repo = [...files].find(([k]) => /order-repository\.ts$/.test(k))?.[1] ?? "";
    const wf = [...files].find(([k]) => /workflows\.ts$/.test(k))?.[1] ?? "";
    expect(repo).toContain("const inRegionCriterion = (rgn: string) =>");
    expect(repo).toContain("async runFindAllByInRegion(rgn: string, page?:");
    expect(repo).toContain(".where(inRegionCriterion(rgn))");
    expect(wf).toContain("const regional = await orders.runFindAllByInRegion(c.region);");
  });
});
