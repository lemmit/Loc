// `denyByDefault` vs the projections a MACRO emits.
//
// #2523 closed the last read surface default-deny walked past: an ungated
// projection is a GET endpoint publishing its rows, so under `denyByDefault` it
// must carry a `requires`.  Right rule — but it was applied to every projection
// in the context, including the singleton totals `scaffoldDashboard` emits per
// aggregate.  Those have no declaration header in the `.ddd` at all, so the
// diagnostic ("Add a `requires <expr>` after its declaration header") named a
// line the author cannot open, and `scaffold` + `denyByDefault` became an
// uncompilable combination.
//
// The exemption already exists one loop up and for the same reason: the
// enrichment-injected `find all` is skipped because it "is compiler-synthesized
// and has no author source line" (`src/ir/util/read-gates.ts`).  A macro-emitted
// projection is the same case, and it is DERIVED — `ProjectionIR.origin` already
// carries the macro provenance, so nothing new is stamped.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const SYSTEM = (extra = ""): string => `
system Shop {
  user { role: string }
  subdomain Sales {
    context Orders with scaffoldDashboard {
      aggregate Order {
        code: string
        total: money
      }
      repository Orders for Order {
        find all(): Order[] requires currentUser.role == "clerk"
      }${extra}
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  auth { oidc { issuer: "https://issuer.example", clientId: "web", enforcement: denyByDefault } }
  deployable d {
    platform: node
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

async function denyDiags(src: string): Promise<string[]> {
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.default-deny-ungated")
    .map((d) => d.source ?? "")
    .filter((s) => s.startsWith("projection/"));
}

describe("denyByDefault — macro-emitted projections", () => {
  it("does not demand a gate on a projection the scaffold emitted", async () => {
    // `scaffoldDashboard` emits `OrderTotals` (and `OrderPerDay` when the
    // aggregate has a datetime).  Neither has a header to gate.
    expect(await denyDiags(SYSTEM())).toEqual([]);
  });

  it("still demands one on an author-declared projection", async () => {
    // The rule itself is untouched — only the no-source-line case is exempt.
    const diags = await denyDiags(
      SYSTEM(`
      projection OpenOrders {
        code: string
        from Order as o
        select code = o.code
      }`),
    );
    expect(diags).toEqual(["projection/OpenOrders"]);
  });
});
