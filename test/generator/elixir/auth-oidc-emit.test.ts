import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

// ---------------------------------------------------------------------------
// Phoenix OIDC verifier emission (D-AUTH-OIDC).  An `auth { oidc }` block
// makes the generated ApiWeb.Auth plug a REAL OIDC verifier (JOSE + the
// issuer's JWKS), adds the /auth/me probe, and pulls {:jose, ...} + :inets/
// :ssl into mix.exs.  Without an oidc block (auth: required only) the plug
// stays the permissive dev stub — same out-of-the-box behaviour as the Hono /
// .NET dev-stub verifiers.  Compilation of the emitted Elixir is covered by
// the elixir-ash-build gate (the auth-oidc.ddd phoenix-build fixture); this
// suite pins the generator-level wiring.
// ---------------------------------------------------------------------------

async function build(source: string): Promise<Map<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ph-oidc-"));
  const file = path.join(dir, "auth.ddd");
  fs.writeFileSync(file, source);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(`Validation errors:\n${errors.map((e) => `  ${e.message}`).join("\n")}`);
  }
  return generateSystems(doc.parseResult.value as Model).files;
}

const USER_AUTH = `
  user {
    id: string
    roles: string[]
    email: string
  }`;

const OIDC_BLOCK = `
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER"), clientId: env("OIDC_CLIENT_ID") }
    claims: { roles: "realm_access.roles", email: "email" }
  }`;

function source(opts: { oidc: boolean }): string {
  return `system Helpdesk {${USER_AUTH}${opts.oidc ? OIDC_BLOCK : ""}
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish {
        subject: string
        open: bool
      }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource ticketState { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api {
    platform: phoenix { foundation: ash }
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    port: 4000
    auth: required
  }
}`;
}

describe("Phoenix OIDC verifier emission", () => {
  it("emits a real JOSE/JWKS verifier when an auth { oidc } block is present", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex");
    expect(auth, "auth.ex should be emitted").toBeDefined();
    // Real verifier — signature check against the issuer's JWKS.
    expect(auth!).toContain("JOSE.JWT.verify_strict");
    // Issuer read at RUNTIME (a module attribute would freeze the empty
    // compile-time env into the release).
    expect(auth!).toContain('defp issuer, do: System.get_env("OIDC_ISSUER"');
    expect(auth!).not.toContain("DEV STUB");
    // JWKS discovered + cached, never re-resolved.
    expect(auth!).toContain(":persistent_term");
    expect(auth!).toContain("/.well-known/openid-configuration");
  });

  it("maps claims onto the user shape via dotted paths (id ← sub)", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex")!;
    // id defaults to the `sub` claim; the explicit mapping wins for roles.
    expect(auth).toContain('id: get_claim(claims, "sub")');
    expect(auth).toContain('roles: get_claim(claims, "realm_access.roles") || []');
    expect(auth).toContain('email: get_claim(claims, "email")');
  });

  it("emits the /auth/me probe controller + route", async () => {
    const files = await build(source({ oidc: true }));
    expect(files.get("api/lib/api_web/controllers/auth_controller.ex")).toContain(
      "def me(conn, _params)",
    );
    const router = files.get("api/lib/api_web/router.ex")!;
    expect(router).toContain('scope "/auth", ApiWeb do');
    expect(router).toContain('get "/me", AuthController, :me');
  });

  it("pulls {:jose} + :inets/:ssl into mix.exs only under OIDC", async () => {
    const oidcMix = (await build(source({ oidc: true }))).get("api/mix.exs")!;
    expect(oidcMix).toContain("{:jose,");
    expect(oidcMix).toContain("extra_applications: [:logger, :runtime_tools, :inets, :ssl]");

    const stubMix = (await build(source({ oidc: false }))).get("api/mix.exs")!;
    expect(stubMix).not.toContain("{:jose,");
    expect(stubMix).toContain("extra_applications: [:logger, :runtime_tools]");
  });

  it("keeps the permissive dev stub when auth is required but no oidc block", async () => {
    const auth = (await build(source({ oidc: false }))).get("api/lib/api_web/auth.ex")!;
    expect(auth).toContain("DEV STUB");
    expect(auth).not.toContain("JOSE.JWT.verify_strict");
    // The /auth/me probe is still emitted (works for both verifier + stub).
    expect(
      (await build(source({ oidc: false }))).get("api/lib/api_web/controllers/auth_controller.ex"),
    ).toBeDefined();
  });
});
