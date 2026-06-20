// View `requires` gate on Java/Spring (D-AUTH-OIDC / default-deny).  A
// `view X = Agg requires <expr> where <pred>` emits a 403 gate at the top of
// the view's service method — the read-side analogue of an operation's
// `requires` — evaluated against the request's currentUser before the read.
// ForbiddenException maps to 403 via the controller advice (the same path
// operations use).  An ungated view emits no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

function src(viewClause: string): string {
  return `system S { user { id: string  role: string } subdomain Sales { context Tickets {
    aggregate Ticket { subject: string  open: bool }
    repository Tickets for Ticket { }
    view OpenTickets = Ticket ${viewClause}where open == true
  } } api A from Sales storage pg { type: postgres }
  deployable api { platform: java contexts: [Tickets] serves: A port: 8080 auth: required } }`;
}

async function service(viewClause: string): Promise<string> {
  const { model, errors } = await parseString(src(viewClause));
  if (errors.length) throw new Error(errors.join("\n"));
  const files = generateSystems(model).files;
  const entry = [...files.entries()].find(([k]) => k.endsWith("TicketsViews.java"));
  expect(entry, "views service not emitted").toBeDefined();
  return entry![1];
}

describe("java view requires gate", () => {
  it("emits a ForbiddenException gate evaluated against currentUser before the read", async () => {
    const svc = await service('requires currentUser.role == "agent" ');
    expect(svc).toContain("import com.loom.api.domain.common.ForbiddenException;");
    expect(svc).toContain("import com.loom.api.auth.CurrentUserAccessor;");
    expect(svc).toContain("private final CurrentUserAccessor currentUserAccessor;");
    expect(svc).toContain("var currentUser = currentUserAccessor.user();");
    expect(svc).toContain(
      'if (!(Objects.equals(currentUser.role(), "agent"))) throw new ForbiddenException("Forbidden: view OpenTickets");',
    );
    // Gate sits before the repository stream.
    const gateIdx = svc.indexOf("throw new ForbiddenException");
    const queryIdx = svc.indexOf("ticketsRepository.openTickets()");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate (and no accessor) for an ungated view", async () => {
    const svc = await service("");
    expect(svc).not.toContain("ForbiddenException");
    expect(svc).not.toContain("CurrentUserAccessor");
    expect(svc).not.toContain("currentUserAccessor.user()");
  });

  it("`requires true` emits an always-pass gate without injecting the accessor", async () => {
    const svc = await service("requires true ");
    expect(svc).toContain(
      'if (!(true)) throw new ForbiddenException("Forbidden: view OpenTickets");',
    );
    // Constant gate → no currentUser local, no accessor field (would be unused).
    expect(svc).not.toContain("var currentUser = currentUserAccessor.user();");
    expect(svc).not.toContain("CurrentUserAccessor currentUserAccessor");
  });
});
