// Auto-generated.  Do not edit by hand.
import { z } from "zod";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";

/** RFC 7807 ProblemDetails body — the base shape (5 fields per the spec
 *  core).  Hono's runtime additionally emits an `errors[]` extension
 *  (RFC 7807 §3.2) on 422 validation responses — consumed by the
 *  frontend ACL's `applyServerErrors` — but that field is intentionally
 *  NOT advertised here in the OpenAPI component schema until .NET +
 *  Phoenix catch up (Phase B + C of validation-error-extension.md), so
 *  the cross-backend parity gate (`test/_helpers/openapi-normalize.ts`)
 *  keeps `fieldSet("ProblemDetails")` byte-equal across all three.
 *  All fields nullable / optional, matching the base spec. */
export const ProblemDetails = z.object({
  type: z.string().nullish(),
  title: z.string().nullish(),
  status: z.number().int().nullish(),
  detail: z.string().nullish(),
  instance: z.string().nullish(),
}).openapi("ProblemDetails");

/** RFC 6901 JSON pointer from a Zod issue path.  Empty path → empty
 *  pointer (`""`, "the whole document").  Segments are slash-joined;
 *  literal `~` and `/` inside a segment are escaped to `~0` / `~1`. */
function pointerOf(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return "";
  return "/" + path.map((seg) =>
    typeof seg === "number"
      ? String(seg)
      : seg.replace(/~/g, "~0").replace(/\//g, "~1"),
  ).join("/");
}

/** Default Zod-validation hook.  When a route's request validator
 *  rejects input, this fires before the handler runs and produces a 422
 *  ProblemDetails with the per-field `errors[]` extension.  The shape
 *  is the contract consumed by the frontend ACL — see
 *  docs/proposals/frontend-acl.md and apply-server-errors.ts in the
 *  generated React project.
 *
 *  Validation failures get 422 (Unprocessable Entity, RFC 7807 standard
 *  for input-shape errors).  Domain-rule violations carried by
 *  DomainError continue to emit 400 via the router's `app.onError`
 *  catch-all (different fault class, different code). */
export function defaultHook(result: { success: boolean; error?: { issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }> } }, c: Context): Response | undefined {
  if (result.success) return undefined;
  const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";
  const errors = (result.error?.issues ?? []).map((issue) => ({
    pointer: pointerOf(issue.path),
    message: issue.message,
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
