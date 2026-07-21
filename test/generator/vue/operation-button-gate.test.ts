// Operation action-button gating on Vue (D-AUTH-OIDC, UI gate — action side).
// On an `auth: ui` vue frontend, an `Action(<instance>.<op>)` button whose
// operation's `requires` is currentUser-only hides at runtime when the gate
// fails (`<template v-if>` around the button), evaluated against the verified
// session user.  A component is the canonical Action host.  Ops with no
// requires stay ungated — the backend 403 enforces.  The `v-if` is
// single-quoted so the condition's double-quoted string literals are valid.

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
  deployable web { platform: vue targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("vue operation action-button gate", () => {
  it("wraps a currentUser-gated button in a single-quoted v-if and binds the session user", async () => {
    const c = find(await generateSystemFiles(SYS({ authUi: true })), "OrderActions.vue");
    expect(c).toContain('import { useSession } from "../auth/useSession";');
    expect(c).toContain(
      "const currentUser = (useSession().user.value ?? {}) as Record<string, any>;",
    );
    // confirm() gated — single-quoted v-if so the inner `"manager"` is valid.
    expect(c).toContain(`<template v-if='(currentUser.role === "manager")'>`);
    expect(c).toContain(">Confirm</v-btn>");
    // cancel() ungated.
    expect(c).toContain(">Cancel</v-btn>");
    expect(c.match(/v-if='\(currentUser/g)?.length ?? 0).toBe(1);
    // The gate's else arm is the render-nothing sentinel — it must NOT emit a
    // `<template v-else>` (Vue would render the bare `null` token as literal
    // text to users who fail the gate).
    expect(c).not.toContain("v-else");
    expect(c).not.toMatch(/>\s*null\s*</);
  });

  it("emits no gate / binding without auth: ui (byte-identical)", async () => {
    const c = find(await generateSystemFiles(SYS({ authUi: false })), "OrderActions.vue");
    expect(c).not.toContain("useSession");
    expect(c).not.toContain("currentUser");
  });
});
