// `if let <var> = Repo.find(<Criterion>) { … } else { … }` — the workflow
// body's option/null-handling construct (criterion.md, use site 3).
//
// `Repo.find(<Criterion>)` is the single-result sibling of `findAll`: the
// if-let rides the SAME synthetic `findAllBy<Criterion>` retrieval (enrich
// materialises it), runs it with `limit: 1`, binds the first row (or null) to
// `<var>` in the then-branch, and runs `else` on no match.  Retrievals are
// internal (no route leak) — unlike a public repository `find`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYSP = (body: string, platform: string): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order {
        code: string  status: Status  region: string
        operation cancel() { status := Cancelled }
      }
      repository Orders for Order { }
      criterion ActiveOrder of Order = status != Cancelled
      criterion InRegion(rgn: string) of Order = region == rgn
      criterion AmbientOk of bool = true
      event OrderMissing { code: string }
      command C { region: string }
      workflow W { create(c: C) { ${body} } }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

const SYS = (body: string): string => SYSP(body, "node");

async function ctxOf(body: string) {
  const { model } = await parseString(SYS(body), { validate: false });
  return allContexts(enrichLoomModel(lowerModel(model)))[0]!;
}

function firstIfLet(ctx: Awaited<ReturnType<typeof ctxOf>>) {
  const stmts = ctx.workflows[0]!.creates[0]!.statements;
  const il = stmts.find((s) => s.kind === "if-let");
  if (il?.kind !== "if-let") throw new Error("expected an if-let statement");
  return il;
}

async function irCodes(body: string): Promise<string[]> {
  const { model } = await parseString(SYS(body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code ?? "");
}

describe("if let — Repo.find(<Criterion>) option handling", () => {
  it("lowers to an if-let riding the shared findAllBy<Criterion> retrieval", async () => {
    const ctx = await ctxOf(`if let o = Orders.find(ActiveOrder) { o.cancel() }`);
    const il = firstIfLet(ctx);
    expect(il.synthCriterion).toEqual({ name: "ActiveOrder" });
    expect(il.retrievalName).toBe("findAllByActiveOrder");
    expect(il.aggName).toBe("Order");
    expect(il.var).toBe("o");
    // The enrich pass materialises the same retrieval findAll would.
    expect(ctx.retrievals.find((r) => r.name === "findAllByActiveOrder")).toBeDefined();
  });

  it("captures the else branch when present", async () => {
    const il = firstIfLet(
      await ctxOf(
        `if let o = Orders.find(ActiveOrder) { o.cancel() } else { emit OrderMissing { code: c.region } }`,
      ),
    );
    expect(il.thenBody.map((s) => s.kind)).toContain("op-call");
    expect((il.elseBody ?? []).map((s) => s.kind)).toContain("emit");
  });

  it("emits a limit:1 run + first-or-null branch on Hono", async () => {
    const files = await generateSystemFiles(
      SYS(
        `if let o = Orders.find(ActiveOrder) { o.cancel() } else { emit OrderMissing { code: c.region } }`,
      ),
    );
    const wf = [...files].find(([k]) => /workflows\.ts$/.test(k))?.[1] ?? "";
    expect(wf).toContain(
      "const o = (await orders.runFindAllByActiveOrder({ limit: 1 }))[0] ?? null;",
    );
    expect(wf).toContain("if (o !== null) {");
    expect(wf).toContain("} else {");
  });

  it("threads a parameterised criterion's call-site arg through", async () => {
    const files = await generateSystemFiles(
      SYS(`if let o = Orders.find(InRegion(c.region)) { o.cancel() }`),
    );
    const wf = [...files].find(([k]) => /workflows\.ts$/.test(k))?.[1] ?? "";
    expect(wf).toContain("runFindAllByInRegion(c.region, { limit: 1 })");
  });

  it("dedupes the retrieval with a findAll over the same criterion", async () => {
    const ctx = await ctxOf(
      `let xs = Orders.findAll(ActiveOrder)
       for x in xs { }
       if let a = Orders.find(ActiveOrder) { a.cancel() }`,
    );
    expect(ctx.retrievals.filter((r) => r.name === "findAllByActiveOrder")).toHaveLength(1);
  });

  it("rejects a non-find source, a non-aggregate criterion, and bad arity", async () => {
    expect(await irCodes(`if let o = Orders.getById("x") { o.cancel() }`)).toContain(
      "loom.iflet-bad-source",
    );
    expect(await irCodes(`if let o = Orders.find(AmbientOk) { o.cancel() }`)).toContain(
      "loom.findall-criterion-mismatch",
    );
    expect(await irCodes(`if let o = Orders.find(InRegion()) { o.cancel() }`)).toContain(
      "loom.findall-criterion-arity",
    );
  });

  it("accepts a well-formed if-let with no diagnostics", async () => {
    const codes = await irCodes(`if let o = Orders.find(ActiveOrder) { o.cancel() }`);
    expect(codes.filter((c) => c.startsWith("loom.iflet") || c.startsWith("loom.findall"))).toEqual(
      [],
    );
  });

  // Cross-backend smoke: each backend's `ifLet` target emits the shared
  // criterion-query method + its branch idiom without throwing.  (Full
  // compile is gated by the per-backend LOOM_*_BUILD CI suites.)
  const BODY = `if let o = Orders.find(ActiveOrder) { o.cancel() } else { emit OrderMissing { code: c.region } }`;
  it.each([
    ["dotnet", "RunFindAllByActiveOrderAsync", "is not null"],
    ["java", "runFindAllByActiveOrder", "!= null"],
    ["python", "run_find_all_by_active_order", "is not None"],
    ["elixir", "run_find_all_by_active_order", " if "],
  ])("emits the criterion query + branch on %s", async (platform, method, branch) => {
    const files = await generateSystemFiles(SYSP(BODY, platform));
    const all = [...files.values()].join("\n");
    expect(all).toContain(method);
    expect(all).toContain(branch);
  });
});
