// ---------------------------------------------------------------------------
// Java backend — OIDC turnkey auth (D-AUTH-OIDC).  Mirrors the Hono/.NET
// verifier+handshake: under an `auth { oidc }` block the Java backend emits a
// @Primary OidcUserVerifier (Nimbus JWKS validation + dotted-path claim
// mapping onto the typed User), an AuthController with the /auth/* redirect
// handshake + the /auth/me probe, the handshake-path bypass on UserFilter, and
// pulls the Nimbus dep into build.gradle.kts.  Non-OIDC `auth: required`
// projects keep only the dev stub + /auth/me (no verifier, no Nimbus).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const ROOT = "api/src/main/java/com/loom/api";

const OIDC_SRC = `
system Helpdesk {
  user {
    id: string
    roles: string[]
    email: string
  }
  auth {
    provider: keycloak
    oidc {
      issuer: env("OIDC_ISSUER")
      clientId: env("OIDC_CLIENT_ID")
    }
    claims: { roles: "realm_access.roles", email: "email" }
  }
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
    platform: java
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    port: 8080
    auth: required
  }
}
`;

// Same system, no `auth { oidc }` block — `auth: required` with the dev stub.
const PLAIN_AUTH_SRC = `
system Helpdesk {
  user {
    id: string
    role: string
  }
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
    platform: java
    contexts: [Tickets]
    serves: SupportApi
    dataSources: [ticketState]
    port: 8080
    auth: required
  }
}
`;

describe("java generator — OIDC verifier (D-AUTH-OIDC)", () => {
  it("emits a @Primary OidcUserVerifier that validates JWKS + iss/exp", async () => {
    const f = await generateSystemFiles(OIDC_SRC);
    const v = f.get(`${ROOT}/auth/OidcUserVerifier.java`)!;
    expect(v).toBeDefined();
    expect(v).toContain("@Primary");
    expect(v).toContain("public class OidcUserVerifier implements UserVerifier {");
    // Issuer read from the env(...) the auth block referenced; trailing-slash
    // normalised; discovery resolves the JWKS endpoint.
    expect(v).toContain('System.getenv("OIDC_ISSUER")');
    expect(v).toContain('"/.well-known/openid-configuration"');
    expect(v).toContain("JWKSourceBuilder.create");
    // Issuer + expiry are enforced; audience is opt-in (null → skipped).
    expect(v).toContain("new JWTClaimsSet.Builder().issuer(ISSUER).build()");
    expect(v).toContain('Set.of("exp")');
  });

  it("maps the configured claims (incl. the dotted realm_access.roles path)", async () => {
    const v = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/OidcUserVerifier.java`)!;
    // id ← sub (default), roles ← realm_access.roles (dotted), email ← email.
    expect(v).toContain('claimStringOrEmpty(payload, "sub")');
    expect(v).toContain('claimStringList(payload, "realm_access.roles")');
    expect(v).toContain('claimStringOrEmpty(payload, "email")');
    // Dotted paths navigate nested objects.
    expect(v).toContain('path.split("\\\\.")');
  });

  it("documents the http-issuer scheme handling (the .NET RequireHttps trap)", async () => {
    const v = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/OidcUserVerifier.java`)!;
    expect(v).toContain("plain-http dev issuer");
    expect(v).toContain("RequireHttps");
  });

  it("reads the bearer token from the header or the session cookie", async () => {
    const v = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/OidcUserVerifier.java`)!;
    expect(v).toContain('request.getHeader("Authorization")');
    expect(v).toContain('"session".equals(c.getName())');
  });
});

describe("java generator — /auth/* handshake + /auth/me (D-AUTH-OIDC)", () => {
  it("emits the AuthController handshake when an oidc block is present", async () => {
    const c = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/AuthController.java`)!;
    expect(c).toContain("@Hidden");
    expect(c).toContain('@GetMapping("/api/auth/me")');
    expect(c).toContain('@GetMapping("/api/auth/login")');
    expect(c).toContain('@GetMapping("/api/auth/callback")');
    expect(c).toContain('@GetMapping("/api/auth/logout")');
    // CSRF state cookie + authorization-code exchange.
    expect(c).toContain("oidc_state");
    expect(c).toContain("grant_type=authorization_code");
    expect(c).toContain('sessionCookie("session"');
  });

  it("drives login with PKCE and rotates refresh tokens", async () => {
    const c = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/AuthController.java`)!;
    // PKCE (RFC 7636): S256 challenge, verifier cookie, code_verifier on exchange.
    expect(c).toContain('MessageDigest.getInstance("SHA-256")');
    expect(c).toContain("code_challenge_method=S256");
    expect(c).toContain('stateCookie("oidc_verifier"');
    expect(c).toContain("&code_verifier=");
    // Refresh rotation: offline_access scope, POST /refresh, refresh cookie.
    expect(c).toContain("offline_access");
    expect(c).toContain('@PostMapping("/api/auth/refresh")');
    expect(c).toContain("grant_type=refresh_token");
    expect(c).toContain('sessionCookie("refresh"');
  });

  it("bypasses the handshake paths but keeps /auth/me protected", async () => {
    const filter = (await generateSystemFiles(OIDC_SRC)).get(`${ROOT}/auth/UserFilter.java`)!;
    expect(filter).toContain('"/api/auth/login",');
    expect(filter).toContain('"/api/auth/callback",');
    expect(filter).toContain('"/api/auth/logout",');
    expect(filter).toContain('"/api/auth/refresh",');
    // /api/auth/me must NOT be bypassed — it is the protected session probe.
    expect(filter).not.toContain('"/api/auth/me"');
  });

  it("pulls the Nimbus dep into the Gradle build under OIDC", async () => {
    const gradle = (await generateSystemFiles(OIDC_SRC)).get("api/build.gradle.kts")!;
    // Pinned version (NOT BOM-managed) — a version-less coordinate fails to
    // resolve against Maven Central.
    expect(gradle).toMatch(/implementation\("com\.nimbusds:nimbus-jose-jwt:\d/);
  });
});

describe("java generator — plain auth: required (no oidc block)", () => {
  it("keeps the dev stub + /auth/me but emits no verifier / Nimbus / handshake", async () => {
    const f = await generateSystemFiles(PLAIN_AUTH_SRC);
    // The session probe is still emitted (frontend guard parity).
    const c = f.get(`${ROOT}/auth/AuthController.java`)!;
    expect(c).toContain('@GetMapping("/api/auth/me")');
    expect(c).not.toContain('@GetMapping("/api/auth/login")');
    // No OIDC verifier, no Nimbus dep, no handshake bypass.
    expect(f.get(`${ROOT}/auth/OidcUserVerifier.java`)).toBeUndefined();
    expect(f.get("api/build.gradle.kts")!).not.toContain("nimbus-jose-jwt");
    expect(f.get(`${ROOT}/auth/UserFilter.java`)!).not.toContain('"/api/auth/login"');
    // The dev stub is still there for a verifier-less boot.
    expect(f.get(`${ROOT}/auth/DevStubUserVerifier.java`)).toBeDefined();
  });
});
