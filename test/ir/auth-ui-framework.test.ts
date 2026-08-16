// `auth: ui` framework gate (Phase 6).  The frontend OIDC guard is emitted
// by the React, Vue, Svelte, Angular and Feliz generators, so a deployable
// whose resolved UI framework is none of those (phoenixLiveView) is rejected
// at the IR level rather than silently emitting no guard.
//
// Feliz is the case the gate got WRONG for a while: `generator/feliz/
// auth-gate.ts` ships the Elmish session model + `AuthGate` view (CI drives it
// through the `authgate` scenario in `generated-feliz-build.yml`), yet the Set
// excluded it.  A bare `platform: feliz` only slipped through because lowering
// resolved its `uiFramework` to the react default — so the gate was measuring
// feliz against react's capabilities, and an explicit `framework: feliz` ui was
// falsely REJECTED.  Both halves are pinned below.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function authUiErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.auth-ui-unsupported-framework")
    .map((d) => d.message);
}

function sys(frontendPlatform: string): string {
  return `
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
  ui WebApp with scaffold(subdomains: [Support]) { }
  deployable web { platform: ${frontendPlatform} targets: api ui: WebApp port: 3001 auth: ui }
}
`;
}

/** Same system, but the ui states its own `framework:` (D-PHOENIX-SURFACE) —
 *  the spelling that reaches the gate WITHOUT going through the platform
 *  default, so it isolates the Set from the lowering fallback. */
function sysWithDeclaredFramework(framework: string): string {
  return sys(framework).replace(
    "ui WebApp with scaffold(subdomains: [Support]) { }",
    `ui WebApp with scaffold(subdomains: [Support]) { framework: ${framework} }`,
  );
}

describe("auth: ui framework gate", () => {
  it("allows auth: ui on a react frontend", async () => {
    expect(await authUiErrors(sys("react"))).toEqual([]);
  });

  it("allows auth: ui on a vue frontend", async () => {
    expect(await authUiErrors(sys("vue"))).toEqual([]);
  });

  it("allows auth: ui on a svelte frontend", async () => {
    expect(await authUiErrors(sys("svelte"))).toEqual([]);
  });

  it("allows auth: ui on an angular frontend", async () => {
    expect(await authUiErrors(sys("angular"))).toEqual([]);
  });

  it("allows auth: ui on a feliz frontend", async () => {
    expect(await authUiErrors(sys("feliz"))).toEqual([]);
  });

  // The explicit-`framework:` spelling — the one the stale gate rejected even
  // though the Feliz auth-gate emitter has shipped all along.
  it("allows auth: ui on a ui that declares framework: feliz", async () => {
    expect(await authUiErrors(sysWithDeclaredFramework("feliz"))).toEqual([]);
  });

  it("rejects auth: ui on an unsupported (phoenixLiveView) frontend", async () => {
    const errs = await authUiErrors(sys("elixir"));
    expect(errs.length).toBe(1);
    // The list is rendered FROM the gate's own Set, so it can't advertise a
    // stale roster after a port widens it.
    expect(errs[0]).toContain("only supported on react, vue, svelte, angular, feliz");
  });
});
