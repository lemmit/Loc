// View `requires` gate on Phoenix (D-AUTH-OIDC / default-deny).  A
// `view X = Agg requires <expr> where <pred>` emits a 403 gate at the top of
// the view's controller action — the read-side analogue of an operation's
// `requires` — evaluated against `conn.assigns.current_user` before the query.
// A failure returns an RFC-7807 403 ProblemDetails; an ungated view emits no
// gate.  (`platform: elixir` is plain Phoenix LiveView on Ecto — the Ash
// foundation was removed.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function system(viewClause: string): string {
  return `
system Acme {
  user { id: string  role: string }
  subdomain Sales {
    context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket { }
      view OpenTickets = Ticket ${viewClause}where open == true
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Tickets, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Tickets]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
    auth: required
  }
}
`;
}

async function controller(viewClause: string): Promise<string> {
  const files = await generateSystemFiles(system(viewClause));
  const ctrl = files.get("api/lib/api_web/controllers/views_controller.ex");
  expect(ctrl, "views controller not emitted").toBeDefined();
  return ctrl!;
}

describe("phoenix — view requires gate", () => {
  it("emits a 403 ProblemDetails gate evaluated against current_user before the query", async () => {
    const ctrl = await controller('requires currentUser.role == "agent" ');
    expect(ctrl).toContain('if not (current_user.role == "agent") do');
    expect(ctrl).toContain(
      'ApiWeb.ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: view OpenTickets")',
    );
    // The gate sits before the view module's run/1.
    const gateIdx = ctrl.indexOf("problem_response(conn, 403");
    const runIdx = ctrl.indexOf("Views.OpenTickets.run(current_user)");
    expect(gateIdx).toBeGreaterThan(0);
    expect(runIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated view", async () => {
    const ctrl = await controller("");
    expect(ctrl).not.toContain("problem_response(conn, 403");
    expect(ctrl).not.toContain("if not (");
  });

  it("`requires true` emits an always-pass gate", async () => {
    const ctrl = await controller("requires true ");
    expect(ctrl).toContain("if not (true) do");
    expect(ctrl).toContain(
      'ApiWeb.ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: view OpenTickets")',
    );
  });
});
