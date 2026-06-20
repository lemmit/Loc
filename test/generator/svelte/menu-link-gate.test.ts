// Menu-link hiding on Svelte (D-AUTH-OIDC, UI gate — nav side).  When an
// `auth: ui` svelte frontend has a `menu { link <Page> }` targeting a page with
// a `requires` gate, the app-shell `{#if}`-hides that link at runtime when the
// gate fails — so a forbidden page's link doesn't dangle to its `<Forbidden/>`
// body guard.  The session user is bound only when a link is actually gated.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean; menu: boolean }) => `
system Helpdesk {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
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
  ui WebApp${opts.menu ? "" : " with scaffold(subdomains: [Support])"} {
    page Secret { route: "/secret" requires currentUser.role == "agent" body: Heading { "secret" } }
    page Public { route: "/public" body: Heading { "public" } }
    ${opts.menu ? 'menu { section "Main" { link Secret link Public } }' : ""}
  }
  deployable web { platform: svelte targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("svelte menu-link gate", () => {
  it("{#if}-wraps a gated link, binds the session user, leaves ungated links", async () => {
    const layout = find(
      await generateSystemFiles(SYS({ authUi: true, menu: true })),
      "(app)/+layout.svelte",
    );
    expect(layout).toContain('import { useSession } from "$lib/auth/AuthGate.svelte";');
    expect(layout).toContain("const currentUser = useSession().user as Record<string, any>;");
    // Secret (gated) is wrapped; Public (ungated) is not.
    expect(layout).toContain('{#if (currentUser.role === "agent")}');
    expect(layout).toContain('href="/secret"');
    expect(layout).toContain('href="/public"');
    expect(layout.match(/\{#if \(/g)?.length ?? 0).toBe(1);
  });

  it("binds no session user when no link is gated (default sidebar)", async () => {
    const layout = find(
      await generateSystemFiles(SYS({ authUi: true, menu: false })),
      "(app)/+layout.svelte",
    );
    expect(layout).not.toContain("useSession");
    expect(layout).not.toContain("{#if (");
  });

  it("emits no gating without auth: ui", async () => {
    const layout = find(
      await generateSystemFiles(SYS({ authUi: false, menu: true })),
      "(app)/+layout.svelte",
    );
    expect(layout).not.toContain("useSession");
    expect(layout).not.toContain("{#if (");
  });
});
