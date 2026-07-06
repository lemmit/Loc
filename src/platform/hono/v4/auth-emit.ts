import { renderTsType } from "../../../generator/typescript/render-expr.js";
import type { AuthIR, AuthValueIR, SystemIR, UserIR } from "../../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../../util/api-base.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Hono-side auth scaffolding emitted per deployable when `auth: required`.
// Three small files always, two more under an OIDC `auth { … }` block:
//
//   auth/user-types.ts — strongly-typed User shape (matches the C#
//                        record one-for-one; cross-platform contract
//                        check verifies)
//   auth/verifier.ts   — registry + helper for the user-supplied
//                        verifier function
//   auth/middleware.ts — Hono middleware mounted in http/index.ts
//   auth/oidc.ts       — (OIDC only) the generated `jose`-backed token
//                        verifier filling the verifier seam (D-AUTH-OIDC)
//   auth/handshake.ts  — (OIDC only) the /auth/login|callback|logout
//                        redirect handlers
//
// Without an `auth { … }` block the user calls `registerUserVerifier(fn)`
// by hand (index.ts ships a permissive dev stub).  With one, the
// generated OIDC verifier is registered automatically.  The middleware
// bypass list mirrors the .NET side: /health, /ready, /openapi.json,
// /swagger (plus /auth for the OIDC handshake).
// ---------------------------------------------------------------------------

export function emitAuthFiles(sys: SystemIR, out: Map<string, string>): void {
  if (!sys.user) return;
  const oidc = sys.auth;
  // The tenancy claim field, when the system declares `tenancy by …` — drives
  // the derived `currentUser.orgPath` principal member (multi-tenancy P2.1).
  const orgPathClaim = sys.tenancy?.claimField;
  out.set("auth/user-types.ts", renderUserTypes(sys.user, orgPathClaim));
  out.set("auth/verifier.ts", renderVerifier());
  out.set("auth/middleware.ts", renderMiddleware(sys.user, !!oidc, orgPathClaim));
  // The session routes (always `/auth/me`, plus the OIDC redirect handshake
  // when an `auth { oidc }` block is present) are emitted whenever a
  // backend has auth — the frontend `auth: ui` guard probes `/auth/me`,
  // which works for both the OIDC verifier and the dev stub.
  out.set("auth/handshake.ts", renderHandshake(oidc));
  if (oidc) {
    out.set("auth/oidc.ts", renderOidcVerifier(sys.user, oidc));
  }
}

/** The principal's id key — the claim named `id`, else the first declared
 *  field.  Stamped onto the carrier as `actorId` (the who-computed slice
 *  audit / provenance read); only the id rides it, the full principal stays
 *  on `currentUser`. */
function actorIdField(user: UserIR): string | null {
  const field = user.fields.find((f) => f.name === "id") ?? user.fields[0];
  return field ? field.name : null;
}

/** Render an `AuthValueIR` (literal | env reference) as a TS expression. */
function authValueExpr(v: AuthValueIR | undefined, fallback = '""'): string {
  if (!v) return fallback;
  if (v.kind === "literal") return JSON.stringify(v.value);
  // Dot access when the env-var name is a valid identifier (biome's
  // useLiteralKeys prefers it); bracket otherwise.
  const access = /^[A-Za-z_$][\w$]*$/.test(v.env)
    ? `process.env.${v.env}`
    : `process.env[${JSON.stringify(v.env)}]`;
  return `${access} ?? ""`;
}

/** `process.env.<canonical var> ?? <declared>` — the deploy environment
 *  overrides the declared auth value (12-factor: the generated compose
 *  repoints OIDC_ISSUER / OIDC_CLIENT_ID at the bundled dev Keycloak, so a
 *  literal must not be baked un-overridably — with it baked, every token
 *  from the bundled IdP fails `iss` validation).  A declared env-kind value
 *  reading the same var stays a single read. */
function envOverridableExpr(envVar: string, v: AuthValueIR | undefined): string {
  if (v?.kind === "env" && v.env === envVar) return authValueExpr(v);
  return `process.env.${envVar} ?? ${authValueExpr(v)}`;
}

