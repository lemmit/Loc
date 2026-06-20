// View `requires` gate on Python/FastAPI (D-AUTH-OIDC / default-deny).  A
// `view X = Agg requires <expr> where <pred>` emits a 403 gate at the top of
// the `GET /views/<x>` route — the read-side analogue of an operation's
// `requires` — evaluated against the request's currentUser before the query.
// ForbiddenError maps to 403 via the app exception handler (the same path
// operations use).  An ungated view emits no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

function src(viewClause: string): string {
  return `system Acme {
    user { id: string  role: string }
    subdomain Sales { context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket { }
      view OpenTickets = Ticket ${viewClause}where open == true
    } }
    storage primary { type: postgres }
    resource st { for: Tickets, kind: state, use: primary }
    api Api from Sales
    deployable api { platform: python contexts: [Tickets] serves: Api dataSources: [st] port: 8080 auth: required }
  }`;
}

async function viewsFile(viewClause: string): Promise<string> {
  const { model, errors } = await parseString(src(viewClause));
  if (errors.length) throw new Error(errors.join("\n"));
  const files = generateSystems(model).files;
  const entry = [...files.entries()].find(([k]) => k.endsWith("/http/views_routes.py"));
  expect(entry, "views_routes.py not emitted").toBeDefined();
  return entry![1];
}

describe("python view requires gate", () => {
  it("emits a 403 ForbiddenError gate evaluated against currentUser before the query", async () => {
    const vf = await viewsFile('requires currentUser.role == "agent" ');
    expect(vf).toContain("from app.domain.errors import ForbiddenError");
    expect(vf).toContain("from app.auth.user import User");
    expect(vf).toContain("from fastapi import APIRouter, Depends, Request");
    // The route threads the principal and gates before the repo read.
    expect(vf).toContain(
      "async def open_tickets_view(request: Request, session: SessionDep) -> list[dict[str, object]]:",
    );
    expect(vf).toContain("    current_user: User = request.state.current_user");
    expect(vf).toContain('    if not (current_user.role == "agent"):');
    expect(vf).toContain('        raise ForbiddenError("Forbidden: view OpenTickets")');
    const gateIdx = vf.indexOf("raise ForbiddenError");
    const queryIdx = vf.indexOf("await repo.open_tickets()");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated view", async () => {
    const vf = await viewsFile("");
    expect(vf).not.toContain("ForbiddenError");
    expect(vf).not.toContain("request.state.current_user");
    expect(vf).toContain(
      "async def open_tickets_view(session: SessionDep) -> list[dict[str, object]]:",
    );
  });

  it("`requires true` emits an always-pass gate without threading the principal", async () => {
    const vf = await viewsFile("requires true ");
    expect(vf).toContain("from app.domain.errors import ForbiddenError");
    expect(vf).toContain('        raise ForbiddenError("Forbidden: view OpenTickets")');
    // Constant gate → no Request / User principal threaded.
    expect(vf).not.toContain("request.state.current_user");
    expect(vf).not.toContain("from app.auth.user import User");
    expect(vf).toContain(
      "async def open_tickets_view(session: SessionDep) -> list[dict[str, object]]:",
    );
  });
});
