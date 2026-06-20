// View `requires` gate on Hono (D-AUTH-OIDC / default-deny).  A
// `view X = Agg requires <expr> where <pred>` emits an in-handler 403 gate at
// the top of the GET /views/<x> route — the read-side analogue of an
// operation `requires` — evaluated against the request's currentUser before
// the query runs.  An ungated view emits no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function sys(viewClause: string): string {
  return `
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
    deployable api { platform: node  contexts: [Tickets]  serves: Api  dataSources: [st]  port: 3000  auth: required }
  }
`;
}

async function viewsFile(viewClause: string): Promise<string> {
  const files = (await generateSystems(await parseValid(sys(viewClause)))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/views.ts"));
  expect(path, "views.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono view requires gate", () => {
  it("emits a 403 ForbiddenError gate evaluated against currentUser", async () => {
    const vf = await viewsFile('requires currentUser.role == "agent" ');
    // currentUser read into scope, then the predicate guard before the query.
    expect(vf).toContain('.get("currentUser")');
    expect(vf).toContain(
      'if (!(currentUser.role === "agent")) throw new ForbiddenError("Forbidden");',
    );
    // The gate sits before the repository call.
    const gateIdx = vf.indexOf("throw new ForbiddenError");
    const queryIdx = vf.indexOf("await repo.openTickets(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated view", async () => {
    const vf = await viewsFile("");
    expect(vf).not.toContain("throw new ForbiddenError");
  });

  it("`requires true` emits an always-pass gate (intentionally public)", async () => {
    const vf = await viewsFile("requires true ");
    expect(vf).toContain("if (!(true)) throw new ForbiddenError");
  });
});
