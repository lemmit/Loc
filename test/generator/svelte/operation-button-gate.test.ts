// Operation action-button gating on Svelte (D-AUTH-OIDC, UI gate — action side).
// On an `auth: ui` svelte frontend, an `Action(<instance>.<op>)` button whose
// operation's `requires` is currentUser-only hides at runtime when the gate
// fails (`{#if}` around the button), evaluated against the verified session
// user.  A component is the canonical Action host.  Ops with no requires (or
// requires touching `this`/params) stay ungated — the backend 403 enforces.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean }) => `
system Shop {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
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
  ui WebApp with scaffold(subdomains: [Sales]) {
    component OrderActions(order: Order) {
      body: Toolbar { Action { order.confirm }, Action { order.cancel } }
    }
  }
  deployable web { platform: svelte targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("svelte operation action-button gate", () => {
  it("wraps a currentUser-gated button in {#if}, binds the session user, leaves ungated buttons", async () => {
    const c = find(await generateSystemFiles(SYS({ authUi: true })), "OrderActions.svelte");
    expect(c).toContain('import { useSession } from "$lib/auth/AuthGate.svelte";');
    expect(c).toContain("const currentUser = useSession().user as Record<string, any>;");
    // confirm() has a currentUser-only `requires` → gated.
    expect(c).toContain('{#if (currentUser.role === "manager")}');
    expect(c).toContain("{/if}");
    expect(c).toContain(">Confirm</button>");
    // cancel() has no `requires` → its button is NOT inside an {#if}.
    expect(c).toContain(">Cancel</button>");
    expect(c.match(/\{#if /g)?.length ?? 0).toBe(1);
    // The gate's else arm is the render-nothing sentinel — it must NOT emit a
    // `{:else}` (Svelte would render the bare `null` token between `{:else}`
    // and `{/if}` as literal text to users who fail the gate).
    expect(c).not.toContain("{:else}");
    expect(c).not.toMatch(/\{:else\}\s*null/);
  });

  it("emits no gate / binding without auth: ui (byte-identical)", async () => {
    const c = find(await generateSystemFiles(SYS({ authUi: false })), "OrderActions.svelte");
    expect(c).not.toContain("useSession");
    expect(c).not.toContain("{#if ");
  });
});
