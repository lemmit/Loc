// Angular page `requires` guard on the STUB path (D-AUTH-OIDC).  A gated page
// whose body needs deferred features (here a parameterised find → the
// `renderAngularPageStub` placeholder) must still render a `<Forbidden>`
// fallback when the currentUser-only gate fails — otherwise the stub chrome
// leaks to an unauthorized user.  Walkable gated bodies are covered by
// page-requires-gate.test.ts; this covers the stub branch.

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

async function stubPage(authUi: boolean): Promise<string> {
  const files = await generateSystemFiles(SYS({ authUi }));
  return files.get("web/src/app/pages/admin-q.component.ts")!;
}

describe("angular stub-path requires gate", () => {
  it("gates the stub with @if/@else Forbidden + injects the session", async () => {
    const page = await stubPage(true);
    // It IS the stub (body uses a parameterised find — deferred feature).
    expect(page).toContain("stub — body needs api/forms support");
    expect(page).toContain('import { SessionService } from "../auth/session.service";');
    expect(page).toContain("readonly session = inject(SessionService);");
    expect(page).toContain('@if (currentUser.role === "manager") {');
    expect(page).toContain("<h2>Forbidden</h2>");
  });

  it("leaves the stub byte-identical without auth: ui", async () => {
    const page = await stubPage(false);
    expect(page).toContain("stub — body needs api/forms support");
    expect(page).not.toContain("SessionService");
    expect(page).not.toContain("@if (");
    expect(page).not.toContain("Forbidden");
  });
});
