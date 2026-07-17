// Find `requires` gate on Java/Spring (D-AUTH-OIDC / default-deny).  A
// `find f(): T[] requires <expr> where <pred>` emits a 403 gate at the top of
// the find's controller action — the read-side twin of the view gate —
// evaluated against the request's currentUser before delegating to the service.
// ForbiddenException maps to 403 via the controller advice.  Ungated → no gate.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

function src(findClause: string): string {
  return `system S { user { id: string  role: string } subdomain Sales { context Tickets {
    aggregate Ticket { subject: string  open: bool }
    repository Tickets for Ticket {
      find openOnes(): Ticket[] ${findClause}where open == true
    }
  } } api A from Sales storage pg { type: postgres }
  deployable api { platform: java contexts: [Tickets] serves: A port: 8080 auth: required } }`;
}

async function controller(findClause: string): Promise<string> {
  const { model, errors } = await parseString(src(findClause));
  if (errors.length) throw new Error(errors.join("\n"));
  const files = generateSystems(model).files;
  const entry = [...files.entries()].find(([k]) => k.endsWith("TicketsController.java"));
  expect(entry, "controller not emitted").toBeDefined();
  return entry![1];
}

describe("java find requires gate", () => {
  it("emits a ForbiddenException gate evaluated against currentUser before the service call", async () => {
    const ctrl = await controller('requires currentUser.role == "agent" ');
    expect(ctrl).toContain("import com.loom.api.domain.common.ForbiddenException;");
    expect(ctrl).toContain("import com.loom.api.auth.CurrentUserAccessor;");
    expect(ctrl).toContain("private final CurrentUserAccessor currentUserAccessor;");
    expect(ctrl).toContain("var currentUser = currentUserAccessor.user();");
    expect(ctrl).toContain(
      'if (!(Objects.equals(currentUser.role(), "agent"))) throw new ForbiddenException("Forbidden: find openOnes");',
    );
    const gateIdx = ctrl.indexOf("throw new ForbiddenException");
    const queryIdx = ctrl.indexOf("service.openOnes()");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate (and no accessor) for an ungated find", async () => {
    const ctrl = await controller("");
    expect(ctrl).not.toContain("ForbiddenException");
    expect(ctrl).not.toContain("CurrentUserAccessor");
  });

  it("`requires true` emits an always-pass gate without injecting the accessor", async () => {
    const ctrl = await controller("requires true ");
    expect(ctrl).toContain(
      'if (!(true)) throw new ForbiddenException("Forbidden: find openOnes");',
    );
    expect(ctrl).not.toContain("var currentUser = currentUserAccessor.user();");
  });
});
