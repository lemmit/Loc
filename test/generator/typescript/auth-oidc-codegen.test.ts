// Hono OIDC turnkey-auth codegen (D-AUTH-OIDC, Phase 1).  Compiles a
// system carrying a `auth { oidc { … } }` block and locks the emitted
// shape: the generated jose-backed verifier, the /auth/* handshake, the
// `jose` dep, automatic verifier registration (replacing the dev stub),
// and the createApp route mount + middleware bypass.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const OIDC = `
system Helpdesk {
  user { id: string role: string email: string permissions: string[] }
  auth {
    provider: keycloak
    oidc {
      issuer: env("OIDC_ISSUER")
      clientId: env("OIDC_CLIENT_ID")
    }
    sessions: cookie
    claims: { role: "realm_access.roles" }
  }
  subdomain S {
    context C {
      aggregate Ticket with crudish {
        subject: string
        operation close() {
          requires currentUser.role == "agent"
        }
      }
      repository Tickets for Ticket { }
    }
  }
  api SApi from S
  deployable api { platform: node contexts: [C] serves: SApi port: 3000 auth: required }
}
`;

// Same system minus the `auth { … }` block — `auth: required` only, so the
// hand-registered dev stub stays and no OIDC file is emitted.
const STUB_ONLY = `
system Helpdesk {
  user { id: string role: string }
  subdomain S {
    context C {
      aggregate Ticket with crudish { subject: string }
      repository Tickets for Ticket { }
    }
  }
  api SApi from S
  deployable api { platform: node contexts: [C] serves: SApi port: 3000 auth: required }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}`);
}

function hasFile(files: Map<string, string>, pattern: RegExp): boolean {
  for (const k of files.keys()) if (pattern.test(k)) return true;
  return false;
}

// The project entry (root `index.ts`) — distinguished from `http/index.ts`
// by the node-server boot it owns.
function entryIndex(files: Map<string, string>): string {
  for (const [k, v] of files) {
    if (/(^|\/)index\.ts$/.test(k) && v.includes('from "@hono/node-server"')) return v;
  }
  throw new Error("no entry index.ts found");
}

describe("hono OIDC turnkey auth — codegen", () => {
  it("emits a jose-backed verifier that maps the configured claims", async () => {
    const files = await generateSystemFiles(OIDC);
    const oidc = findFile(files, /auth\/oidc\.ts$/);
    expect(oidc).toContain('from "jose"');
    expect(oidc).toContain("createRemoteJWKSet");
    expect(oidc).toContain('const ISSUER = process.env.OIDC_ISSUER ?? "";');
    // explicit claim mapping wins; id defaults to `sub`; others read own name
    expect(oidc).toContain('role: claim(payload, "realm_access.roles")');
    expect(oidc).toContain('id: claim(payload, "sub")');
    expect(oidc).toContain('email: claim(payload, "email")');
    expect(oidc).toContain('permissions: claim(payload, "permissions")');
    expect(oidc).toContain("export function registerOidcVerifier()");
  });

  it("makes a LITERAL issuer/audience env-overridable (bundled-Keycloak repoint)", async () => {
    // The generated compose repoints OIDC_ISSUER at the bundled dev
    // Keycloak — a baked literal would 401 every bundled-IdP token
    // (caught live by the parity 403 test).
    const literal = OIDC.replace(
      'issuer: env("OIDC_ISSUER")',
      'issuer: "https://idp.example.com"\n      audience: "my-api"',
    );
    const files = await generateSystemFiles(literal);
    const oidc = findFile(files, /auth\/oidc\.ts$/);
    expect(oidc).toContain('const ISSUER = process.env.OIDC_ISSUER ?? "https://idp.example.com";');
    expect(oidc).toContain('const AUDIENCE = process.env.OIDC_AUDIENCE ?? "my-api";');
  });

  it("never caches a failed JWKS discovery (IdP-not-up-yet must not brick auth)", async () => {
    const files = await generateSystemFiles(OIDC);
    const oidc = findFile(files, /auth\/oidc\.ts$/);
    // A rejected discovery promise clears the cache so the next request
    // retries — a request racing the dev Keycloak's boot would otherwise
    // pin every later verify to 401 until restart.
    expect(oidc).toContain("jwksPromise.catch(() => {");
    expect(oidc).toContain("jwksPromise = null;");
  });

  it("emits the /auth/login|callback|logout handshake", async () => {
    const files = await generateSystemFiles(OIDC);
    const hs = findFile(files, /auth\/handshake\.ts$/);
    expect(hs).toContain('app.get("/login"');
    expect(hs).toContain('app.get("/callback"');
    expect(hs).toContain('app.get("/logout"');
    expect(hs).toContain('const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? "";');
    expect(hs).toContain('grant_type: "authorization_code"');
    expect(hs).toContain("export function authRoutes()");
  });

  it("drives the login with PKCE (S256 challenge, verifier cookie, code_verifier on exchange)", async () => {
    const files = await generateSystemFiles(OIDC);
    const hs = findFile(files, /auth\/handshake\.ts$/);
    // Login mints a verifier + sends only the SHA-256 challenge.
    expect(hs).toContain('createHash("sha256")');
    expect(hs).toContain('url.searchParams.set("code_challenge_method", "S256")');
    expect(hs).toContain('setCookie(c, "oidc_verifier"');
    // The callback proves possession with the stored verifier.
    expect(hs).toContain("code_verifier: verifier");
  });

  it("rotates refresh tokens: offline_access scope, /refresh endpoint, both cookies stored", async () => {
    const files = await generateSystemFiles(OIDC);
    const hs = findFile(files, /auth\/handshake\.ts$/);
    // Ask the IdP for a refresh token, then expose the rotation endpoint.
    expect(hs).toContain("offline_access");
    expect(hs).toContain('app.post("/refresh"');
    expect(hs).toContain('grant_type: "refresh_token"');
    // Rotation overwrites the refresh cookie (single-use), and logout clears it.
    expect(hs).toContain('setCookie(c, "refresh"');
    expect(hs).toContain('deleteCookie(c, "refresh"');
    // /refresh must be reachable without a valid access token.
    const mw = findFile(files, /auth\/middleware\.ts$/);
    expect(mw).toContain('"/api/auth/refresh"');
  });

  it("adds the jose dependency", async () => {
    const files = await generateSystemFiles(OIDC);
    const pkg = JSON.parse(findFile(files, /package\.json$/)) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jose).toBeDefined();
  });

  it("registers the OIDC verifier at boot instead of the dev stub", async () => {
    const files = await generateSystemFiles(OIDC);
    const index = entryIndex(files);
    expect(index).toContain('import { registerOidcVerifier } from "./auth/oidc";');
    expect(index).toContain("registerOidcVerifier();");
    expect(index).not.toContain("auth_dev_stub_registered");
  });

  it("mounts the handshake routes and bypasses /auth in the middleware", async () => {
    const files = await generateSystemFiles(OIDC);
    const httpIndex = findFile(files, /http\/index\.ts$/);
    expect(httpIndex).toContain('import { authRoutes } from "../auth/handshake";');
    expect(httpIndex).toContain('app.route("/api/auth", authRoutes());');
    const mw = findFile(files, /auth\/middleware\.ts$/);
    // Only the redirect endpoints bypass auth; /api/auth/me stays protected.
    expect(mw).toContain('"/api/auth/login"');
    expect(mw).not.toContain('"/api/auth/me"');
  });

  it("without an auth{} block keeps the dev stub and emits /auth/me but no OIDC", async () => {
    const files = await generateSystemFiles(STUB_ONLY);
    // No OIDC verifier, no redirect handshake — but /auth/me still exists so
    // a frontend guard can probe the (dev-stub) session.
    expect(hasFile(files, /auth\/oidc\.ts$/)).toBe(false);
    const handshake = findFile(files, /auth\/handshake\.ts$/);
    expect(handshake).toContain('app.get("/me"');
    expect(handshake).not.toContain('app.get("/login"');
    const index = entryIndex(files);
    expect(index).toContain("auth_dev_stub_registered");
    // The dev stub honours an injected x-loom-dev-claims header (the
    // playground identity-injection seam) — dev-only, merged over the
    // built-in identity.
    expect(index).toContain('req.headers.get("x-loom-dev-claims")');
    expect(index).toContain('Buffer.from(injected, "base64")');
    const pkg = JSON.parse(findFile(files, /package\.json$/)) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.jose).toBeUndefined();
  });
});
