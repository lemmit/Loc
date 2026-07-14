// `loom.unmapped-error-status` warning (exception-less.md A1).
//
// A user-declared `error` returned by an operation that is neither a stdlib
// error (with a default status) nor given an api `httpStatus` mapping defaults
// to a 500 ProblemDetails — warn so the author maps it explicitly.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
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

const warnings = async (src: string): Promise<string[]> => {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.code === "loom.unmapped-error-status")
    .map((d) => d.message);
};

describe("unmapped-error-status warning", () => {
  it("warns when a user error has no stdlib default and no api mapping", async () => {
    const w = await warnings(SYS(""));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("OutOfStock");
    expect(w[0]).toContain("defaults to 500");
  });

  it("is silent once the api maps the error with httpStatus", async () => {
    expect(await warnings(SYS("{ httpStatus OutOfStock -> 409 }"))).toEqual([]);
  });

  it("is silent for a stdlib error (carries a default status)", async () => {
    const src = SYS("").replace("Order or OutOfStock", "Order or NotFound");
    // NotFound is a stdlib error → no warning even though it isn't mapped.
    expect((await warnings(src)).filter((m) => m.includes("NotFound"))).toEqual([]);
  });
});
