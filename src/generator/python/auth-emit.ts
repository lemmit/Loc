import type { FieldIR, TypeIR, UserIR } from "../../ir/types/loom-ir.js";
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
//
// The user calls `register_user_verifier(fn)` before serving.  The
// middleware bypass list matches the Hono/.NET sides exactly:
// /health, /ready, /openapi.json, /swagger.
// ---------------------------------------------------------------------------

export function emitPyAuthFiles(user: UserIR, out: Map<string, string>): void {
  out.set("app/auth/__init__.py", "");
  out.set("app/auth/user.py", renderUserModule(user));
  out.set("app/auth/verifier.py", VERIFIER_PY);
  out.set("app/auth/middleware.py", MIDDLEWARE_PY);
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

function renderUserModule(user: UserIR): string {
  const fields = user.fields.map((f) => {
    const t = renderPyType(f.optional ? { kind: "optional", inner: f.type } : f.type);
    return `    ${snake(f.name)}: ${t}`;
  });
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
    '"""',
    "",
    "from dataclasses import dataclass",
    "",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    idNames.length > 0 ? "" : null,
    "",
    "@dataclass(frozen=True)",
    "class User:",
    ...fields,
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

const MIDDLEWARE_PY = `"""Auth middleware.  Auto-generated.

Decodes the request's JWT into a User (via the registered verifier) and
stashes it on the request scope as \`request.state.current_user\`.  The
bypass list matches the Hono/.NET sides — framework endpoints stay
anonymous so smoke tests + the OpenAPI cross-check don't need tokens.
"""

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from app.auth.verifier import verify_user_or_throw

BYPASS_PREFIXES = ("/health", "/ready", "/openapi.json", "/swagger")


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        path = request.url.path
        for prefix in BYPASS_PREFIXES:
            if path.startswith(prefix):
                return await call_next(request)
        try:
            user = await verify_user_or_throw(request)
        except Exception:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        request.state.current_user = user
        return await call_next(request)
`;
