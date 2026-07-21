// Query-time projection `requires` gate validation (D-AUTH-OIDC / default-deny)
// — the projection twin of the find gate.  A projection's `requires <expr>` runs
// before the query (no row exists yet), so it may only reference `currentUser`
// (+ constants), never the source row.  Two gates:
//   loom.projection-gate-not-current-user — a source-row / non-principal ref
//   loom.projection-gate-without-source   — a gate on a projection with no `from`

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function diags(projBody: string): Promise<{ code: string; message: string }[]> {
  const src = `
system Sys {
  user { id: string role: string }
  subdomain S {
    context Sales {
      aggregate Order { status: string }
      repository Orders for Order { }
      event Placed { order: Order id }
      ${projBody}
    }
  }
  storage primary { type: postgres }
  resource st { for: Sales, kind: state, use: primary }
  api Api from S
  deployable api { platform: node contexts: [Sales] serves: Api dataSources: [st] port: 8080 auth: required }
}
`;
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code?.startsWith("loom.projection-gate"))
    .map((d) => ({ code: d.code!, message: d.message }));
}

describe("query-time projection requires gate validation", () => {
  it("accepts a currentUser gate", async () => {
    expect(
      await diags(
        `projection AdminOrders { status: string  from Order as o requires currentUser.role == "admin" select status = o.status }`,
      ),
    ).toEqual([]);
  });

  it("accepts `requires true`", async () => {
    expect(
      await diags(
        `projection PublicOrders { status: string  from Order as o requires true select status = o.status }`,
      ),
    ).toEqual([]);
  });

  it("loom.projection-gate-not-current-user — a gate referencing the source row", async () => {
    const errs = await diags(
      `projection P { status: string  from Order as o requires o.status == "open" select status = o.status }`,
    );
    expect(errs.map((e) => e.code)).toEqual(["loom.projection-gate-not-current-user"]);
    expect(errs[0]!.message).toContain("P");
    expect(errs[0]!.message).toContain("currentUser");
  });

  it("loom.projection-gate-without-source — a gate on a folded projection (no `from`)", async () => {
    const errs = await diags(
      `projection Book keyed by order { order: Order id  on(e: Placed) { order := e.order }  requires currentUser.role == "admin" }`,
    );
    expect(errs.map((e) => e.code)).toEqual(["loom.projection-gate-without-source"]);
    expect(errs[0]!.message).toContain("Book");
  });

  it("no diagnostic for an ungated projection (the gate is optional)", async () => {
    expect(
      await diags(
        `projection LiveOrders { status: string  from Order as o where o.status == "open" select status = o.status }`,
      ),
    ).toEqual([]);
  });
});
