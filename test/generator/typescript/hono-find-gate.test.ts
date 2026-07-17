// Find `requires` gate on Hono (D-AUTH-OIDC / default-deny).  A
// `find f(): T[] requires <expr> where <pred>` on a repository emits an
// in-handler 403 gate at the top of the GET /<plural>/<f> route — the read-side
// twin of the view gate — evaluated against the request's currentUser before
// the query runs.  An ungated find emits no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

function sys(findClause: string): string {
  return `
  system Sys {
    user { id: string role: string }
    subdomain S {
      context Tickets {
        aggregate Ticket { subject: string open: bool }
        repository Tickets for Ticket {
          find openOnes(): Ticket[] ${findClause}where open == true
        }
      }
    }
    storage primary { type: postgres }
    resource st { for: Tickets, kind: state, use: primary }
    api Api from S
    deployable api { platform: node  contexts: [Tickets]  serves: Api  dataSources: [st]  port: 3000  auth: required }
  }
`;
}

async function routesFile(findClause: string): Promise<string> {
  const files = (await generateSystems(await parseValid(sys(findClause)))).files;
  const path = [...files.keys()].find((k) => k.endsWith("ticket.routes.ts"));
  expect(path, "ticket.routes.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono find requires gate", () => {
  it("emits a 403 ForbiddenError gate evaluated against currentUser, before the query", async () => {
    const rf = await routesFile('requires currentUser.role == "agent" ');
    expect(rf).toContain('.get("currentUser")');
    expect(rf).toContain(
      'if (!(currentUser.role === "agent")) throw new ForbiddenError("Forbidden");',
    );
    const gateIdx = rf.indexOf("throw new ForbiddenError");
    const queryIdx = rf.indexOf("await repo.openOnes(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated find", async () => {
    const rf = await routesFile("");
    expect(rf).not.toContain("throw new ForbiddenError");
  });

  it("`requires true` emits an always-pass gate without reading currentUser", async () => {
    const rf = await routesFile("requires true ");
    expect(rf).toContain("if (!(true)) throw new ForbiddenError");
  });
});
