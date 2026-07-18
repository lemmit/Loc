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
// the elixir-vanilla-build gate (the vanilla-auth-oidc.ddd fixture); this
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
    platform: elixir
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    port: 4000
    auth: required
  }
}`;
}

// A phoenixLiveView deployable that also mounts a HEEx `ui:` — so the router
// emits a `live_session` and the `auth: ui` LiveView guard wiring applies.
function sourceWithUi(opts: { oidc: boolean }): string {
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
  ui WebApp {
    api Support: SupportApi
    page Home { route: "/" body: Heading { "Home" } }
  }
  deployable api {
    platform: elixir
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    ui: WebApp { Support: api }
    port: 4000
    auth: required
  }
}`;
}

describe("Phoenix LiveView auth: ui guard (D-AUTH-OIDC, M-T3.5)", () => {
  it("gates the live_session with LiveAuth + seeds the session via BrowserAuth (OIDC)", async () => {
    const files = await build(sourceWithUi({ oidc: true }));
    const router = files.get("api/lib/api_web/router.ex")!;
    // LiveAuth runs FIRST in the on_mount chain (gates), Nav second.
    expect(router).toContain("on_mount: [ApiWeb.LiveAuth, ApiWeb.Nav]");
    // The :browser pipeline seeds the session from the verified cookie.
    expect(router).toContain("plug ApiWeb.BrowserAuth");
    // The plug module + its session-seeding call.
    const browserAuth = files.get("api/lib/api_web/browser_auth.ex")!;
    expect(browserAuth).toContain("defmodule ApiWeb.BrowserAuth");
    expect(browserAuth).toContain("ApiWeb.Auth.session_user(conn)");
    expect(browserAuth).toContain('put_session(conn, "current_user", user)');
    // Auth module exposes session_user/1 (reads + verifies the session cookie).
    expect(files.get("api/lib/api_web/auth.ex")!).toContain("def session_user(conn)");
    // A gated LiveView bounces to the real login handshake, not a bare /login.
    expect(files.get("api/lib/api_web/live_auth.ex")!).toContain(
      'Phoenix.LiveView.redirect(socket, to: "/api/auth/login")',
    );
  });

  it("dev stub: LiveAuth still gates (dev_user fallback), no BrowserAuth plug", async () => {
    const files = await build(sourceWithUi({ oidc: false }));
    const router = files.get("api/lib/api_web/router.ex")!;
    // LiveAuth is wired even for the dev stub (assigns @current_user), but no
    // BrowserAuth plug — the dev_user fallback needs no session seeding.
    expect(router).toContain("on_mount: [ApiWeb.LiveAuth, ApiWeb.Nav]");
    expect(router).not.toContain("plug ApiWeb.BrowserAuth");
    expect(files.has("api/lib/api_web/browser_auth.ex")).toBe(false);
    // The dev-stub LiveAuth grants the built-in admin rather than redirecting.
    expect(files.get("api/lib/api_web/live_auth.ex")!).toContain("ApiWeb.Auth.dev_user()");
  });
});