/** The IdP claim path projected onto a given `user { … }` field.  An
 *  explicit `claims:` mapping wins; otherwise `id` defaults to the
 *  standard `sub` claim and every other field reads its own name. */
function claimPathFor(field: string, auth: AuthIR): string {
  const mapped = auth.claims.find((c) => c.field === field);
  if (mapped) return mapped.path;
  return field === "id" ? "sub" : field;
}

function renderUserTypes(user: UserIR, orgPathClaim?: string): string {
  // User shape lives in its own module so any per-aggregate file (or
  // workflow / view route) can `import type { User }` without
  // pulling the verifier registry alongside.
  const fields = user.fields.map((f) => {
    // FieldIR.optional is already encoded via the type when the source
    // wrote `T?`.  For simplicity we surface the raw declared type and
    // let renderTsType handle `optional` / `array`.
    const t = f.optional ? renderTsType({ kind: "optional", inner: f.type }) : renderTsType(f.type);
    return `  ${f.name}: ${t};`;
  });
  // `UserClaims` is the raw token→field projection the verifier returns; the
  // request principal `User` extends it with the derived, per-request
  // `orgPath` (multi-tenancy P2.1) when the system declares tenancy.  The
  // split keeps the verifier free of the derived member (it can't know the
  // path from the token) while every domain-code `import { User }` sees it.
  const userDecl = orgPathClaim
    ? [
        "export interface User extends UserClaims {",
        "  /** The caller's tenant materialized path (`currentUser.orgPath`) —",
        "   *  derived per-request from the tenancy claim, memoized on this",
        "   *  request-scoped principal (multi-tenancy Phase 2, P2.1). */",
        "  orgPath: string;",
        "}",
      ]
    : ["export type User = UserClaims;"];
  return (
    lines(
      "// Auto-generated.",
      "// User-claim shape decoded from the inbound JWT.  The verifier",
      "// hook (auth/verifier.ts) returns `UserClaims`; the auth middleware",
      "// derives the request principal `User` from it (adding `orgPath` under",
      "// tenancy).  Downstream route handlers / workflow handlers / view binds",
      "// reference `User` via the magic `currentUser` identifier.",
      "export interface UserClaims {",
      ...fields,
      "}",
      "",
      ...userDecl,
    ) + "\n"
  );
}

function renderVerifier(): string {
  return `// Auto-generated.
import type { UserClaims } from "./user-types";

/** Verifier hook the user implements: decode the inbound request's
 *  JWT, return the populated claim shape on success, return null (or
 *  throw) to reject with a 401.  Register your implementation at app
 *  startup, BEFORE calling \`serve(...)\`.  The auth middleware derives
 *  the request principal (\`User\`, incl. \`orgPath\` under tenancy) from
 *  the returned claims. */
export type UserVerifier = (req: Request) => Promise<UserClaims | null> | UserClaims | null;

let registered: UserVerifier | null = null;

/** Register the verifier.  Calling more than once overwrites. */
export function registerUserVerifier(fn: UserVerifier): void {
  registered = fn;
}

/** Internal — called by the middleware on every authenticated request. */
export async function verifyUserOrThrow(req: Request): Promise<UserClaims> {
  if (!registered) {
    throw new Error(
      "No user verifier is registered.  Call registerUserVerifier(...) " +
        "with a function that decodes the request's JWT into a User " +
        "before serving.",
    );
  }
  const result = await registered(req);
  if (result === null || result === undefined) {
    throw new Error("unauthorized");
  }
  return result;
}

/** Verify the verifier was registered.  The HTTP composer calls this
 *  at startup so a missing registration surfaces as a clear error
 *  instead of a 401 storm on the first request. */
export function assertUserVerifierRegistered(): void {
  if (!registered) {
    throw new Error(
      "No user verifier is registered.  Call registerUserVerifier(...) " +
        "with a JWT-decoding function before booting the HTTP server.",
    );
  }
}
`;
}

