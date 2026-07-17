// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

/** RFC 7807 ProblemDetails body — the base 5 spec fields plus the §3.2
 *  `errors[]` extension (per-field `{ pointer, message }` array) that
 *  the runtime emits on 422 validation responses.  Consumed by the
 *  frontend ACL's `applyServerErrors` (see docs/old/proposals/frontend-acl.md).
 *  All fields nullable / optional — base 5 per the spec core; `errors` is
 *  only present on 422 validation responses.  Phase D of
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
 *  DomainError continue to emit 400 via the router's `app.onError`
 *  catch-all (different fault class, different code). */
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
