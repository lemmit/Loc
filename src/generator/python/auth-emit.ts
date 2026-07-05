import type { AuthIR, AuthValueIR, FieldIR, TypeIR, UserIR } from "../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../util/api-base.js";
import { lines } from "../../util/code-builder.js";
import { snake } from "../../util/naming.js";
import { renderPyType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Python-side auth scaffolding emitted per deployable when
// `auth: required` (and the system declares a `user { ... }` block).
// Mirrors the Hono trio (auth-emit.ts on hono/v4):
//
//   app/auth/user.py       — frozen dataclass User (claim shape; fields
//                            snake_cased like every domain shape)
//   app/auth/verifier.py   — registry + helper for the user-supplied
//                            verifier function
//   app/auth/middleware.py — Starlette middleware mounted in app/main.py
//   app/auth/routes.py     — /auth/me session probe (the `auth: ui` guard
//                            reads it; works for the verifier AND the stub)
//   app/auth/oidc.py       — (OIDC only) the PyJWT + JWKS token verifier
//                            and the /auth/login|callback|logout handshake
//
// Without an `auth { oidc }` block the user calls `register_user_verifier(fn)`
// by hand (main.py ships a permissive dev stub).  With one, the generated
// OIDC verifier is auto-registered and the handshake router mounted.  The
// middleware bypass list matches the Hono/.NET sides: /health, /ready,
// /openapi.json, /swagger (plus /auth/login|callback|logout under OIDC).
// ---------------------------------------------------------------------------

export function emitPyAuthFiles(
  user: UserIR,
  out: Map<string, string>,
  auth?: AuthIR,
  orgPathClaim?: string,
  orgPathRegistryTable?: string,
): void {
  // Hierarchy (multi-tenancy P2.2): `orgPathRegistryTable` is the tenant
  // registry's schema-qualified table when it opts into `tenantRegistry` (a
  // `data_key` column exists).  Present → `currentUser.orgPath` becomes a
  // per-request memoized read of the caller org's materialized `data_key`
  // (fail-safe fallback to the claim); absent (flat tenancy) → the P2.1
  // claim-copy `@property` stands.
  const orgPathReadsRegistry = !!orgPathRegistryTable;
  out.set("app/auth/__init__.py", "");
  out.set("app/auth/user.py", renderUserModule(user, orgPathClaim, orgPathReadsRegistry));
  out.set("app/auth/verifier.py", VERIFIER_PY);
  out.set(
    "app/auth/middleware.py",
    renderAuthMiddleware(user, !!auth, orgPathClaim, orgPathRegistryTable),
  );
  // /auth/me is emitted whenever a backend has auth — the frontend `auth: ui`
  // guard probes it, and it works for both the OIDC verifier and the dev stub.
  out.set("app/auth/routes.py", ROUTES_PY);
  if (auth) {
    out.set("app/auth/oidc.py", renderOidcModule(user, auth));
  }
}

/** Render an `AuthValueIR` (literal | env) as a Python expression, read at
 *  runtime via os.environ (an unset env → "" so a verify fails loudly). */
function pyAuthValue(v: AuthValueIR | undefined, fallback = '""'): string {
  if (!v) return fallback;
  if (v.kind === "literal") return JSON.stringify(v.value);
  return `os.environ.get(${JSON.stringify(v.env)}, "")`;
}

/** The IdP claim path projected onto a user field — explicit `claims:` wins;
 *  else `id` → `sub`, every other field reads its own snake name.  Mirrors the
 *  Hono / .NET / Phoenix `claimPathFor`. */
function claimPathFor(field: string, auth: AuthIR): string {
  const mapped = auth.claims.find((c) => c.field === field);
  if (mapped) return mapped.path;
  return field === "id" ? "sub" : snake(field);
}

/** Python kwargs for the dev-stub User — same defaults as Hono's
 *  `renderStubUserLiteral` (string claims "admin", arrays EMPTY — so
 *  permission-guarded surfaces deny by default — optionals None). */
export function renderPyStubUserKwargs(user: UserIR): string {
  return user.fields.map((f) => `${snake(f.name)}=${stubValueFor(f)}`).join(", ");
}

function stubValueFor(f: FieldIR): string {
  if (f.optional) return "None";
  return stubValueForType(f.type);
}

function stubValueForType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "string":
          return '"admin"';
        case "int":
        case "long":
          return "0";
        case "decimal":
          return "0.0";
        case "money":
          return 'Decimal("0")';
        case "bool":
          return "False";
        case "datetime":
          return "datetime.fromtimestamp(0, tz=UTC)";
        case "guid":
          return '"00000000-0000-0000-0000-000000000000"';
        default:
          return '""';
      }
    case "id":
      return `${t.targetName}Id("00000000-0000-0000-0000-000000000000")`;
    case "array":
      return "[]";
    default:
      return "None";
  }
}

