// Vue `auth: ui` guard emission (D-AUTH-OIDC, Phase 6).  When a vue
// deployable opts in via `auth: ui` and its target backend is
// `auth: required`, the generator emits the pack-agnostic session client +
// provide/inject route guard, wraps <App /> in <AuthGate>, and sends
// credentials.  A vue deployable WITHOUT auth: ui stays byte-identical (no
// auth files).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

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
  deployable web { platform: vue targets: api ui: WebApp port: 3003${design ? ` design: "${design}"` : ""}${authUi ? " auth: ui" : ""} }
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

describe("vue auth: ui guard — emission", () => {
  it("emits the session client + guard and wraps the app", async () => {
    const files = await generateSystemFiles(BASE(true));
    expect(has(files, "web/src/auth/session.ts")).toBe(true);
    expect(has(files, "web/src/auth/useSession.ts")).toBe(true);
    expect(has(files, "web/src/auth/AuthGate.vue")).toBe(true);

    const session = find(files, "web/src/auth/session.ts");
    expect(session).toContain('api.get("/auth/me")');
    expect(session).toContain("${API_BASE_URL}/auth/login");

    const gate = find(files, "web/src/auth/AuthGate.vue");
    expect(gate).toContain('import { provideSession } from "./useSession";');
    expect(gate).toContain('@click="signIn"');

    const main = find(files, "web/src/main.ts");
    expect(main).toContain('import AuthGate from "./auth/AuthGate.vue";');
    expect(main).toContain("h(AuthGate, null, { default: () => h(App) })");
    expect(main).toContain("createApp(Root)");

    const client = find(files, "web/src/api/client.ts");
    expect(client).toContain('credentials: "include"');
  });

  // Every Vue design pack must wrap <App /> in <AuthGate> (the wrap lives
  // in each pack's main.hbs; the guard files are pack-agnostic).
  it.each(["vuetify@v3", "shadcnVue@v1"])("%s pack wraps <App /> in <AuthGate>", async (design) => {
    const files = await generateSystemFiles(BASE(true, design));
    const main = find(files, "web/src/main.ts");
    expect(main).toContain('import AuthGate from "./auth/AuthGate.vue";');
    expect(main).toContain("h(AuthGate, null, { default: () => h(App) })");
    expect(has(files, "web/src/auth/AuthGate.vue")).toBe(true);
  });

  it("omits all auth wiring when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(BASE(false));
    expect(has(files, "web/src/auth/session.ts")).toBe(false);
    expect(has(files, "web/src/auth/useSession.ts")).toBe(false);
    expect(has(files, "web/src/auth/AuthGate.vue")).toBe(false);
    const main = find(files, "web/src/main.ts");
    expect(main).not.toContain("AuthGate");
    const client = find(files, "web/src/api/client.ts");
    expect(client).not.toContain('credentials: "include"');
  });
});
