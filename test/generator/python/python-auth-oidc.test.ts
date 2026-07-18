import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python/FastAPI OIDC verifier + handshake (D-AUTH-OIDC).  An `auth { oidc }`
// block makes the generated app a real OIDC verifier (PyJWT + the issuer's
// JWKS via PyJWKClient), adds the /auth/login|callback|logout redirect
// handshake + the /auth/me probe, and the pyjwt[crypto] dep — auto-registered
// in main.py in place of the dev stub.  Without an oidc block (auth: required
// only) the dev stub stays.  Compilation/strict-typing of the emitted Python
// is covered by the LOOM_PYTHON_BUILD gate (the auth-oidc.ddd fixture under
// ruff + mypy --strict); this suite pins the generator-level wiring.
// ---------------------------------------------------------------------------

const USER = `
  user {
    id: string
    roles: string[]
    email: string
  }`;

const OIDC = `
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER"), clientId: env("OIDC_CLIENT_ID") }
    claims: { roles: "realm_access.roles", email: "email" }
  }`;

function source(opts: { oidc: boolean }): string {
  return `system Helpdesk {${USER}${opts.oidc ? OIDC : ""}
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
    platform: python
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    port: 8000
    auth: required
  }
}`;
}

async function build(opts: { oidc: boolean }): Promise<Map<string, string>> {
  const { model, errors } = await parseString(source(opts));
  if (errors.length) throw new Error(`validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python OIDC verifier + handshake", () => {
  it("emits a PyJWT/JWKS verifier under an auth { oidc } block", async () => {
    const files = await build({ oidc: true });
    const oidc = files.get("api/app/auth/oidc.py");
    expect(oidc, "oidc.py should be emitted").toBeDefined();
    expect(oidc!).toContain("import jwt");
    expect(oidc!).toContain("jwt.PyJWKClient");
    expect(oidc!).toContain("jwt.decode(");
    // Issuer read at runtime (a module attr would freeze the empty import-time
    // env), JWKS discovered via the well-known doc.
    expect(oidc!).toContain('os.environ.get("OIDC_ISSUER", "")');
    expect(oidc!).toContain("/.well-known/openid-configuration");
  });

  it("maps claims onto User via dotted paths (id ← sub)", async () => {
    const oidc = (await build({ oidc: true })).get("api/app/auth/oidc.py")!;
    expect(oidc).toContain('id=cast(str, _claim(payload, "sub"))');
    expect(oidc).toContain('roles=cast(list[str], _claim(payload, "realm_access.roles") or [])');
    expect(oidc).toContain('email=cast(str, _claim(payload, "email"))');
  });

  it("emits the /auth/login|callback|logout handshake + /auth/me probe", async () => {
    const files = await build({ oidc: true });
    const oidc = files.get("api/app/auth/oidc.py")!;
    expect(oidc).toContain('@router.get("/login"');
    expect(oidc).toContain('@router.get("/callback"');
    expect(oidc).toContain('@router.get("/logout"');
    expect(oidc).toContain('"grant_type": "authorization_code"');
    expect(oidc).toContain('response.set_cookie(\n        "session"');
    // /auth/me probe (always present under auth) reads the verified user.
    expect(files.get("api/app/auth/routes.py")!).toContain('@router.get("/me"');
  });

  it("drives login with PKCE and rotates refresh tokens", async () => {
    const oidc = (await build({ oidc: true })).get("api/app/auth/oidc.py")!;
    // PKCE (RFC 7636): S256 challenge, verifier cookie, code_verifier on exchange.
    expect(oidc).toContain("hashlib.sha256");
    expect(oidc).toContain('"code_challenge_method": "S256"');
    expect(oidc).toContain('response.set_cookie("oidc_verifier"');
    expect(oidc).toContain('"code_verifier": verifier');
    // Refresh rotation: offline_access scope, POST /refresh, refresh cookie.
    expect(oidc).toContain("offline_access");
    expect(oidc).toContain('@router.post("/refresh"');
    expect(oidc).toContain('"grant_type": "refresh_token"');
    expect(oidc).toContain('response.set_cookie("refresh"');
  });

  it("auto-registers the OIDC verifier (not the dev stub) + mounts both routers", async () => {
    const main = (await build({ oidc: true })).get("api/app/main.py")!;
    expect(main).toContain("from app.auth.oidc import register_oidc_verifier");
    expect(main).toContain("register_oidc_verifier()");
    expect(main).not.toContain("_dev_stub_verifier");
    expect(main).toContain("app.include_router(auth_router)");
    expect(main).toContain("app.include_router(auth_oidc_router)");
  });

  it("adds pyjwt[crypto] to pyproject only under OIDC, and bypasses the handshake", async () => {
    const oidcFiles = await build({ oidc: true });
    expect(oidcFiles.get("api/pyproject.toml")!).toContain("pyjwt[crypto]");
    expect(oidcFiles.get("api/app/auth/middleware.py")!).toContain('"/api/auth/login"');

    const stub = await build({ oidc: false });
    expect(stub.get("api/pyproject.toml")!).not.toContain("pyjwt");
    expect(stub.get("api/app/auth/oidc.py")).toBeUndefined();
    expect(stub.get("api/app/main.py")!).toContain("_dev_stub_verifier");
    // /auth/me still emitted on the dev-stub path (the guard reads it).
    expect(stub.get("api/app/auth/routes.py")).toBeDefined();
  });
});
