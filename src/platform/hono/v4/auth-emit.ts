import { renderTsType } from "../../../generator/typescript/render-expr.js";
import type { SystemIR, UserIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// Hono-side auth scaffolding emitted per deployable when `auth: required`.
// Three small files:
//
//   auth/user-types.ts — strongly-typed User shape (matches the C#
//                        record one-for-one; cross-platform contract
//                        check verifies)
//   auth/verifier.ts   — registry + helper for the user-supplied
//                        verifier function
//   auth/middleware.ts — Hono middleware mounted in http/index.ts
//
// The user calls `registerUserVerifier(fn)` from index.ts (or wherever
// they boot the app) BEFORE `serve(...)` runs.  The middleware bypass
// list mirrors the .NET side: /health, /openapi.json, /swagger.
// ---------------------------------------------------------------------------

export function emitAuthFiles(sys: SystemIR, out: Map<string, string>): void {
  if (!sys.user) return;
  out.set("auth/user-types.ts", renderUserTypes(sys.user));
  out.set("auth/verifier.ts", renderVerifier());
  out.set("auth/middleware.ts", renderMiddleware(sys.user));
}

/** The principal's id key — the claim named `id`, else the first declared
 *  field.  Stamped onto the carrier as `actorId` (the who-computed slice
 *  audit / provenance read); only the id rides it, the full principal stays
 *  on `currentUser`. */
function actorIdField(user: UserIR): string | null {
  const field = user.fields.find((f) => f.name === "id") ?? user.fields[0];
  return field ? field.name : null;
}

function renderUserTypes(user: UserIR): string {
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
  return (
    lines(
      "// Auto-generated.",
      "// User-claim shape decoded from the inbound JWT.  The verifier",
      "// hook (auth/verifier.ts) returns this exact shape; downstream",
      "// route handlers / workflow handlers / view binds reference it",
      "// via the magic `currentUser` identifier.",
      "export interface User {",
      ...fields,
      "}",
    ) + "\n"
  );
}

function renderVerifier(): string {
  return `// Auto-generated.
import type { User } from "./user-types";

/** Verifier hook the user implements: decode the inbound request's
 *  JWT, return a populated User on success, return null (or throw)
 *  to reject with a 401.  Register your implementation at app
 *  startup, BEFORE calling \`serve(...)\`. */
export type UserVerifier = (req: Request) => Promise<User | null> | User | null;

let registered: UserVerifier | null = null;

/** Register the verifier.  Calling more than once overwrites. */
export function registerUserVerifier(fn: UserVerifier): void {
  registered = fn;
}

/** Internal — called by the middleware on every authenticated request. */
export async function verifyUserOrThrow(req: Request): Promise<User> {
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

function renderMiddleware(user: UserIR): string {
  const idField = actorIdField(user);
  const stampActorId = idField ? `\n  if (ctx) ctx.actorId = String(user.${idField});` : "";
  return `// Auto-generated.
import { createMiddleware } from "hono/factory";
import { requestContext } from "../obs/als";
import type { User } from "./user-types";
import { verifyUserOrThrow } from "./verifier";

const BYPASS_PREFIXES = ["/health", "/ready", "/openapi.json", "/swagger"] as const;

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
  let user: User;
  try {
    user = await verifyUserOrThrow(c.req.raw);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
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
