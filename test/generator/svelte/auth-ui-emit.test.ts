// Svelte `auth: ui` guard emission (D-AUTH-OIDC).  When a svelte deployable
// opts in via `auth: ui` and its target backend is `auth: required`, the
// generator emits the framework-neutral session client + the runes-based
// route guard, wraps the app in <AuthGate> (in the root +layout), and sends
// credentials.  A svelte deployable WITHOUT auth: ui stays byte-identical
// (no auth files, no <AuthGate>, no credentials).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const BASE = (authUi: boolean, design?: string) => `
system Helpdesk {
  user { id: string role: string email: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
    claims: { role: "realm_access.roles" }
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
  deployable web { platform: svelte targets: api ui: WebApp port: 3001${design ? ` design: ${design}` : ""}${authUi ? " auth: ui" : ""} }
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

describe("svelte auth: ui guard — emission", () => {
  it("emits the session client + guard, wraps the app, and sends credentials", async () => {
    const files = await generateSystemFiles(BASE(true));
    expect(has(files, "web/src/lib/auth/session.ts")).toBe(true);
    expect(has(files, "web/src/lib/auth/AuthGate.svelte")).toBe(true);

    const session = find(files, "web/src/lib/auth/session.ts");
    expect(session).toContain('api.get("/auth/me")');
    expect(session).toContain("${API_BASE_URL}/auth/login");

    const gate = find(files, "web/src/lib/auth/AuthGate.svelte");
    expect(gate).toContain("fetchSession");
    expect(gate).toContain("onclick={signIn}");
    expect(gate).toContain("{@render children()}");

    const layout = find(files, "web/src/routes/+layout.svelte");
    expect(layout).toContain('import AuthGate from "$lib/auth/AuthGate.svelte";');
    expect(layout).toContain("<AuthGate>");
    expect(layout).toContain("</AuthGate>");

    const client = find(files, "web/src/lib/api/client.ts");
    expect(client).toContain('credentials: "include"');
  });

  // Both svelte design packs wrap the app in <AuthGate> (the wrap lives in
  // the shared sveltekit/root-layout layer; the guard files are pack-agnostic).
  it.each([
    "shadcnSvelte@v1",
    "flowbite@v1",
  ])("%s pack wraps the app in <AuthGate>", async (design) => {
    const files = await generateSystemFiles(BASE(true, `"${design}"`));
    const layout = find(files, "web/src/routes/+layout.svelte");
    expect(layout).toContain('import AuthGate from "$lib/auth/AuthGate.svelte";');
    expect(layout).toContain("<AuthGate>");
    expect(layout).toContain("</AuthGate>");
    expect(has(files, "web/src/lib/auth/AuthGate.svelte")).toBe(true);
  });

  it("omits all auth wiring when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(BASE(false));
    expect(has(files, "web/src/lib/auth/session.ts")).toBe(false);
    expect(has(files, "web/src/lib/auth/AuthGate.svelte")).toBe(false);
    const layout = find(files, "web/src/routes/+layout.svelte");
    expect(layout).not.toContain("AuthGate");
    const client = find(files, "web/src/lib/api/client.ts");
    expect(client).not.toContain('credentials: "include"');
  });
});
