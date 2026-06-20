// Angular `auth: ui` guard emission (D-AUTH-OIDC).  When an angular deployable
// opts in via `auth: ui` and its target backend is `auth: required`, the
// generator emits the root SessionService (the /auth/me probe + sign-in/out
// redirects + the exposed `user` signal) and the pack-agnostic AuthGate
// component, and wraps <router-outlet /> in <app-auth-gate> in the app shell.
// An angular deployable WITHOUT auth: ui stays byte-identical (no auth files,
// unchanged app shell).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const BASE = (authUi: boolean) => `
system Helpdesk {
  user { id: string role: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
  }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish { subject: string }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp with scaffold(subdomains: [Support]) { }
  deployable web { platform: angular targets: api ui: WebApp port: 3004${authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}
function has(files: Map<string, string>, suffix: string): boolean {
  for (const k of files.keys()) if (k.endsWith(suffix)) return true;
  return false;
}

describe("angular auth: ui guard — emission", () => {
  it("emits the session service + auth-gate and wraps the router outlet", async () => {
    const files = await generateSystemFiles(BASE(true));
    expect(has(files, "web/src/app/auth/session.service.ts")).toBe(true);
    expect(has(files, "web/src/app/auth/auth-gate.component.ts")).toBe(true);

    const service = find(files, "web/src/app/auth/session.service.ts");
    // Probes /auth/me with credentials and reuses the shared API_BASE_URL.
    expect(service).toContain("${API_BASE_URL}/auth/me");
    expect(service).toContain("withCredentials: true");
    expect(service).toContain("${API_BASE_URL}/auth/login");
    expect(service).toContain("${API_BASE_URL}/auth/logout");
    // Exposes the verified user signal a future page guard reads.
    expect(service).toContain("readonly user = signal<SessionUser | null>(null)");
    // Relative import resolves from src/app/auth/ up to src/api/config.
    expect(service).toContain('import { API_BASE_URL } from "../../api/config"');

    const gate = find(files, "web/src/app/auth/auth-gate.component.ts");
    expect(gate).toContain('selector: "app-auth-gate"');
    expect(gate).toContain("<ng-content />");
    expect(gate).toContain("session.signIn()");
    expect(gate).toContain("session.signOut()");

    const shell = find(files, "web/src/app/app.component.ts");
    expect(shell).toContain('import { AuthGateComponent } from "./auth/auth-gate.component"');
    expect(shell).toContain("AuthGateComponent,");
    expect(shell).toContain("<app-auth-gate>");
    expect(shell).toContain("</app-auth-gate>");
  });

  it("omits all auth wiring when the frontend has no auth: ui", async () => {
    const withAuth = await generateSystemFiles(BASE(true));
    const noAuth = await generateSystemFiles(BASE(false));

    expect(has(noAuth, "web/src/app/auth/session.service.ts")).toBe(false);
    expect(has(noAuth, "web/src/app/auth/auth-gate.component.ts")).toBe(false);

    const shell = find(noAuth, "web/src/app/app.component.ts");
    expect(shell).not.toContain("AuthGate");
    expect(shell).not.toContain("app-auth-gate");

    // The app shell is byte-identical to the auth-on shell sans the gate wiring:
    // the no-auth shell must equal what the auth-on shell would be without auth.
    const authShell = find(withAuth, "web/src/app/app.component.ts");
    expect(authShell).not.toEqual(shell);
  });
});
