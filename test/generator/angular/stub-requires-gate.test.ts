// Angular page `requires` guard on a parameterised-find page (D-AUTH-OIDC).  A
// gated page must render a `<Forbidden>` fallback when the currentUser-only gate
// fails — otherwise the page chrome leaks to an unauthorized user.  This page
// uses a parameterised find (`Support.Ticket.open("open")`), which the Angular
// generator now renders as a REAL body (the `use<Find><Agg>` factory landed),
// so the gate wraps the walked QueryView rather than the legacy stub.  Other
// walkable gated bodies are covered by page-requires-gate.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean }) => `
system Helpdesk {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish { subject: string  status: string }
      repository Tickets for Ticket { find open(status: string): Ticket[] }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp {
    api Support: SupportApi
    page AdminQ {
      route: "/admin/q"
      requires currentUser.role == "manager"
      body: QueryView { of: Support.Ticket.open("open"), data: rows => Heading { "rows" } }
    }
  }
  deployable web { platform: angular targets: api ui: WebApp { Support: api } port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

async function gatedPage(authUi: boolean): Promise<string> {
  const files = await generateSystemFiles(SYS({ authUi }));
  return files.get("web/src/app/pages/admin-q.component.ts")!;
}

describe("angular parameterised-find requires gate", () => {
  it("gates the walked body with @if/@else Forbidden + injects the session", async () => {
    const page = await gatedPage(true);
    // It is a REAL body now (the parameterised find is wired), not the stub.
    expect(page).not.toContain("stub — body needs api/forms support");
    expect(page).toContain('import { useOpenTicket } from "../../api/ticket";');
    expect(page).toContain('readonly ticketOpen = useOpenTicket(() => ({ status: "open" }));');
    // …gated by the currentUser-only `requires` predicate.
    expect(page).toContain('import { SessionService } from "../auth/session.service";');
    expect(page).toContain("readonly session = inject(SessionService);");
    expect(page).toContain('@if (currentUser.role === "manager") {');
    expect(page).toContain("<h2>Forbidden</h2>");
  });

  it("renders the ungated body (no session, no Forbidden) without auth: ui", async () => {
    const page = await gatedPage(false);
    expect(page).not.toContain("stub — body needs api/forms support");
    expect(page).toContain('readonly ticketOpen = useOpenTicket(() => ({ status: "open" }));');
    // No client-side gate without an `auth: ui` frontend.
    expect(page).not.toContain("SessionService");
    expect(page).not.toContain("Forbidden");
  });
});
