// Page `requires` UI gate on Angular (D-AUTH-OIDC, UI gate).  A
// `page X { requires <expr> ... }` on an Angular frontend with `auth: ui`
// injects the root SessionService, exposes the verified claims as a
// `currentUser` accessor, and wraps the body template in an
// `@if (<gate>) { … } @else { … }` rendering a Forbidden fallback when the
// currentUser-only predicate fails — the client mirror of the backend 403.
// Without `auth: ui` (or without a gate) the page is byte-identical to before
// (no injected service, no accessor, unwrapped template).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

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
  deployable web { platform: angular targets: api ui: WebApp port: 3004${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("angular page requires gate", () => {
  it("injects SessionService + currentUser accessor and wraps the body in @if/@else", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, gate: 'requires currentUser.role == "manager"\n      ' }),
    );
    const page = find(files, "web/src/app/pages/secret.component.ts");
    // Injects the root session service from the auth layer.
    expect(page).toContain('import { SessionService } from "../auth/session.service";');
    expect(page).toContain("readonly session = inject(SessionService);");
    // Exposes the verified claims the template reads as bare member refs.
    expect(page).toContain(
      "get currentUser(): Record<string, unknown> { return this.session.user() ?? {}; }",
    );
    // Template control-flow gate (bare `currentUser.role`, no `this.`).
    expect(page).toContain('@if (currentUser.role === "manager") {');
    expect(page).toContain("} @else {");
    expect(page).toContain("<h2>Forbidden</h2>");
    // The gate opens before the body markup.
    const gateIdx = page.indexOf("@if (currentUser.role");
    const bodyIdx = page.indexOf("Top secret");
    const elseIdx = page.indexOf("} @else {");
    expect(gateIdx).toBeGreaterThan(0);
    expect(bodyIdx).toBeGreaterThan(gateIdx);
    expect(elseIdx).toBeGreaterThan(bodyIdx);
  });

  it("emits no gate when the frontend has no auth: ui", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: false, gate: 'requires currentUser.role == "manager"\n      ' }),
    );
    const page = find(files, "web/src/app/pages/secret.component.ts");
    expect(page).not.toContain("SessionService");
    expect(page).not.toContain("currentUser");
    expect(page).not.toContain("@if");
    expect(page).not.toContain("Forbidden");
  });

  it("emits no gate for an ungated page", async () => {
    const files = await generateSystemFiles(SYS({ authUi: true, gate: "" }));
    const page = find(files, "web/src/app/pages/secret.component.ts");
    expect(page).not.toContain("SessionService");
    expect(page).not.toContain("currentUser");
    expect(page).not.toContain("@if");
    expect(page).not.toContain("Forbidden");
  });
});
