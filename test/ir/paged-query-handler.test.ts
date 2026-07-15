// Paged queryHandler over `Repo.run(<Criterion>)` — the durable read-path
// vehicle (read-path-architecture.md, "The ergonomic default").
//
// A `queryHandler H(...): <Agg> paged { let r = Repo.run(<Criterion>(args)); return r }`
// exposes a criterion-filtered, paged read through the read-only port. Enrich
// synthesizes a paged `FindIR` (flagged `synthesized`, so the aggregate router
// does NOT auto-expose it) onto the aggregate's repository, reusing #1904's
// paged-find repo-method emission; the Hono explicit-handler emitter binds the
// page/pageSize/sort/dir route params and returns the `Paged<T>` envelope.
// Non-node backends are honestly gated (`loom.paged-query-handler-unsupported-backend`)
// until their emitters fan out.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (platform = "node"): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string  region: string }
      repository Orders for Order { }
      criterion InRegion(rgn: string) of Order = region == rgn
      queryHandler ListInRegion(rgn: string): Order paged {
        let r = Orders.run(InRegion(rgn))
        return r
      }
    }
  }
  api A from Sales { route GET "/orders/projections/in_region" -> Orders.ListInRegion }
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d { platform: ${platform}  contexts: [Orders]  dataSources: [s]  serves: A  port: 3000 }
}`;

async function enriched(platform = "node") {
  const { model } = await parseString(SYS(platform), { validate: false });
  return enrichLoomModel(lowerModel(model));
}

describe("paged queryHandler — enrich synthesis", () => {
  it("synthesizes a paged, non-exposed FindIR for the criterion on the aggregate's repo", async () => {
    const ctx = allContexts(await enriched())[0]!;
    const repo = ctx.repositories.find((r) => r.aggregateName === "Order")!;
    const find = repo.finds.find((f) => f.name === "findAllByInRegion");
    expect(find, "synthesized paged find").toBeDefined();
    expect(find?.synthesized).toBe(true);
    // Paged return carrier + criterion filter + reified criterion ref.
    expect(find?.returnType).toEqual({
      kind: "genericInstance",
      ctor: "paged",
      arg: { kind: "entity", name: "Order" },
    });
    expect(find?.criterionRef?.name).toBe("InRegion");
    expect(find?.params.map((p) => p.name)).toEqual(["rgn"]);
  });
});

describe("paged queryHandler — validation", () => {
  async function errorCodes(platform: string): Promise<string[]> {
    const { model } = await parseString(SYS(platform), { validate: false });
    return validateLoomModel(enrichLoomModel(lowerModel(model)))
      .filter((d) => d.severity === "error")
      .map((d) => d.code ?? "");
  }

  it("a supported backend accepts a paged queryHandler", async () => {
    for (const platform of ["node", "python", "java"]) {
      expect(await errorCodes(platform)).not.toContain(
        "loom.paged-query-handler-unsupported-backend",
      );
    }
  });

  it("a not-yet-supported backend is honestly gated (loom.paged-query-handler-unsupported-backend)", async () => {
    for (const platform of ["dotnet", "elixir"]) {
      expect(await errorCodes(platform)).toContain("loom.paged-query-handler-unsupported-backend");
    }
  });
});

describe("paged queryHandler — Hono emission", () => {
  it("emits ONE paged route calling the paged repo method + returning the envelope", async () => {
    const files = await generateSystemFiles(SYS("node"));
    const routeFiles = [...files.entries()].filter(([p]) => p.endsWith("-routes.ts"));
    const joined = routeFiles.map(([, c]) => c).join("\n");
    // The queryHandler's own route is the only `in_region` route (the
    // synthesized find is NOT auto-exposed → no `/orders/in_region`).
    expect(joined).toContain('path: "/orders/projections/in_region"');
    expect(joined).not.toContain('path: "/orders/in_region"');
    // Calls the paged repo method with page/pageSize/sort/dir and wraps the
    // envelope, wire-projecting items.
    expect(joined).toMatch(/findAllByInRegion\([^)]*page[^)]*pageSize[^)]*sort[^)]*dir/);
    expect(joined).toMatch(/items:\s*result\.items\.map\(/);
  });
});
