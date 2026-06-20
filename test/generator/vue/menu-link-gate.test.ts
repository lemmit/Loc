// Menu-link hiding on Vue (D-AUTH-OIDC, UI gate — nav side).  When an
// `auth: ui` vue frontend declares an explicit `menu { link <Page> }` targeting
// a page with a `requires` gate, the app-shell `v-if`-hides that link at runtime
// when the gate fails — so a forbidden page's link doesn't dangle to its
// `<Forbidden/>` body guard.  The session user is bound only when a link is
// actually gated (an unused `currentUser` would be a vue-tsc error).  An
// explicit `menu` also makes the sidebar honour the user's link list (today the
// scaffold-derived grouping is the only driver).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean; menu: boolean; external?: boolean }) => `
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
    ${
      opts.menu
        ? `menu { section "Main" { link Secret link Public${opts.external ? ' link "Docs" -> "https://x"' : ""} } }`
        : ""
    }
  }
  deployable web { platform: vue targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("vue menu-link gate", () => {
  it("v-if-wraps a gated link, binds the session user, leaves ungated links", async () => {
    // Default (no named layout) vue uis render the chrome straight into App.vue.
    const shell = find(await generateSystemFiles(SYS({ authUi: true, menu: true })), "/App.vue");
    expect(shell).toContain('import { useSession } from "./auth/useSession";');
    expect(shell).toContain(
      "const currentUser = (useSession().user.value ?? {}) as Record<string, any>;",
    );
    // Secret (gated) is wrapped in a single-quoted v-if; Public (ungated) is not.
    expect(shell).toContain(`v-if='(currentUser.role === "agent")'`);
    expect(shell).toContain('to="/secret"');
    expect(shell).toContain('to="/public"');
    // The Public link is NOT wrapped (no second v-if).
    expect(shell.match(/v-if='\(/g)?.length ?? 0).toBe(1);
    // currentUser is bound exactly once.
    expect(shell.match(/const currentUser = /g)?.length ?? 0).toBe(1);
  });

  it("binds no session user when no link is gated (scaffold default sidebar)", async () => {
    const shell = find(await generateSystemFiles(SYS({ authUi: true, menu: false })), "/App.vue");
    expect(shell).not.toContain("useSession");
    expect(shell).not.toContain("v-if='(");
  });

  it("emits no gating without auth: ui", async () => {
    const shell = find(await generateSystemFiles(SYS({ authUi: false, menu: true })), "/App.vue");
    expect(shell).not.toContain("useSession");
    expect(shell).not.toContain("v-if='(");
  });

  it("renders an external link as a target=_blank anchor and never gates it", async () => {
    const shell = find(
      await generateSystemFiles(SYS({ authUi: true, menu: true, external: true })),
      "/App.vue",
    );
    // External link → <v-list-item :href ... target="_blank"> (vuetify default
    // pack), not a router `to=` link, and outside any v-if gate.
    expect(shell).toContain(`:href="'https://x'"`);
    expect(shell).toContain('target="_blank"');
    expect(shell).toContain('rel="noreferrer"');
    // Still exactly one gated link (the Secret page); the external link is ungated.
    expect(shell.match(/v-if='\(/g)?.length ?? 0).toBe(1);
  });
});
