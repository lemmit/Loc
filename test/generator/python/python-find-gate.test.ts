// Find `requires` gate on Python/FastAPI (D-AUTH-OIDC / default-deny).  A
// `find f(): T[] requires <expr> where <pred>` emits a 403 gate at the top of
// the `GET /<plural>/<f>` route — the read-side twin of the view gate —
// evaluated against the request's currentUser before the query.  ForbiddenError
// maps to 403 via the app exception handler.  Ungated → no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

function src(findClause: string): string {
  return `system Acme {
    user { id: string  role: string }
    subdomain Sales { context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket {
        find openOnes(): Ticket[] ${findClause}where open == true
      }
    } }
    storage primary { type: postgres }
    resource st { for: Tickets, kind: state, use: primary }
    api Api from Sales
    deployable api { platform: python contexts: [Tickets] serves: Api dataSources: [st] port: 8080 auth: required }
  }`;
}

async function routesFile(findClause: string): Promise<string> {
  const { model, errors } = await parseString(src(findClause));
  if (errors.length) throw new Error(errors.join("\n"));
  const files = generateSystems(model).files;
  const entry = [...files.entries()].find(([k]) => k.endsWith("/http/ticket_routes.py"));
  expect(entry, "ticket_routes.py not emitted").toBeDefined();
  return entry![1];
}

describe("python find requires gate", () => {
  it("emits a 403 ForbiddenError gate evaluated against currentUser before the query", async () => {
    const rf = await routesFile('requires currentUser.role == "agent" ');
    expect(rf).toContain("from app.domain.errors import");
    expect(rf).toContain("from app.auth.user import User");
    expect(rf).toContain("    current_user: User = request.state.current_user");
    expect(rf).toContain('    if not (current_user.role == "agent"):');
    expect(rf).toContain('        raise ForbiddenError("Forbidden: find openOnes")');
    const gateIdx = rf.indexOf("raise ForbiddenError");
    const queryIdx = rf.indexOf("await repo.open_ones()");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated find", async () => {
    const rf = await routesFile("");
    expect(rf).not.toContain("ForbiddenError");
  });

  it("`requires true` emits an always-pass gate without threading the principal", async () => {
    const rf = await routesFile("requires true ");
    expect(rf).toContain("    if not (True):");
    expect(rf).toContain('        raise ForbiddenError("Forbidden: find openOnes")');
  });
});
