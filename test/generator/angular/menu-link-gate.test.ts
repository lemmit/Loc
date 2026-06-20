// Menu-link hiding on Angular (D-AUTH-OIDC, UI gate — nav side).  When an
// `auth: ui` Angular frontend has a sidebar nav link to a page carrying a
// currentUser-only `requires` gate, the app-shell `@if`-hides that link at
// runtime when the gate fails — the nav-side mirror of the page body guard
// (page-requires-gate).  The session user is injected only when a link is
// actually gated, so an `ng build` strict run sees no unused member.

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
    page Public {
      route: "/public"
      body: Heading { "public" }
    }
  }
  deployable web { platform: angular targets: api ui: WebApp port: 3004${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("angular menu-link gate", () => {
  it("injects SessionService + currentUser accessor and @if-wraps the gated nav link", async () => {
    const shell = find(
      await generateSystemFiles(
        SYS({ authUi: true, gate: 'requires currentUser.role == "manager"\n      ' }),
      ),
      "web/src/app/app.component.ts",
    );
    // The app shell injects the root session service + exposes a currentUser
    // accessor the template reads as bare member refs.
    expect(shell).toContain('import { Component, inject } from "@angular/core";');
    expect(shell).toContain('import { SessionService } from "./auth/session.service";');
    expect(shell).toContain("readonly session = inject(SessionService);");
    expect(shell).toContain(
      "get currentUser(): Record<string, unknown> { return this.session.user() ?? {}; }",
    );
    // Secret (gated) link is wrapped; Public (ungated) link is not.
    expect(shell).toContain('@if (currentUser.role === "manager") { <a mat-list-item');
    expect(shell).toContain('routerLink="/secret"');
    expect(shell).toContain('routerLink="/public"');
    // Exactly one nav link is gated.
    expect(shell.match(/@if \(/g)?.length ?? 0).toBe(1);
  });

  it("emits no gating when the frontend has no auth: ui", async () => {
    const shell = find(
      await generateSystemFiles(
        SYS({ authUi: false, gate: 'requires currentUser.role == "manager"\n      ' }),
      ),
      "web/src/app/app.component.ts",
    );
    expect(shell).not.toContain("SessionService");
    expect(shell).not.toContain("currentUser");
    expect(shell).not.toContain("@if");
    expect(shell).toContain('import { Component } from "@angular/core";');
  });

  it("emits no gating when no nav link is gated (no page requires)", async () => {
    const shell = find(
      await generateSystemFiles(SYS({ authUi: true, gate: "" })),
      "web/src/app/app.component.ts",
    );
    expect(shell).not.toContain("SessionService");
    expect(shell).not.toContain("currentUser");
    expect(shell).not.toContain("@if");
    expect(shell).toContain('import { Component } from "@angular/core";');
  });
});
