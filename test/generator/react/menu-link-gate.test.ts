// Menu-link hiding for gated pages on React (D-AUTH-OIDC, UI gate — nav side).
//
// Builds on the page `requires` guard (#1376): a `page { requires <expr> }`
// already renders a `<Forbidden/>` body guard.  This test pins the nav-side
// mirror — when the deployable is `auth: ui` and a `menu { link <Page> }`
// targets a gated page, the App-shell sidebar wraps that page's nav link in
// `({gate}) ? <link> : null` so the link hides at runtime instead of dangling
// to a Forbidden page.  The App component binds the verified session user
// (`currentUser = useSession().user`) so the gate condition resolves.
//
// Without `auth: ui` (or without a gate) the sidebar stays byte-identical:
// no `useSession` import, no `currentUser` binding, no wrap.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean; gate: string; design?: string }) => `
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
  ui WebApp {
    page Secret {
      route: "/secret"
      ${opts.gate}body: Heading { "Top secret" }
    }
    page Public {
      route: "/public"
      body: Heading { "Hello" }
    }
    menu {
      section "Admin" {
        link Secret
        link Public
      }
    }
  }
  deployable web { platform: react targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""}${opts.design ? ` design: ${opts.design}` : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("react menu-link gate", () => {
  it("wraps a gated menu link in the rendered condition when auth: ui", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const app = find(files, "web/src/App.tsx");
    // The App shell binds the verified session user from useSession.
    expect(app).toContain('import { useSession } from "./auth/AuthGate";');
    expect(app).toContain("const currentUser = useSession().user as Record<string, any>;");
    // The gated link is wrapped so it hides when the gate fails (Mantine NavLink).
    expect(app).toContain('(currentUser.role === "agent") ? <NavLink');
    expect(app).toContain(": null}");
    // The ungated link (Public) is rendered unconditionally — no wrap.
    const publicIdx = app.indexOf('to="/public"');
    expect(publicIdx).toBeGreaterThan(0);
    // The unconditional Public NavLink isn't preceded by a ternary `?` on its line.
    const publicLine = app.slice(app.lastIndexOf("\n", publicIdx) + 1, publicIdx);
    expect(publicLine).not.toContain("?");
  });

  it("does not gate any link when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: false, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const app = find(files, "web/src/App.tsx");
    expect(app).not.toContain("useSession");
    expect(app).not.toContain("currentUser");
    // The gated page's link still renders, just unconditionally.
    expect(app).toContain('to="/secret"');
  });

  it("does not wrap an ungated linked page even under auth: ui", async () => {
    const files = await generateSystemFiles(SYS({ authUi: true, gate: "" }));
    const app = find(files, "web/src/App.tsx");
    // auth: ui still binds the session user (cheap, hook-stable) — but with no
    // gated page in the menu there is no ternary wrap.
    expect(app).toContain('to="/secret"');
    expect(app).not.toContain("? <NavLink");
    expect(app).not.toContain(": null}");
  });

  it("wraps the gated link under shadcn too (cross-pack)", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, gate: 'requires currentUser.role == "agent"\n      ', design: "shadcn" }),
    );
    const app = find(files, "web/src/App.tsx");
    expect(app).toContain('import { useSession } from "./auth/AuthGate";');
    expect(app).toContain("const currentUser = useSession().user as Record<string, any>;");
    // shadcn renders the nav entry as its own <NavLink> wrapper component.
    expect(app).toContain('(currentUser.role === "agent") ? <NavLink');
  });
});