function renderUserModule(
  user: UserIR,
  orgPathClaim?: string,
  orgPathReadsRegistry = false,
): string {
  const fields = user.fields.map((f) => {
    const t = renderPyType(f.optional ? { kind: "optional", inner: f.type } : f.type);
    return `    ${snake(f.name)}: ${t}`;
  });
  // Derived `currentUser.orgPath` — the caller's tenant materialized path
  // (multi-tenancy Phase 2).  Two shapes, both keeping it OFF `asdict()` /
  // the `/auth/me` wire (derived, not a claim) and untouched by every
  // construction site (the verifier never sets it):
  //
  //  - flat tenancy (P2.1): a computed `@property` deriving the root-segment
  //    path from the tenancy claim, null-safely.
  //  - hierarchy (P2.2): a bare class attribute (NOT a dataclass field, so
  //    `asdict()` skips it) that the auth middleware resolves ONCE per request
  //    from the registry's `data_key` column and writes back via
  //    `object.__setattr__` (this dataclass is frozen).  The read is memoized
  //    on the principal — `require_current_user().org_path` returns the
  //    resolved path — and falls back to the claim when the row/dataKey is
  //    absent.  Defaults to "" until the middleware resolves it.
  const orgPathProp = !orgPathClaim
    ? []
    : orgPathReadsRegistry
      ? [
          "",
          "    # The caller's tenant materialized path (`currentUser.orgPath`),",
          "    # resolved once per request by the auth middleware from the tenant",
          "    # registry's `data_key` column and stored here via",
          "    # object.__setattr__ (this dataclass is frozen).  A bare class",
          "    # attribute — NOT a dataclass field — so asdict()/the /auth/me wire",
          "    # never serializes it (multi-tenancy Phase 2, P2.2).",
          '    org_path = ""',
        ]
      : [
          "",
          "    @property",
          "    def org_path(self) -> str:",
          '        """The caller\'s tenant materialized path (`currentUser.orgPath`) —',
          '        derived per-request from the tenancy claim (multi-tenancy Phase 2, P2.1)."""',
          `        return "" if self.${snake(orgPathClaim)} is None else str(self.${snake(orgPathClaim)})`,
        ];
  // Id-typed claims (`Customer id?`) reference the branded NewTypes.
  const idNames = [
    ...new Set(
      user.fields.flatMap((f) => {
        const t = f.type.kind === "optional" ? f.type.inner : f.type;
        return t.kind === "id" ? [`${t.targetName}Id`] : [];
      }),
    ),
  ].sort();
  return lines(
    '"""User-claim shape decoded from the inbound JWT.  Auto-generated.',
    "",
    "The verifier hook (app/auth/verifier.py) returns this exact shape;",
    "downstream route handlers / workflow handlers / find filters reference",
    "it via the magic `currentUser` identifier.",
    "",
    "Also hosts the ambient principal carrier: the auth middleware stashes the",
    "verified User in `current_user_var` (a module-level ContextVar) alongside",
    "request.state.current_user, and `require_current_user()` reads it from any",
    "layer — so an always-on principal capability filter can scope every read",
    "without threading the principal as a method parameter (the SQLAlchemy",
    "analogue of node's `requireCurrentUser()`).  Fail-closed: an unauthenticated",
    "read raises, never leaks cross-tenant rows.",
    '"""',
    "",
    "from contextvars import ContextVar",
    "from dataclasses import dataclass",
    "",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    idNames.length > 0 ? "" : null,
    "",
    "@dataclass(frozen=True)",
    "class User:",
    ...fields,
    ...orgPathProp,
    "",
    "",
    "# Ambient principal carrier — set by AuthMiddleware on every authenticated",
    "# request, reset in its finally so it never leaks across requests.",
    "current_user_var: ContextVar[User | None] = ContextVar(",
    '    "loom_current_user", default=None',
    ")",
    "",
    "",
    "def current_user() -> User | None:",
    '    """The ambient verified principal for the current request, or None outside',
    '    an authenticated request."""',
    "    return current_user_var.get()",
    "",
    "",
    "def require_current_user() -> User:",
    '    """The ambient verified principal — raises PermissionError when unset',
    "    (fail-closed: a principal-scoped read with no authenticated principal is",
    '    rejected, never served unscoped)."""',
    "    user = current_user_var.get()",
    "    if user is None:",
    '        raise PermissionError("unauthorized")',
    "    return user",
    "",
  );
}

