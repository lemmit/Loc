// Per-api `httpStatus <Error> <Code>` override clause (exception-less.md A1).
// The api edge overrides an error payload's stdlib default status; the
// override reaches the route via `ctx.errorStatusOverrides` (enrichment).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

const SYS = (apiBody: string) => `
  system Shop {
    subdomain Sales {
      context Shop {
        error OutOfStock { sku: string }
        aggregate Order {
          code: string
          operation reserve(): Order or OutOfStock {
            return OutOfStock { sku: code }
          }
        }
      }
    }
    api SalesApi from Sales ${apiBody}
    storage pg { type: postgres }
    resource shopState { for: Shop, kind: state, use: pg }
    deployable api { platform: node, contexts: [Shop], dataSources: [shopState], port: 4000 }
  }
`;

describe("api httpStatus clause — surface + lowering", () => {
  it("parses `httpStatus <Error> <Code>` and lowers it onto ApiIR.errorStatuses", async () => {
    const { model } = await parseString(SYS("{ httpStatus OutOfStock -> 409 }"), {
      validate: false,
    });
    const api = lowerModel(model).systems[0]!.apis.find((a) => a.name === "SalesApi")!;
    expect(api.errorStatuses).toEqual({ OutOfStock: 409 });
  });

  it("does not collide with a `status:` field name (httpStatus is a distinct keyword)", async () => {
    const { errors } = await parseString(`context C { aggregate A { status: string } }`, {
      validate: false,
    });
    expect(errors).toEqual([]);
  });

  it("merges the override onto each context as errorStatusOverrides (enrichment)", async () => {
    const { model } = await parseString(SYS("{ httpStatus OutOfStock -> 409 }"), {
      validate: false,
    });
    const ctx = allContexts(enrichLoomModel(lowerModel(model))).find((c) => c.name === "Shop")!;
    expect(ctx.errorStatusOverrides).toEqual({ OutOfStock: 409 });
  });
});

describe("api httpStatus clause — route translation", () => {
  it("translates the error variant with the overridden status, not the stdlib default", async () => {
    const files = await generateSystemFiles(SYS("{ httpStatus OutOfStock -> 409 }"));
    const routes = [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"))?.[1] ?? "";
    expect(routes).toContain('if (result.type === "OutOfStock") {');
    expect(routes).toMatch(/c\.json\(\{ \.\.\.result,[^}]*status: 409/);
    // 409 is declared as a problem+json response.
    expect(routes).toMatch(/409: \{ description: "Conflict"/);
  });

  it("falls back to the stdlib 500 for a user-declared error with no override", async () => {
    const files = await generateSystemFiles(SYS(""));
    const routes = [...files.entries()].find(([p]) => p.endsWith("order.routes.ts"))?.[1] ?? "";
    expect(routes).toMatch(/c\.json\(\{ \.\.\.result,[^}]*status: 500/);
  });
});