function renderMiddleware(user: UserIR, oidc: boolean, orgPathClaim?: string): string {
  const idField = actorIdField(user);
  const stampActorId = idField ? `\n  if (ctx) ctx.actorId = String(user.${idField});` : "";
  // Derive the request principal from the verifier's claims.  Under tenancy,
  // add the per-request `orgPath` — the caller's tenant materialized path
  // (multi-tenancy P2.1).  Computed once here (post-verify, so it reflects any
  // dev-claims override) and memoized on the request-scoped principal.  P2.1
  // resolves it to the tenancy claim value (the root-segment path); P2.2 swaps
  // this for a memoized registry `dataKey` lookup keyed by the same claim.
  const deriveUser = orgPathClaim
    ? `{ ...claims, orgPath: String(claims.${orgPathClaim} ?? "") }`
    : "claims";
  // Only the handshake's redirect endpoints bypass auth — they must be
  // reachable without a verified principal.  `/api/auth/me` (the session probe
  // the frontend guard reads) is deliberately NOT bypassed, so the
  // middleware populates `currentUser` or rejects with 401.
  const bypass = oidc
    ? `["/health", "/ready", "/openapi.json", "/swagger", "${AUTH_BASE_PATH}/login", "${AUTH_BASE_PATH}/callback", "${AUTH_BASE_PATH}/logout"]`
    : '["/health", "/ready", "/openapi.json", "/swagger"]';
  return `// Auto-generated.
import { createMiddleware } from "hono/factory";
import { requestContext } from "../obs/als";
import type { User, UserClaims } from "./user-types";
import { verifyUserOrThrow } from "./verifier";

const BYPASS_PREFIXES = ${bypass} as const;

/** Hono middleware that decodes the request's JWT into a User, attaches it
 *  to the ambient RequestContext (the one source of truth, readable by
 *  non-HTTP code via \`requireCurrentUser()\`), and also stashes it on the
 *  Hono request scope under "currentUser" for HTTP-layer reads.  Bypass
 *  list matches the .NET side — framework endpoints stay anonymous so
 *  smoke tests + the OpenAPI cross-check don't need tokens. */
export const authMiddleware = createMiddleware<{
  Variables: { currentUser: User };
}>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  for (const prefix of BYPASS_PREFIXES) {
    if (path.startsWith(prefix)) {
      await next();
      return;
    }
  }
  let claims: UserClaims;
  try {
    claims = await verifyUserOrThrow(c.req.raw);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  const user: User = ${deriveUser};
  // Attach the principal to the ambient frame (read by non-HTTP code via
  // requireCurrentUser) and to the Hono context (read by route handlers
  // that hold \`c\`).
  const ctx = requestContext();
  if (ctx) ctx.currentUser = user;${stampActorId}
  c.set("currentUser", user);
  await next();
});

/** The verified principal for the current request, read from the ambient
 *  RequestContext — the analogue of .NET's ICurrentUserAccessor.User.
 *  Throws when no principal is bound, so anonymous / bypassed paths must
 *  not call it. */
export function requireCurrentUser(): User {
  const user = requestContext()?.currentUser;
  if (user == null) {
    throw new Error(
      "currentUser is not available — ensure authMiddleware ran for this route.",
    );
  }
  return user as User;
}
`;
}

// ---------------------------------------------------------------------------
// OIDC verifier (D-AUTH-OIDC) — the batteries-included fill-in for the
// verifier seam.  Validates the bearer token's signature against the
// issuer's JWKS (discovered lazily), checks `iss` / `aud` / `exp`, and
// projects the configured claims onto the typed User shape.  Loom owns no
// auth runtime beyond "validate a token"; the IdP owns everything else.
// ---------------------------------------------------------------------------