const VERIFIER_PY = `"""User-verifier registry.  Auto-generated.

Implement a verifier that decodes the inbound request's JWT and returns
a populated User on success (or None to reject with a 401), then
register it at app startup, BEFORE serving:

    from app.auth.verifier import register_user_verifier
    register_user_verifier(my_verifier)
"""

from collections.abc import Awaitable, Callable

from fastapi import Request

from app.auth.user import User

UserVerifier = Callable[[Request], Awaitable[User | None]]

_registered: UserVerifier | None = None


def register_user_verifier(fn: UserVerifier) -> None:
    """Register the verifier.  Calling more than once overwrites."""
    global _registered
    _registered = fn


async def verify_user_or_throw(request: Request) -> User:
    """Internal — called by the middleware on every authenticated request."""
    if _registered is None:
        raise RuntimeError(
            "No user verifier is registered.  Call register_user_verifier(...) "
            "with a function that decodes the request's JWT into a User "
            "before serving."
        )
    result = await _registered(request)
    if result is None:
        raise PermissionError("unauthorized")
    return result


def assert_user_verifier_registered() -> None:
    """Verify the verifier was registered.  The app lifespan calls this at
    startup so a missing registration surfaces as a clear error instead of
    a 401 storm on the first request."""
    if _registered is None:
        raise RuntimeError(
            "No user verifier is registered.  Call register_user_verifier(...) "
            "with a JWT-decoding function before booting the HTTP server."
        )
`;

/** The principal's id key — the claim named `id`, else the first declared
 *  field.  Stamped into the RequestContext carrier (only the id rides the
 *  carrier; the full principal stays on request.state.current_user). */
export function actorIdAttr(user: UserIR): string | null {
  const field = user.fields.find((f) => f.name === "id") ?? user.fields[0];
  return field ? snake(field.name) : null;
}

