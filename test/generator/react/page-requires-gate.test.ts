// Page `requires` UI gate on React (D-AUTH-OIDC, UI gate).  A
// `page X { requires <expr> ... }` on a frontend with `auth: ui` renders a
// client-side `<Forbidden/>` guard — the page binds the verified session user
// (`useSession().user`) and short-circuits to a Forbidden fallback when the
// currentUser-only predicate fails, the read-side mirror of the backend 403.
// Without `auth: ui` (or without a gate) the page is byte-identical to before.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean; gate: string }) => `
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
  }
  deployable web { platform: react targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("react page requires gate", () => {
  it("renders a Forbidden guard against the session user when auth: ui + requires", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const page = find(files, "web/src/pages/secret.tsx");
    // Imports useSession, binds the user, gates before the body return.
    expect(page).toContain('import { useSession } from "../auth/AuthGate";');
    expect(page).toContain("const currentUser = useSession().user as Record<string, any>;");
    expect(page).toContain('if (!(currentUser.role === "agent")) {');
    expect(page).toContain("<h2>Forbidden</h2>");
    // The guard sits before the body's main return.
    const guardIdx = page.indexOf("Forbidden");
    const bodyIdx = page.indexOf("Top secret");
    expect(guardIdx).toBeGreaterThan(0);
    expect(bodyIdx).toBeGreaterThan(guardIdx);
  });

  it("emits no gate when the frontend has no auth: ui (session not available)", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: false, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const page = find(files, "web/src/pages/secret.tsx");
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("Forbidden");
  });

  it("emits no gate for an ungated page", async () => {
    const files = await generateSystemFiles(SYS({ authUi: true, gate: "" }));
    const page = find(files, "web/src/pages/secret.tsx");
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("Forbidden");
  });
});