function renderOidcVerifier(user: UserIR, auth: AuthIR): string {
  // Deploy env overrides the declared value — see envOverridableExpr (the
  // 401-from-the-bundled-IdP failure mode caught live by the parity 403 test).
  const issuerExpr = envOverridableExpr("OIDC_ISSUER", auth.oidc.issuer);
  // Audience is optional — only emit the const + the verify option when
  // configured, so the generated code carries no always-falsy constant.
  const audienceConst = auth.oidc.audience
    ? `\nconst AUDIENCE = ${envOverridableExpr("OIDC_AUDIENCE", auth.oidc.audience)};`
    : "";
  const verifyOptions = auth.oidc.audience
    ? "{ issuer: ISSUER, audience: AUDIENCE }"
    : "{ issuer: ISSUER }";
  // One `field: claim(payload, "<path>") as <T>` line per user field.
  const toUserLines = user.fields.map((f) => {
    const t = f.optional ? renderTsType({ kind: "optional", inner: f.type }) : renderTsType(f.type);
    return `    ${f.name}: claim(payload, ${JSON.stringify(claimPathFor(f.name, auth))}) as ${t},`;
  });
  return `// Auto-generated.
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { UserClaims } from "./user-types";
import { registerUserVerifier } from "./verifier";

// Resolved from the system \`auth { oidc { … } }\` block.  Env-bound values
// read process.env at boot; an empty issuer fails loudly at first verify.
const ISSUER = ${issuerExpr};${audienceConst}

// Lazily discover the issuer's JWKS endpoint via the OIDC discovery
// document, then cache a remote JWK set (jose refreshes + caches keys).
// Only a SUCCESSFUL discovery is cached: a failed fetch resets the slot so
// the next request retries — caching the rejected promise would poison
// every later verify with a permanent 401 (e.g. one request racing the
// IdP's boot/realm import; caught live by the parity 403 test).
let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;
async function getJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (!jwksPromise) {
    jwksPromise = (async () => {
      const base = ISSUER.replace(/\\/$/, "");
      const res = await fetch(\`\${base}/.well-known/openid-configuration\`);
      if (!res.ok) throw new Error(\`OIDC discovery failed: \${res.status}\`);
      const doc = (await res.json()) as { jwks_uri: string };
      return createRemoteJWKSet(new URL(doc.jwks_uri));
    })();
    jwksPromise.catch(() => {
      jwksPromise = null;
    });
  }
  return jwksPromise;
}

/** Extract a bearer token from the Authorization header. */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\\s+(.+)$/i.exec(header);
  return match ? match[1]! : null;
}

/** Read a dotted claim path (e.g. \`realm_access.roles\`) off a payload. */
function claim(payload: JWTPayload, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, payload);
}

/** Project verified claims onto the typed claim shape.  The auth middleware
 *  derives the request principal (incl. \`orgPath\` under tenancy) from this. */
function toUser(payload: JWTPayload): UserClaims {
  return {
${toUserLines.join("\n")}
  };
}

/** Generated OIDC verifier — validates signature (JWKS), issuer, and
 *  audience, then maps claims onto User.  Returns null to reject (→ 401). */
export const oidcVerifier = async (req: Request): Promise<UserClaims | null> => {
  const token = bearer(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, await getJwks(), ${verifyOptions});
    return toUser(payload);
  } catch {
    return null;
  }
};

/** Register the generated verifier.  Called from index.ts at boot,
 *  BEFORE \`serve(...)\`.  Override by registering your own afterwards. */
export function registerOidcVerifier(): void {
  registerUserVerifier(oidcVerifier);
}
`;
}

// ---------------------------------------------------------------------------
// OIDC redirect handshake (D-AUTH-OIDC) — /auth/login starts the
// authorization-code flow, /auth/callback exchanges the code and issues a
// local session cookie, /auth/logout clears it.  No login form: the IdP
// hosts the credential pages.
// ---------------------------------------------------------------------------