function renderAuthMiddleware(
  user: UserIR,
  oidc: boolean,
  orgPathClaim?: string,
  orgPathRegistryTable?: string,
): string {
  const idAttr = actorIdAttr(user);
  // Hierarchy (multi-tenancy P2.2): resolve `currentUser.orgPath` from the
  // tenant registry's `data_key` once per request (fail-safe to the claim).
  // Unlike the Hono auth layer (which can't reach the db and registers a
  // boot-time resolver closure), the Starlette middleware can import the
  // module-level `session_factory`, so the lookup lives right here.
  const hierarchy = !!orgPathRegistryTable && !!orgPathClaim;
  const claimAttr = orgPathClaim ? snake(orgPathClaim) : null;
  // Under OIDC the /auth/login|callback|logout redirect handlers must be
  // reachable without a verified principal — bypass them.  /auth/me is NOT
  // bypassed (the guard reads the verified user).
  const bypass = oidc
    ? `("/health", "/ready", "/openapi.json", "/swagger", "${AUTH_BASE_PATH}/login", "${AUTH_BASE_PATH}/callback", "${AUTH_BASE_PATH}/logout")`
    : '("/health", "/ready", "/openapi.json", "/swagger")';
  // The per-request registry `data_key` resolver (hierarchy only).  A fresh
  // session per lookup; `SELECT data_key … WHERE id = :claim LIMIT 1`; a
  // missing row / NULL `data_key` / any error (e.g. a non-matching dev-stub
  // claim) falls back to the claim itself — the documented root-segment
  // fallback that never crashes a request.
  const resolver = hierarchy
    ? [
        "",
        "",
        "async def _resolve_org_path(claim: str) -> str:",
        '    """The caller org\'s materialized path (`currentUser.orgPath`): the tenant',
        "    registry's `data_key` for the tenancy claim, else the claim itself",
        "    (root-segment fallback).  Memoized — the middleware calls this once per",
        '    request and stores the result on the principal (multi-tenancy P2.2)."""',
        "    if not claim:",
        "        return claim",
        "    try:",
        "        async with session_factory() as session:",
        "            result = await session.execute(",
        `                text("SELECT data_key FROM ${orgPathRegistryTable} WHERE id = :claim LIMIT 1"),`,
        '                {"claim": claim},',
        "            )",
        "            data_key = result.scalar_one_or_none()",
        "        return data_key if isinstance(data_key, str) else claim",
        "    except Exception:",
        "        return claim",
      ]
    : [];
  return lines(
    '"""Auth middleware.  Auto-generated.',
    "",
    "Decodes the request's JWT into a User (via the registered verifier) and",
    "stashes it on the request scope as `request.state.current_user`, then",
    "stamps the principal id into the ambient RequestContext carrier.  The",
    "bypass list matches the Hono/.NET sides — framework endpoints stay",
    "anonymous so smoke tests + the OpenAPI cross-check don't need tokens.",
    '"""',
    "",
    "from fastapi import Request, Response",
    "from fastapi.responses import JSONResponse",
    hierarchy ? "from sqlalchemy import text" : null,
    "from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint",
    "",
    "from app.auth.user import current_user_var",
    "from app.auth.verifier import verify_user_or_throw",
    hierarchy ? "from app.db.engine import session_factory" : null,
    "from app.obs.log import set_actor_id",
    "",
    `BYPASS_PREFIXES = ${bypass}`,
    ...resolver,
    "",
    "",
    "class AuthMiddleware(BaseHTTPMiddleware):",
    "    async def dispatch(",
    "        self, request: Request, call_next: RequestResponseEndpoint",
    "    ) -> Response:",
    "        path = request.url.path",
    "        for prefix in BYPASS_PREFIXES:",
    "            if path.startswith(prefix):",
    "                return await call_next(request)",
    "        try:",
    "            user = await verify_user_or_throw(request)",
    "        except Exception:",
    '            return JSONResponse({"error": "unauthorized"}, status_code=401)',
    // Hierarchy (P2.2): resolve the caller's tenant materialized path once and
    // store it on the (frozen) principal, so `currentUser.orgPath` reads a
    // memoized value rather than recomputing per access.
    ...(hierarchy && claimAttr
      ? [
          `        _claim = "" if user.${claimAttr} is None else str(user.${claimAttr})`,
          '        object.__setattr__(user, "org_path", await _resolve_org_path(_claim))',
        ]
      : []),
    "        request.state.current_user = user",
    ...(idAttr ? [`        set_actor_id(str(user.${idAttr}))`] : []),
    "        # Stash the full principal in the ambient carrier so always-on",
    "        # principal capability filters can scope reads without a method param;",
    "        # reset in finally so it never leaks across requests.",
    "        token = current_user_var.set(user)",
    "        try:",
    "            return await call_next(request)",
    "        finally:",
    "            current_user_var.reset(token)",
    "",
  );
}

// ---------------------------------------------------------------------------
// /api/auth/me session probe — emitted whenever a backend has auth.  Returns
// the verified principal the middleware stamped onto request.state (the
// `auth: ui` frontend guard reads it); works for the verifier AND the stub.
// Mounted under the shared API base (`/api/auth`), same origin as the domain
// routes — the frontend probes `${API_BASE_URL}/auth/me`.
// ---------------------------------------------------------------------------

