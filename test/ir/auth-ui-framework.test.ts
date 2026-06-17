// `auth: ui` framework gate (Phase 6).  The frontend OIDC guard is emitted
// by the React and Vue generators, so a deployable whose resolved UI
// framework is neither (svelte) is rejected at the IR level rather than
// silently emitting no guard.

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
  deployable api { platform: hono contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp with scaffold(subdomains: [Support]) { }
  deployable web { platform: ${frontendPlatform} targets: api ui: WebApp port: 3001 auth: ui }
}
`;
}

describe("auth: ui framework gate", () => {
  it("allows auth: ui on a react frontend", async () => {
    expect(await authUiErrors(sys("react"))).toEqual([]);
  });

  it("allows auth: ui on a vue frontend", async () => {
    expect(await authUiErrors(sys("vue"))).toEqual([]);
  });

  it("rejects auth: ui on a svelte frontend", async () => {
    const errs = await authUiErrors(sys("svelte"));
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("only supported on react and vue");
  });
});
