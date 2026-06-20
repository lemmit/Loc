// Page `requires` UI gate on Vue (D-AUTH-OIDC, UI gate).  A
// `page X { requires <expr> ... }` on a Vue frontend with `auth: ui` binds the
// verified session user in `<script setup>` and `v-if`-guards a `<Forbidden/>`
// fallback when the currentUser-only predicate fails — the client mirror of the
// backend 403.  Vue's `useSession().user` is a `Ref`, so the binding reads
// `.value`.  Without `auth: ui` (or without a gate) the page is byte-identical.

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
  deployable web { platform: vue targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("vue page requires gate", () => {
  it("binds the session user and v-if-guards a Forbidden fallback", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const page = find(files, "/pages/secret.vue");
    expect(page).toContain('import { useSession } from "../auth/useSession";');
    expect(page).toContain(
      "const currentUser = (useSession().user.value ?? {}) as Record<string, any>;",
    );
    expect(page).toContain('const loomPageAllowed = currentUser.role === "agent";');
    expect(page).toContain('<div v-if="!loomPageAllowed"');
    expect(page).toContain("<h2>Forbidden</h2>");
    expect(page).toContain("<template v-else>");
    // The guard opens before the body.
    const guardIdx = page.indexOf("Forbidden");
    const bodyIdx = page.indexOf("Top secret");
    expect(guardIdx).toBeGreaterThan(0);
    expect(bodyIdx).toBeGreaterThan(guardIdx);
  });

  it("emits no gate when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: false, gate: 'requires currentUser.role == "agent"\n      ' }),
    );
    const page = find(files, "/pages/secret.vue");
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("Forbidden");
  });

  it("emits no gate for an ungated page", async () => {
    const files = await generateSystemFiles(SYS({ authUi: true, gate: "" }));
    const page = find(files, "/pages/secret.vue");
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("Forbidden");
  });
});