const ROUTES_PY = `"""Auth session-probe route.  Auto-generated.

GET /api/auth/me echoes the verified current_user (the \`auth: ui\` frontend
guard reads it).  Runs through AuthMiddleware, so the principal is verified (or
the request 401'd) before this handler sees it.
"""

from dataclasses import asdict

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.auth.user import User

router = APIRouter(prefix="${AUTH_BASE_PATH}", tags=["auth"])


# include_in_schema=False — auth endpoints are not business operations, so they
# stay out of the OpenAPI contract (cross-backend parity: .NET excludes via
# ExcludeFromDescription, Java via @Hidden, Hono never adds them to its spec).
@router.get("/me", include_in_schema=False)
async def me(request: Request) -> JSONResponse:
    user: User | None = getattr(request.state, "current_user", None)
    return JSONResponse(asdict(user) if user is not None else None)
`;

// ---------------------------------------------------------------------------
// OIDC verifier + redirect handshake (D-AUTH-OIDC).  PyJWT validates the
// bearer token's signature against the issuer's JWKS (discovered + cached via
// PyJWKClient), checks iss / exp / aud, and maps the configured claims onto the
// typed User.  The handshake router runs the authorization-code flow.  Config
// is read at runtime from os.environ (issuer read lazily — a module attribute
// would freeze the empty import-time env).  PyJWKClient / urllib impose no
// https requirement, so a plain-http dev issuer (the bundled Keycloak) works.
// ---------------------------------------------------------------------------

function renderBuildUserKwargs(user: UserIR, auth: AuthIR): string {
  return user.fields
    .map((f) => {
      const key = snake(f.name);
      const pyType = renderPyType(f.optional ? { kind: "optional", inner: f.type } : f.type);
      const path = claimPathFor(f.name, auth);
      const isArray =
        f.type.kind === "array" || (f.type.kind === "optional" && f.type.inner.kind === "array");
      const read = isArray
        ? `_claim(payload, ${JSON.stringify(path)}) or []`
        : `_claim(payload, ${JSON.stringify(path)})`;
      return `        ${key}=cast(${pyType}, ${read}),`;
    })
    .join("\n");
}