function renderHandshake(auth?: AuthIR): string {
  // `/auth/me` (the session probe the frontend guard reads) is always
  // emitted when a backend has auth — it works for both the OIDC verifier
  // and the dev stub.  The OIDC redirect handshake (login/callback/logout)
  // is added only when an `auth { oidc }` block is present; the dev-stub
  // path (e.g. the in-browser playground, where no IdP is reachable) has
  // no IdP to redirect to.
  const meRoute = `  // Session probe for the frontend guard — NOT bypassed, so the auth
  // middleware has already verified the principal (or returned 401) by
  // the time this runs.  Returns the resolved User as plain JSON.
  app.get("/me", (c) => {
    const user = (c as unknown as { get(k: "currentUser"): unknown }).get("currentUser");
    return c.json(user ?? null);
  });`;

  if (!auth) {
    return `// Auto-generated.
import { Hono } from "hono";

/** Auth session routes.  Mounted at "/auth" by createApp. */
export function authRoutes(): Hono {
  const app = new Hono();

${meRoute}

  return app;
}
`;
  }

  // Env override first (12-factor) — same contract as the verifier's ISSUER:
  // the generated compose repoints OIDC_ISSUER at the bundled dev Keycloak.
  const issuerExpr = envOverridableExpr("OIDC_ISSUER", auth.oidc.issuer);
  const clientIdExpr = envOverridableExpr("OIDC_CLIENT_ID", auth.oidc.clientId);
  // A client secret is only present for confidential clients; omit the
  // const + the token-request line entirely for public (PKCE-less) ones
  // so the generated code carries no always-falsy constant.
  const hasSecret = !!auth.oidc.clientSecret;
  const clientSecretConst = hasSecret
    ? `const CLIENT_SECRET = ${authValueExpr(auth.oidc.clientSecret)};\n`
    : "";
  const secretBodyLine = hasSecret ? '\n    body.set("client_secret", CLIENT_SECRET);' : "";
  const scopes = (auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"]).join(" ");
  return `// Auto-generated.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

const ISSUER = ${issuerExpr};
const CLIENT_ID = ${clientIdExpr};
${clientSecretConst}const SCOPES = ${JSON.stringify(scopes)};
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3000${AUTH_BASE_PATH}/callback";
const POST_LOGIN = process.env.OIDC_POST_LOGIN_REDIRECT ?? "/";

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
}

let discoPromise: Promise<Endpoints> | null = null;
async function disco(): Promise<Endpoints> {
  if (!discoPromise) {
    discoPromise = (async () => {
      const base = ISSUER.replace(/\\/$/, "");
      const res = await fetch(\`\${base}/.well-known/openid-configuration\`);
      if (!res.ok) throw new Error(\`OIDC discovery failed: \${res.status}\`);
      return (await res.json()) as Endpoints;
    })();
  }
  return discoPromise;
}

/** The /auth/* redirect handshake + session probe.  Mounted at "/auth"
 *  by createApp. */
export function authRoutes(): Hono {
  const app = new Hono();

  // Start the authorization-code flow — redirect to the IdP's login page.
  app.get("/login", async (c) => {
    const { authorization_endpoint } = await disco();
    const state = randomUUID();
    setCookie(c, "oidc_state", state, { httpOnly: true, sameSite: "Lax", path: "/" });
    const url = new URL(authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  // Exchange the code for tokens and issue the local session.
  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state || state !== getCookie(c, "oidc_state")) {
      return c.json({ error: "invalid_state" }, 400);
    }
    const { token_endpoint } = await disco();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    });${secretBodyLine}
    const res = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) return c.json({ error: "token_exchange_failed" }, 401);
    const tokens = (await res.json()) as { access_token: string };
    // Session: stash the access token in an HttpOnly cookie; the SPA
    // forwards it as a Bearer that auth/oidc.ts verifies.
    setCookie(c, "session", tokens.access_token, { httpOnly: true, sameSite: "Lax", path: "/" });
    deleteCookie(c, "oidc_state", { path: "/" });
    return c.redirect(POST_LOGIN);
  });

  // Clear the local session.  The IdP's own session is ended at its
  // end-session endpoint, which the SPA can link to directly.
  app.get("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.redirect(POST_LOGIN);
  });

${meRoute}

  return app;
}
`;
}
