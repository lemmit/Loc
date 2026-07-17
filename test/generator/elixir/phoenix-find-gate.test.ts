// Find `requires` gate on Phoenix (D-AUTH-OIDC / default-deny).  A
// `find f(): T[] requires <expr> where <pred>` emits a 403 gate at the top of
// the find's controller action — the read-side twin of the view gate —
// evaluated against `conn.assigns.current_user` before the query.  A failure
// returns an RFC-7807 403 ProblemDetails; an ungated find emits no gate.
// (`platform: elixir` is plain Phoenix LiveView on Ecto.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

function system(findClause: string): string {
  return `
system Acme {
  user { id: string  role: string }
  subdomain Sales {
    context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket {
        find openOnes(): Ticket[] ${findClause}where open == true
      }
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

async function controller(findClause: string): Promise<string> {
  const files = await generateSystemFiles(system(findClause));
  const ctrl = files.get("api/lib/api_web/controllers/ticket_controller.ex");
  expect(ctrl, "ticket controller not emitted").toBeDefined();
  return ctrl!;
}

describe("phoenix — find requires gate", () => {
  it("emits a 403 ProblemDetails gate evaluated against current_user before the query", async () => {
    const ctrl = await controller('requires currentUser.role == "agent" ');
    expect(ctrl).toContain("current_user = Map.get(conn.assigns, :current_user)");
    expect(ctrl).toContain('if not (current_user.role == "agent") do');
    expect(ctrl).toContain(
      'ApiWeb.ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: find openOnes")',
    );
    const gateIdx = ctrl.indexOf("problem_response(conn, 403");
    const queryIdx = ctrl.indexOf("Tickets.open_ones_ticket(");
    expect(gateIdx).toBeGreaterThan(0);
    expect(queryIdx).toBeGreaterThan(gateIdx);
  });

  it("emits no gate for an ungated find", async () => {
    const ctrl = await controller("");
    expect(ctrl).not.toContain("problem_response(conn, 403");
  });

  it("`requires true` emits an always-pass gate", async () => {
    const ctrl = await controller("requires true ");
    expect(ctrl).toContain("if not (true) do");
    expect(ctrl).toContain(
      'ApiWeb.ProblemDetails.problem_response(conn, 403, "Forbidden", "Forbidden: find openOnes")',
    );
  });
});