function renderOidcModule(user: UserIR, auth: AuthIR): string {
  // Env override first (12-factor): the generated compose repoints
  // OIDC_ISSUER at the bundled dev Keycloak, so a literal issuer must not
  // be baked un-overridably — with it baked, every token from the bundled
  // IdP fails `iss` validation (401, caught live by the parity 403 test).
  // A declared env-kind value reading the same var stays a single read.
  const pyEnvOverridable = (envVar: string, v: AuthValueIR | undefined): string =>
    v?.kind === "env" && v.env === envVar
      ? pyAuthValue(v)
      : `os.environ.get(${JSON.stringify(envVar)}) or ${pyAuthValue(v)}`;
  const issuerExpr = pyEnvOverridable("OIDC_ISSUER", auth.oidc.issuer);
  const clientIdExpr = pyEnvOverridable("OIDC_CLIENT_ID", auth.oidc.clientId);
  // A public client has no secret: default to the env read (None when unset)
  // so the token exchange omits client_secret rather than sending "".
  const clientSecretExpr = auth.oidc.clientSecret
    ? pyAuthValue(auth.oidc.clientSecret)
    : `os.environ.get("OIDC_CLIENT_SECRET")`;
  const scopes = (auth.oidc.scopes.length ? auth.oidc.scopes : ["openid"]).join(" ");
  const buildUser = renderBuildUserKwargs(user, auth);
  return `"""Generated OIDC verifier + redirect handshake (D-AUTH-OIDC).  Auto-generated.

Validates the inbound JWT against the issuer's JWKS and maps the configured
claims onto User; the handshake router runs the authorization-code flow and
issues the HttpOnly \`session\` cookie the verifier reads.  Loom owns no auth
runtime beyond "validate a token / drive the redirect" — the IdP owns the rest.
"""

import json
import os
import secrets
import urllib.parse
import urllib.request
from typing import Any, cast

import jwt
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from app.auth.user import User
from app.auth.verifier import register_user_verifier

_SCOPES = ${JSON.stringify(scopes)}
_AUDIENCE = ${auth.oidc.audience ? pyEnvOverridable("OIDC_AUDIENCE", auth.oidc.audience) : 'os.environ.get("OIDC_AUDIENCE")'}


def _issuer() -> str:
    return (${issuerExpr}).rstrip("/")


def _client_id() -> str:
    return ${clientIdExpr}


def _client_secret() -> str | None:
    return ${clientSecretExpr}


def _redirect_uri() -> str:
    return os.environ.get("OIDC_REDIRECT_URI", "http://localhost:8000${AUTH_BASE_PATH}/callback")


def _post_login() -> str:
    return os.environ.get("OIDC_POST_LOGIN_REDIRECT", "/")


def _get_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url) as resp:
        return cast(dict[str, Any], json.loads(resp.read()))


def _discovery() -> dict[str, Any]:
    return _get_json(_issuer() + "/.well-known/openid-configuration")


_jwk_client: jwt.PyJWKClient | None = None


def _jwks_client() -> jwt.PyJWKClient:
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = jwt.PyJWKClient(cast(str, _discovery()["jwks_uri"]))
    return _jwk_client


def _claim(payload: dict[str, Any], path: str) -> Any:
    current: Any = payload
    for segment in path.split("."):
        if isinstance(current, dict) and segment in current:
            current = current[segment]
        else:
            return None
    return current


def _token_from(request: Request) -> str | None:
    header = request.headers.get("authorization")
    if header is not None and header.lower().startswith("bearer "):
        return header[7:]
    cookie = request.cookies.get("session")
    return cookie if cookie else None


async def _oidc_verifier(request: Request) -> User | None:
    token = _token_from(request)
    if token is None:
        return None
    try:
        signing_key = _jwks_client().get_signing_key_from_jwt(token)
        payload: dict[str, Any] = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384"],
            issuer=_issuer(),
            audience=_AUDIENCE,
            options={"verify_aud": _AUDIENCE is not None},
        )
    except Exception:
        return None
    return User(
${buildUser}
    )


def register_oidc_verifier() -> None:
    """Register the generated verifier.  Called from main.py at startup."""
    register_user_verifier(_oidc_verifier)


router = APIRouter(prefix="${AUTH_BASE_PATH}", tags=["auth"])


@router.get("/login", include_in_schema=False)
async def login() -> RedirectResponse:
    authorize = cast(str, _discovery()["authorization_endpoint"])
    state = secrets.token_urlsafe(16)
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": _client_id(),
            "redirect_uri": _redirect_uri(),
            "scope": _SCOPES,
            "state": state,
        }
    )
    response = RedirectResponse(authorize + "?" + query)
    response.set_cookie("oidc_state", state, httponly=True, samesite="lax")
    return response


@router.get("/callback", include_in_schema=False)
async def callback(request: Request) -> Response:
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    if not code or not state or state != request.cookies.get("oidc_state"):
        return JSONResponse({"error": "invalid_state"}, status_code=400)
    token = _exchange_code(code)
    if token is None:
        return JSONResponse({"error": "token_exchange_failed"}, status_code=401)
    response: Response = RedirectResponse(_post_login())
    response.set_cookie("session", token, httponly=True, samesite="lax")
    response.delete_cookie("oidc_state")
    return response


@router.get("/logout", include_in_schema=False)
async def logout() -> RedirectResponse:
    response = RedirectResponse(_post_login())
    response.delete_cookie("session")
    return response


def _exchange_code(code: str) -> str | None:
    form: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": _redirect_uri(),
        "client_id": _client_id(),
    }
    secret = _client_secret()
    if secret:
        form["client_secret"] = secret
    data = urllib.parse.urlencode(form).encode()
    headers = {"content-type": "application/x-www-form-urlencoded"}
    token_request = urllib.request.Request(
        cast(str, _discovery()["token_endpoint"]), data=data, headers=headers
    )
    try:
        with urllib.request.urlopen(token_request) as resp:
            doc = cast(dict[str, Any], json.loads(resp.read()))
    except Exception:
        return None
    access = doc.get("access_token")
    return access if isinstance(access, str) else None
`;
}
