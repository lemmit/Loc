// Operation action-button gating on Angular (D-AUTH-OIDC, UI gate — action
// side; the Angular sibling of the React/Svelte/Vue gate).  On an `auth: ui`
// Angular frontend, an `Action(<instance>.<op>)` button whose operation's
// `requires` is currentUser-only is `@if`-hidden at runtime when the gate fails
// — the action-level mirror of the page guard, evaluated against the verified
// session user.  The page-shell injects `SessionService` + a `currentUser`
// accessor even when the page itself has no `requires`.  An op with no
// `requires` stays ungated; without `auth: ui` the output is byte-identical
// (no `@if`, no injected member).  The backend 403 stays authoritative.
//
// Angular has no user-component emitter, so the canonical Action host is a page
// body — here a `QueryView` byId data lambda whose record powers the
// instance-qualified `Action(order.confirm)` button.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYS = (opts: { authUi: boolean }) => `
system Shop {
  user { id: string role: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
  }
  subdomain Sales {
    context Orders {
      aggregate Order {
        status: string
        operation confirm() { requires currentUser.role == "manager"  status := "confirmed" }
        operation cancel() { status := "cancelled" }
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable api { platform: node contexts: [Orders] serves: SalesApi dataSources: [st] port: 8080 auth: required }
  ui WebApp {
    api Sales: SalesApi
    page OrderConsole {
      route: "/console/:id"
      body: QueryView {
        of: Sales.Order.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Order not found" },
        data: order => Toolbar { Action { order.confirm }, Action { order.cancel } }
      }
    }
  }
  deployable web { platform: angular targets: api ui: WebApp { Sales: api } port: 3004${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("angular operation action-button gate", () => {
  it("@if-hides a currentUser-gated button and injects the session", async () => {
    const c = find(
      await generateSystemFiles(SYS({ authUi: true })),
      "web/src/app/pages/order-console.component.ts",
    );
    // Session injected + currentUser accessor exposed (even though the page
    // itself carries no `requires`).
    expect(c).toContain('import { SessionService } from "../auth/session.service";');
    expect(c).toContain("readonly session = inject(SessionService);");
    expect(c).toContain(
      "get currentUser(): Record<string, unknown> { return this.session.user() ?? {}; }",
    );
    // confirm() gated — `@if`-wrapped, no `@else { null }` (Angular renders
    // bare `null` as visible text, so the hide drops the else).
    expect(c).toContain('@if ((currentUser.role === "manager")) {');
    expect(c).toContain(">Confirm</button>");
    // The gate wraps the confirm button, not the cancel one.
    const gateIdx = c.indexOf('@if ((currentUser.role === "manager"))');
    const confirmIdx = c.indexOf(">Confirm</button>");
    expect(gateIdx).toBeGreaterThan(0);
    expect(confirmIdx).toBeGreaterThan(gateIdx);
    // Exactly one currentUser gate, and no `@else { null }` leaked.
    expect(c.match(/@if \(\(currentUser/g)?.length ?? 0).toBe(1);
    expect(c).not.toContain("} @else {\n      null");
    // cancel() ungated — its button has no currentUser `@if` wrapper.
    expect(c).toContain(">Cancel</button>");
  });

  it("emits no gate / session binding without auth: ui (byte-identical)", async () => {
    const c = find(
      await generateSystemFiles(SYS({ authUi: false })),
      "web/src/app/pages/order-console.component.ts",
    );
    expect(c).not.toContain("SessionService");
    expect(c).not.toContain("currentUser");
    expect(c).not.toContain("@if ((currentUser");
    // Both buttons still render, just ungated.
    expect(c).toContain(">Confirm</button>");
    expect(c).toContain(">Cancel</button>");
  });
});
