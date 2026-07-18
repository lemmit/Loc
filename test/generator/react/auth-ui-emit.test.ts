// React `auth: ui` guard emission (D-AUTH-OIDC, Phase 6).  When a react
// deployable opts in via `auth: ui` and its target backend is
// `auth: required`, the generator emits the pack-agnostic session client +
// route guard, wraps <App/> in <AuthGate>, and sends credentials.  A
// react deployable WITHOUT auth: ui stays byte-identical (no auth files).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const BASE = (authUi: boolean, design?: string) => `
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
  deployable web { platform: react targets: api ui: WebApp port: 3001${design ? ` design: ${design}` : ""}${authUi ? " auth: ui" : ""} }
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

describe("react auth: ui guard — emission", () => {
  it("emits the session client + guard and wraps the app", async () => {
    const files = await generateSystemFiles(BASE(true));
    expect(has(files, "web/src/auth/session.ts")).toBe(true);
    expect(has(files, "web/src/auth/AuthGate.tsx")).toBe(true);

    const session = find(files, "web/src/auth/session.ts");
    expect(session).toContain('api.get("/auth/me")');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source that interpolates the template literal in the generated code, not here
    expect(session).toContain("${API_BASE_URL}/auth/login");

    const main = find(files, "web/src/main.tsx");
    expect(main).toContain('import { AuthGate } from "./auth/AuthGate";');
    expect(main).toContain("<AuthGate>");
    expect(main).toContain("</AuthGate>");

    const client = find(files, "web/src/api/client.ts");
    expect(client).toContain('credentials: "include"');
    // Silent renewal: a 401 triggers one POST /auth/refresh + retry.
    expect(client).toContain('rawFetch("/auth/refresh", { method: "POST" })');
    expect(client).toContain("async function request(");
    expect(client).toContain("err.status === 401");
  });

  // Every React design pack must wrap <App/> in <AuthGate> (the wrap lives
  // in each pack's main.hbs; the guard files are pack-agnostic).
  it.each([
    "mantine",
    "shadcn",
    "mui",
    "chakra",
  ])("%s pack wraps <App/> in <AuthGate>", async (design) => {
    const files = await generateSystemFiles(BASE(true, design));
    const main = find(files, "web/src/main.tsx");
    expect(main).toContain('import { AuthGate } from "./auth/AuthGate";');
    expect(main).toContain("<AuthGate>");
    expect(main).toContain("</AuthGate>");
  });

  it("omits all auth wiring when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(BASE(false));
    expect(has(files, "web/src/auth/session.ts")).toBe(false);
    expect(has(files, "web/src/auth/AuthGate.tsx")).toBe(false);
    const main = find(files, "web/src/main.tsx");
    expect(main).not.toContain("AuthGate");
    const client = find(files, "web/src/api/client.ts");
    expect(client).not.toContain('credentials: "include"');
    // No silent-renewal machinery without auth: ui — api.* calls rawFetch directly.
    expect(client).not.toContain("/auth/refresh");
    expect(client).toContain("const request = rawFetch;");
  });
});
