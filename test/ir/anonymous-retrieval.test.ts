// Anonymous retrieval literals — `Repo.run(retrieval { where: <Criterion>
// sort: [...] loads: [...] }, page?)` (criterion.md, use site 3).
//
// The inline `retrieval { … }` block is the call-site twin of a declared
// `retrieval`: it desugars to a synthetic `findAllBy<Criterion>` retrieval (the
// same enrich path `findAll` uses), so the existing retrieval emitters apply
// `.orderBy(...)` + the load shape on every backend.  `findAll(<Criterion>)`
// stays as the bare-criterion shorthand; shaping lives on the (named or
// anonymous) retrieval, never on findAll.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (body: string): string => `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order ids guid { code: string  status: Status  region: string }
      repository Orders for Order { }
      criterion ActiveOrder of Order = status != Cancelled
      criterion InRegion(rgn: string) of Order = region == rgn
      criterion AmbientOk of bool = true
      command C { region: string }
      workflow W { create(c: C) { ${body} } }
    }
  }
  api A from Sales
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: node  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function retrievals(body: string) {
  const { model } = await parseString(SYS(body), { validate: false });
  return allContexts(enrichLoomModel(lowerModel(model)))[0]!.retrievals;
}

async function langErrors(body: string): Promise<string[]> {
  const { diagnostics } = await parseString(SYS(body), { validate: true });
  return (diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
}

async function irCodes(body: string): Promise<string[]> {
  const { model } = await parseString(SYS(body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code ?? "");
}

describe("anonymous retrieval — run(retrieval { where, sort, loads })", () => {
  it("desugars to a synthetic retrieval carrying the criterion + sort terms", async () => {
    const rs = await retrievals(
      `let xs = Orders.run(retrieval { where: ActiveOrder  sort: [region desc, code asc] })
       for o in xs { }`,
    );
    // S8: the synthetic name is a READABLE rendering of the shape, not a
    // structural hash — it becomes a public method name on every backend.
    const ret = rs.find((r) => r.name === "findAllByActiveOrderByRegionDescThenCodeAsc");
    expect(ret).toBeDefined();
    expect(ret?.criterionRef?.name).toBe("ActiveOrder");
    expect(ret?.sort.map((sortTerm) => [sortTerm.path[0]?.name, sortTerm.direction])).toEqual([
      ["region", "desc"],
      ["code", "asc"],
    ]);
  });

  it("threads a parameterised criterion's call-site arg through", async () => {
    const files = await generateSystemFiles(
      SYS(`let ys = Orders.run(retrieval { where: InRegion(c.region) }, page: { offset: 0, limit: 10 })
        for o in ys { }`),
    );
    const repo = [...files].find(([k]) => /order-repository\.ts$/.test(k))?.[1] ?? "";
    const wf = [...files].find(([k]) => /workflows\.ts$/.test(k))?.[1] ?? "";
    expect(repo).toContain("const inRegionCriterion = (rgn: string) =>");
    expect(repo).toContain(".where(inRegionCriterion(rgn))");
    expect(wf).toContain(
      "const ys = await orders.runFindAllByInRegion(c.region, { offset: 0, limit: 10 });",
    );
  });

  it("emits .orderBy(...) on Hono for the shaped run", async () => {
    const files = await generateSystemFiles(
      SYS(`let xs = Orders.run(retrieval { where: ActiveOrder  sort: [code desc] })
        for o in xs { }`),
    );
    const repo = [...files].find(([k]) => /order-repository\.ts$/.test(k))?.[1] ?? "";
    expect(repo).toContain(".orderBy(desc(schema.orders.code))");
  });

  it("dedupes identical shapes, separates distinct ones", async () => {
    const rs = await retrievals(
      `let a = Orders.run(retrieval { where: ActiveOrder  sort: [code desc] })
       let b = Orders.run(retrieval { where: ActiveOrder  sort: [code desc] })
       let c = Orders.run(retrieval { where: ActiveOrder  sort: [code asc] })
       for o in a { }
       for o in b { }
       for o in c { }`,
    );
    const names = rs.filter((r) => r.name.startsWith("findAllByActiveOrderBy")).map((r) => r.name);
    expect(names.sort()).toEqual([
      "findAllByActiveOrderByCodeAsc",
      "findAllByActiveOrderByCodeDesc",
    ]);
  });

  it("rejects a non-criterion where: at the language layer", async () => {
    const errs = await langErrors(
      `let xs = Orders.run(retrieval { where: status != Cancelled })
        for o in xs { }`,
    );
    expect(errs.some((m) => /'where:' must be a criterion reference/.test(m))).toBe(true);
  });

  it("reuses the criterion checks: unknown sort field, non-aggregate candidate", async () => {
    expect(
      await irCodes(`let xs = Orders.run(retrieval { where: ActiveOrder  sort: [nope desc] })
        for o in xs { }`),
    ).toContain("loom.retrieval-sort-unknown-field");
    expect(
      await irCodes(`let xs = Orders.run(retrieval { where: AmbientOk })
        for o in xs { }`),
    ).toContain("loom.findall-criterion-mismatch");
  });
});

describe("S8 — the synthetic name is readable on every backend's public surface", () => {
  // The name minted at lower-workflow.ts becomes a PUBLIC domain-surface
  // method on all five backends; a structural hash there leaks compiler
  // internals into the ubiquitous language (audit S8).  Pin the readable
  // rendering AND the absence of the old `Shaped<hash>` residue.
  const BODY = `let xs = Orders.run(retrieval { where: ActiveOrder  sort: [code desc] })
       for o in xs { }`;
  const CASES: [string, RegExp][] = [
    ["node", /runFindAllByActiveOrderByCodeDesc/],
    ["dotnet", /FindAllByActiveOrderByCodeDescSpec/],
    ["java", /runFindAllByActiveOrderByCodeDesc/],
    ["python", /run_find_all_by_active_order_by_code_desc/],
    ["elixir { foundation: vanilla }", /run_find_all_by_active_order_by_code_desc_order/],
  ];
  for (const [platform, name] of CASES) {
    it(`${platform.split(" ")[0]}: emits the shape-derived method name, no hash`, async () => {
      const files = await generateSystemFiles(
        SYS(BODY).replace("platform: node", `platform: ${platform}`),
      );
      const all = [...files.values()].join("\n");
      expect(all).toMatch(name);
      expect(all).not.toMatch(/Shaped[0-9a-z]{4,}|shaped[0-9a-z]{4,}/);
    });
  }
});
