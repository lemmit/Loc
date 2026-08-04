// `scaffoldDashboard` must survive its own aggregation gate.
//
// Regression for a MAIN-BREAKING defect: `loom.projection-aggregate-arg-not-
// columnar` (added with the grouped read model, M-T4.2) required an
// aggregation argument to be a member access rooted at `this`.  A PARSED
// `sum(o.total)` lowers to exactly that — but a MACRO-BUILT one does not, so
// the gate rejected `scaffoldDashboard`'s own emitted projection and EVERY
// `with scaffoldDashboard` context stopped generating (`ddd generate system`
// exited non-zero).  The macro's output was fine all along; the emitters
// render it correctly — verified against the pre-gate commit, which emitted
// `sum(schema.orders.total)`.
//
// The gate now tests `member`, matching what every backend's `aggregateColumn`
// can actually emit (it reads `.member` alone).
//
// This asserts on the IR VALIDATOR rather than on generated files: the
// emitters were never the problem, and a generate-only check passes even with
// the bug (the toolkit helper does not run phase ⑦).  The macro's AST-level
// tests stayed green throughout too — which is exactly why this defect reached
// `main`.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `system Shop {
  subdomain Sales {
    context Orders with scaffoldDashboard {
      aggregate Order { code: string  total: money  lineCount: int }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource oState { for: Orders, kind: state, use: pg }
  deployable api { platform: node contexts: [Orders] dataSources: [oState] serves: SalesApi port: 8080 }
}`;

async function analyse() {
  const { model } = await parseString(SRC, { validate: false });
  const loom = enrichLoomModel(lowerModel(model));
  return { loom, diags: validateLoomModel(loom) };
}

describe("scaffoldDashboard survives the aggregation gate", () => {
  it("actually expands — the macro emitted its totals projection", async () => {
    // Guards the test itself: if the macro stopped expanding in this harness
    // the diagnostic assertion below would pass vacuously.
    const { loom } = await analyse();
    const ctx = allContexts(loom).find((c) => c.name === "Orders");
    expect(ctx?.projections.map((p) => p.name)).toContain("OrderTotals");
  });

  it("raises no aggregate-arg diagnostic on its own emitted sums", async () => {
    const { diags } = await analyse();
    const offenders = diags.filter((d) => d.code === "loom.projection-aggregate-arg-not-columnar");
    expect(offenders.map((d) => d.message)).toEqual([]);
  });
});
