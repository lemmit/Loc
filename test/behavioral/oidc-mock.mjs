// In-process mock OIDC issuer for the headless behavioural tier.
//
// The generated OIDC verifier (`auth/oidc.ts`) validates a bearer JWT against
// the issuer's JWKS: it fetches `<ISSUER>/.well-known/openid-configuration`,
// reads `jwks_uri`, builds a remote JWK set, then `jwtVerify(token, jwks,
// { issuer })`.  The docker parity suite satisfies this with a real Keycloak;
// the node tier can't boot docker, so this stands up the same contract
// in-process: an RSA keypair, a tiny HTTP server serving the discovery doc +
// JWKS, and a signed token whose claims satisfy the fixtures' `requires`
// guards (`realm_access.roles == "agent"`).
//
// Mirrors the real issuer closely enough that the SAME generated verifier
// accepts the token unchanged — no dev-stub short-circuit, the actual JWT
// path runs.  Only used for `auth-oidc` (a deployable that emits auth/oidc.ts).

import { createServer } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

/** Start a mock OIDC issuer and mint a token for the canonical principal.
 *  Returns `{ issuer, token, stop }`.  `issuer` → OIDC_ISSUER; `token` →
 *  E2E_BEARER_TOKEN.  Call `stop()` when the run is done. */
export async function startMockIssuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  const kid = "loom-behavioural";
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/.well-known/openid-configuration")) {
      res.writeHead(200, { "content-type": "application/json" });
      // A fuller discovery document than node strictly needs: the stricter
      // OIDC clients on the other backends (.NET ConfigurationManager, java
      // nimbus, python PyJWKClient) parse the whole doc and expect the
      // standard endpoint/algorithm fields to be present.
      res.end(
        JSON.stringify({
          issuer,
          jwks_uri: `${issuer}/jwks`,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ["code", "id_token", "token id_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          scopes_supported: ["openid", "profile", "email"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          claims_supported: ["sub", "iss", "email", "realm_access", "permissions"],
        }),
      );
    } else if (url.startsWith("/jwks")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const issuer = `http://127.0.0.1:${port}`;

  // Claims match the OIDC verifier's projection (`toUser`): `sub`,
  // `realm_access.roles` → role, `email`, `permissions`.  `roles == "agent"`
  // so the `requires currentUser.role == "agent"` guard passes — the OIDC
  // twin of the dev-stub DEV_CLAIMS principal.
  const token = await new SignJWT({
    realm_access: { roles: "agent" },
    email: "agent@example.com",
    permissions: ["close"],
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("00000000-0000-0000-0000-000000000000")
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);

  return {
    issuer,
    token,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
