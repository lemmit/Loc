// Projection `requires` gate validation (D-AUTH-OIDC / default-deny) — the
// projection twin of the find gate.  A projection's `requires <expr>` runs
// before the read (no row is bound yet), so it may only reference `currentUser`
// (+ constants), never the source row.  One gate remains:
//   loom.projection-gate-not-current-user — a source-row / non-principal ref
//
// `loom.projection-gate-without-source` used to be the second, rejecting a gate
// on a FOLDED projection.  Its message claimed a folded projection had nothing
// to protect; it protects a table of rows served at `/projections/<p>`.  The
// real cause was that the keyword lived in the query-clause fragment, so a
// folded projection could not spell one — and no backend emitted one if it
// could.  Both are fixed, so the rejection is gone and the folded case is a
// SUPPORTED case, asserted below.

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

describe("projection requires gate validation", () => {
  it("accepts a currentUser gate", async () => {
    expect(
      await diags(
        `projection AdminOrders requires currentUser.role == "admin" { status: string  from Order as o select status = o.status }`,
      ),
    ).toEqual([]);
  });

  it("accepts `requires true`", async () => {
    expect(
      await diags(
        `projection PublicOrders requires true { status: string  from Order as o select status = o.status }`,
      ),
    ).toEqual([]);
  });

  it("loom.projection-gate-not-current-user — a gate referencing the source row", async () => {
    const errs = await diags(
      `projection P requires o.status == "open" { status: string  from Order as o select status = o.status }`,
    );
    expect(errs.map((e) => e.code)).toEqual(["loom.projection-gate-not-current-user"]);
    expect(errs[0]!.message).toContain("P");
    expect(errs[0]!.message).toContain("currentUser");
  });

  it("accepts a gate on a FOLDED projection (no `from`) — it guards the read model", async () => {
    expect(
      await diags(
        `projection Book keyed by order requires currentUser.role == "admin" { order: Order id  on(e: Placed) { order := e.order } }`,
      ),
    ).toEqual([]);
  });

  it("still rejects a source-row reference in a FOLDED projection's gate", async () => {
    // The currentUser-only rule is about WHEN the gate runs, not about which
    // projection kind declares it: on a folded projection the gate guards the
    // whole read model, so there is no row in scope to reference either.
    const errs = await diags(
      `projection Book2 keyed by order requires order == "x" { order: Order id  on(e: Placed) { order := e.order } }`,
    );
    expect(errs.map((e) => e.code)).toEqual(["loom.projection-gate-not-current-user"]);
  });

  it("no diagnostic for an ungated projection (the gate is optional)", async () => {
    expect(
      await diags(
        `projection LiveOrders { status: string  from Order as o where o.status == "open" select status = o.status }`,
      ),
    ).toEqual([]);
  });
});