describe("Phoenix OIDC verifier emission", () => {
  it("emits a real JOSE/JWKS verifier when an auth { oidc } block is present", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex");
    expect(auth, "auth.ex should be emitted").toBeDefined();
    // Real verifier — signature check against the issuer's JWKS.
    expect(auth!).toContain("JOSE.JWT.verify_strict");
    // Issuer read at RUNTIME (a module attribute would freeze the empty
    // compile-time env into the release); the OIDC_ISSUER env override wins
    // over the declared value (12-factor).
    expect(auth!).toContain('defp issuer, do: (System.get_env("OIDC_ISSUER"');
    expect(auth!).not.toContain("DEV STUB");
    // JWKS discovered + cached in :persistent_term.
    expect(auth!).toContain(":persistent_term");
    expect(auth!).toContain("/.well-known/openid-configuration");
  });

  it("never caches a failed JWKS fetch (IdP-not-up-yet must not brick auth)", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex")!;
    // A failed discovery yields [] — reject THIS request, but do not
    // persist the empty list: a request racing the dev Keycloak's boot
    // would otherwise pin every later verify to 401 until restart.
    expect(auth).toContain("case fetch_jwks() do");
    expect(auth).toMatch(/\[\] ->\n\s+\[\]/);
  });

  it("refetches the JWKS on a kid miss (rate-limited) so IdP key rotation heals without a restart", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex")!;
    // A kid the cached set doesn't know retries against a fresh fetch…
    expect(auth).toContain("find_key(jwks(), kid) || find_key(refreshed_jwks(), kid)");
    // …rate-limited (one refetch per 30s) so unknown-kid bursts can't
    // hammer the IdP…
    expect(auth).toContain(":jwks_refreshed_at");
    expect(auth).toContain("if now - last < 30 do");
    // …and a successful refetch replaces the cached set for later requests.
    expect(auth).toContain(":persistent_term.put({__MODULE__, :jwks}, keys)");
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
    expect(router).toContain('scope "/api/auth", ApiWeb do');
    expect(router).toContain('get "/me", AuthController, :me');
  });

  it("emits the /auth/login|callback|logout redirect handshake under OIDC", async () => {
    const files = await build(source({ oidc: true }));
    const ctrl = files.get("api/lib/api_web/controllers/auth_controller.ex")!;
    // The three handshake actions + the code→token exchange.
    expect(ctrl).toContain("def login(conn, _params)");
    expect(ctrl).toContain('def callback(conn, %{"code" => code, "state" => state})');
    expect(ctrl).toContain("def logout(conn, _params)");
    expect(ctrl).toContain('put_resp_cookie(conn, "session", Map.get(tokens, "access_token"');
    expect(ctrl).toContain('"grant_type" => "authorization_code"');
    // Routed.
    const router = files.get("api/lib/api_web/router.ex")!;
    expect(router).toContain('get "/login", AuthController, :login');
    expect(router).toContain('get "/callback", AuthController, :callback');
    expect(router).toContain('get "/logout", AuthController, :logout');
    // The plug bypasses the three redirect endpoints (no principal yet) and
    // reads the token from the Bearer header OR the handshake's session cookie.
    const auth = files.get("api/lib/api_web/auth.ex")!;
    expect(auth).toContain('defp bypass_path?("/api/auth/login"), do: true');
    expect(auth).toContain('defp bypass_path?("/api/auth/callback"), do: true');
    expect(auth).toContain('defp bypass_path?("/api/auth/logout"), do: true');
    expect(auth).toContain("defp extract_token(conn)");
    expect(auth).toContain('conn.cookies["session"]');
  });

  it("drives login with PKCE and rotates refresh tokens under OIDC", async () => {
    const files = await build(source({ oidc: true }));
    const ctrl = files.get("api/lib/api_web/controllers/auth_controller.ex")!;
    // PKCE (RFC 7636): S256 challenge, verifier cookie, code_verifier on exchange.
    expect(ctrl).toContain(":crypto.hash(:sha256, verifier)");
    expect(ctrl).toContain('"code_challenge_method" => "S256"');
    expect(ctrl).toContain('put_resp_cookie("oidc_verifier", verifier');
    expect(ctrl).toContain('"code_verifier" => verifier');
    // Refresh rotation: offline_access scope, refresh action, refresh cookie.
    expect(ctrl).toContain("offline_access");
    expect(ctrl).toContain("def refresh(conn, _params)");
    expect(ctrl).toContain('"grant_type" => "refresh_token"');
    expect(ctrl).toContain('put_resp_cookie(conn, "refresh"');
    // Routed + bypassed (no valid access token yet).
    const router = files.get("api/lib/api_web/router.ex")!;
    expect(router).toContain('post "/refresh", AuthController, :refresh');
    const auth = files.get("api/lib/api_web/auth.ex")!;
    expect(auth).toContain('defp bypass_path?("/api/auth/refresh"), do: true');
  });

  it("emits NO handshake on the dev-stub path (auth required, no oidc)", async () => {
    const files = await build(source({ oidc: false }));
    const ctrl = files.get("api/lib/api_web/controllers/auth_controller.ex")!;
    expect(ctrl).not.toContain("def login(");
    expect(ctrl).not.toContain("def callback(");
    const auth = files.get("api/lib/api_web/auth.ex")!;
    expect(auth).not.toContain("extract_token");
    expect(auth).not.toContain('bypass_path?("/api/auth/login")');
    const router = files.get("api/lib/api_web/router.ex")!;
    expect(router).not.toContain(":login");
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

// ---------------------------------------------------------------------------
// LiveView dev-stub auth + the LiveView dead-render signing salt — without
// either, a generated Phoenix LiveView UI doesn't render in dev: every page
// 302s to /login (the dev stub never seeds the browser session, only the :api
// pipeline) and the first dead-render raises with no `live_view:` salt.
// ---------------------------------------------------------------------------
describe("Phoenix LiveView dev-stub auth", () => {
  it("dev stub: the :api Auth plug falls back to the built-in admin", async () => {
    const files = await build(source({ oidc: false }));
    const auth = files.get("api/lib/api_web/auth.ex")!;
    // The plug exposes the built-in principal (dev has no /auth/callback
    // handshake to seed a real one).
    expect(auth).toContain("def dev_user, do: build_user(elem(verify_token(nil), 1))");
  });

  it("oidc: the :api Auth plug stays strict — no dev_user fallback", async () => {
    const files = await build(source({ oidc: true }));
    const auth = files.get("api/lib/api_web/auth.ex")!;
    expect(auth).not.toContain("def dev_user");
  });

  it("emits the live_view dead-render signing salt in config.exs", async () => {
    const config = (await build(source({ oidc: false }))).get("api/config/config.exs")!;
    expect(config).toContain("live_view: [signing_salt:");
  });
});
