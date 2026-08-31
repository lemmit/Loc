// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/** RFC 7807 ProblemDetails body — the base 5 spec fields plus the §3.2
 *  `errors[]` extension (per-field `{ pointer, message }` array) that
 *  the runtime emits on 422 validation responses.  Consumed by the
 *  frontend ACL's `applyServerErrors` (see docs/old/proposals/frontend-acl.md).
 *  All fields nullable / optional — base 5 per the spec core; `errors` is
 *  only present on 422 validation responses.  See
 *  docs/old/proposals/validation-error-extension.md — all three backends
 *  (Hono / .NET / Phoenix) declare the same shape in lockstep so the
 *  cross-backend parity gate stays green. */
export const ProblemDetails = z.object({
  type: z.string().nullish(),
  title: z.string().nullish(),
  status: z.number().int().nullish(),
  detail: z.string().nullish(),
  instance: z.string().nullish(),
  errors: z.array(z.object({ pointer: z.string(), message: z.string(), code: z.string().nullish() })).nullish(),
}).openapi("ProblemDetails");

/** RFC 6901 JSON pointer from a Zod issue path.  Empty path → empty
 *  pointer (`""`, "the whole document").  Segments are slash-joined;
 *  literal `~` and `/` inside a segment are escaped to `~0` / `~1`. */
function pointerOf(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return "";
  return "/" + path.map((seg) =>
    typeof seg === "string"
      ? seg.replace(/~/g, "~0").replace(/\//g, "~1")
      : String(seg),
  ).join("/");
}

/** Default Zod-validation hook.  When a route's request validator
 *  rejects input, this fires before the handler runs and produces a 422
 *  ProblemDetails with the per-field `errors[]` extension.  The shape
 *  is the contract consumed by the frontend ACL — see
 *  docs/old/proposals/frontend-acl.md and apply-server-errors.ts in the
 *  generated React project.
 *
 *  Validation failures get 422 (Unprocessable Entity, RFC 7807 standard
 *  for input-shape errors).  Domain-rule violations carried by
 *  DomainError ALSO emit 422 via the router's `app.onError` catch-all:
 *  both are well-formed requests the
 *  server refuses on SEMANTIC grounds, which is what RFC 9110 reserves 422
 *  for, and it makes the denial ladder identical on all five backends.  400
 *  stays for a genuinely malformed/unparseable request. */
export function defaultHook(result: { success: boolean; error?: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; params?: { loomCode?: string } }> } }, c: Context): Response | undefined {
  if (result.success) return undefined;
  const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
  const errors = (result.error?.issues ?? []).map((issue) => ({
    pointer: pointerOf(issue.path),
    message: issue.message,
    // A messaged invariant/precondition carries a stable content-hash code (via
    // the refine's params.loomCode) so a client can localise the error;
    // structural zod errors (type/min) have none.
    ...(issue.params?.loomCode ? { code: issue.params.loomCode } : {}),
  }));
  return c.body(
    JSON.stringify({
      type: "about:blank",
      title: "Validation failed",
      status: 422,
      detail: "One or more fields are invalid.",
      instance: c.req.path,
      errors,
    }),
    422,
    { "content-type": "application/problem+json", "x-request-id": trace_id },
  );
}

/** Factory: `new OpenAPIHono()` with the validation `defaultHook` pre-wired.
 *  Routers import this instead of constructing OpenAPIHono directly so the
 *  hook is always installed without per-router boilerplate. */
export function newApp(): OpenAPIHono {
  return new OpenAPIHono({ defaultHook });
}

/** Reason phrases (RFC 9110 §15 / the IANA registry) for the statuses THIS
 *  layer raises: 404 and 500 directly, plus the ones a hono `HTTPException`
 *  carries through `frameworkProblem` (a malformed body, a method mismatch)
 *  and the authz ladder's 401/403/409/422.
 *
 *  This used to read node's `STATUS_CODES`, on the reasoning that a hand-kept
 *  map would silently mistitle a status it missed — right for a node
 *  deployment, wrong everywhere else this backend runs.  The playground boots
 *  the SAME bundle in a browser worker, where `node:http` resolves to an EMPTY
 *  module: `STATUS_CODES[status]` then threw inside the one helper whose job is
 *  turning a fault into a problem document, so every 404/422/500 took the worker
 *  down instead of answering.
 *
 *  The values are node's verbatim.  A status outside this set falls back to
 *  "Error", as node's own table does for a code it doesn't carry. */
const REASON_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
};

/** RFC 7807 body for a fault the FRAMEWORK raised — one no domain error class
 *  describes: an unmatched route, a body hono itself refused to parse, an
 *  aborted request.  Without it such a fault leaves the wire two ways: never
 *  reaching a router (hono's default `text/plain` 404), or reaching one and
 *  falling past every domain arm into the generic 500 — reporting a CLIENT
 *  fault as a server fault.  Both are a second error contract on a wire that
 *  already committed to `application/problem+json`.  Shared by http/index.ts's
 *  root handlers and every router's `HTTPException` arm so they can't drift. */
export function frameworkProblemBody(status: number, detail: string, instance: string): string {
  const title = REASON_PHRASES[status] ?? "Error";
  return JSON.stringify({ type: "about:blank", title, status, detail, instance });
}

/** Hono's OWN `json` media-type predicate (`hono/validator/validator.ts`'s
 *  `jsonRegex`), mirrored character-for-character apart from two redundant
 *  escapes Biome rejects (`[a-z-\.]` → `[a-z-.]`, `\=` → `=`; both match
 *  identically).  It has to be the SAME test: the zod validator runs only when
 *  this matches, so any wider guard would wave through a request whose body was
 *  never validated — which is exactly the fault below.  Re-check it when the
 *  pinned hono minor moves. */
const JSON_MEDIA_TYPE = /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9\-]+=([^;]+))*$/;

/** Media-type gate for a body-carrying route — RFC 9110 §15.5.16.
 *
 *  Hono's zod validator is CONTENT-TYPE GATED: with an absent or foreign
 *  `Content-Type` it silently skips validation instead of failing it, so the
 *  shared 422 `defaultHook` never fires and `c.req.valid("json")` hands the
 *  handler `undefined` — which then dereferences it and 500s (schemathesis
 *  F1).  A skipped validator must therefore be an explicit refusal, not a
 *  fall-through: every body-carrying handler calls this FIRST.
 *
 *  415 is the declared answer (`src/ir/util/openapi-errors.ts` puts it in the
 *  create / operation / workflow response set on all five backends, matching
 *  what ASP.NET, Spring and Plug.Parsers already answer), so the published
 *  contract covers it.  Thrown rather than returned so the router's existing
 *  `HTTPException` arm renders it as the same `application/problem+json` body
 *  every other framework fault uses. */
export function requireJsonContentType(c: Context): void {
  const contentType = c.req.header("Content-Type");
  if (contentType && JSON_MEDIA_TYPE.test(contentType)) return;
  throw new HTTPException(415, { message: "Content-Type must be application/json" });
}
