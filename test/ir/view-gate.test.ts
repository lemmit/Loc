// View `requires` gate validation (D-AUTH-OIDC / default-deny).  A view-level
// `requires <expr>` runs before the query (no row exists yet), so it may only
// reference `currentUser` (+ constants), never the source row.  The validator
// (`loom.view-gate-not-current-user`) rejects row/field references with a
// message steering the author to `where` for row scoping.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function gateErrors(viewClause: string): Promise<string[]> {
  const src = `
system Sys {
  user { id: string role: string }
  subdomain S {
    context Tickets {
      aggregate Ticket { subject: string open: bool }
      repository Tickets for Ticket {}
      view OpenTickets = Ticket ${viewClause}where open == true
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api Api from S
  deployable api { platform: node contexts: [Tickets] serves: Api dataSources: [st] port: 8080 auth: required }
}
`;
  const { model } = await parseString(src, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.view-gate-not-current-user")
    .map((d) => d.message);
}

describe("view requires gate validation", () => {
  it("accepts a currentUser gate", async () => {
    expect(await gateErrors('requires currentUser.role == "agent" ')).toEqual([]);
  });

  it("accepts `requires true`", async () => {
    expect(await gateErrors("requires true ")).toEqual([]);
  });

  it("rejects a gate referencing the source row", async () => {
    const errs = await gateErrors("requires open == true ");
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("OpenTickets");
    expect(errs[0]).toContain("open");
    expect(errs[0]).toContain("currentUser");
  });

  it("no diagnostic for an ungated view (the gate is optional)", async () => {
    expect(await gateErrors("")).toEqual([]);
  });
});
