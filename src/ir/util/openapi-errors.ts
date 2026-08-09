// Canonical per-operation error-response matrix — the single source of
// truth for which RFC 7807 error responses each backend declares on each
// operation.  Every backend (Hono / .NET / Phoenix) renders the SAME
// status set per operation kind so the conformance gate's per-operation
// error-response dimension compares equal.
//
// The body of every declared error response is the shared `ProblemDetails`
// schema (RFC 7807 core: `type`, `title`, `status`, `detail`, `instance`,
// plus the §3.2 `errors[]` extension array on 422 validation responses)
// served as `application/problem+json`.  Trace correlation rides on the
// `x-request-id` response header (not the body), so the body stays
// byte-identical across backends.
//
// The matrix is deterministic from route shape, with one auth-conditional
// dimension: an operation / workflow carrying a `requires` guard also
// declares 403 (it denies with ForbiddenError/Exception/`:forbidden` at
// runtime).  `guarded` is the same predicate on every backend
// (`operationIsGuarded` / `workflowIsGuarded`), so the three emitters stay
// in lockstep.
//   create  (POST /<aggs>)            → 400, 422  (domain / validation)
//   getById (GET  /<aggs>/{id})       → 404  (not found)
//   operation (POST /<aggs>/{id}/op)  → 400, [403 if guarded], 404, 422
//   find (optional return)            → 404
//   workflow (POST /workflows/<wf>)   → 400, [403 if guarded], 422
//   list / non-optional find          → (none beyond the universal 500)
//
// 422 (Unprocessable Entity) is the validation-failure code declared per
// docs/old/proposals/validation-error-extension.md — Phase D.  Body carries the
// §3.2 `errors[]` extension array (per-field `{ pointer, message }`)
// consumed by the frontend ACL's `applyServerErrors` (#769).  500 is the
// universal fallback every route can produce; like most specs we don't
// enumerate it per operation (it would be noise on every path).

/** Media type for every RFC 7807 error body. */
export const PROBLEM_JSON = "application/problem+json";

/** Component-schema name for the shared RFC 7807 body. */
export const PROBLEM_SCHEMA = "ProblemDetails";

/** Operation kinds that map to a distinct error-status set. */
export type OpErrorKind =
  | "create"
  | "getById"
  | "destroy"
  | "operation"
  | "workflow"
  | "findOptional"
  | "findList"
  | "findSingle"
  | "list";

/** The HTTP error statuses a given operation kind declares, ascending.
 *  `guarded` (a `requires` guard) inserts 403 — the authorization-denied
 *  outcome — for every kind that can carry one.
 *
 *  READS carry a guard too.  `requires` is legal on a `find`, and the emitters
 *  have always ENFORCED it — Hono throws `ForbiddenError` (→ 403 via its
 *  `onError` filter), python raises the same, and the OIDC negative-authz gate
 *  (M-T3.13) asserts a `requires`-gated find 403s an authenticated-but-
 *  unauthorized caller against a booted backend.  Only the DECLARED set was
 *  missing it: this arm branched on `guarded` for `operation`/`workflow` alone,
 *  so all five backends published `[404]` for a gated find and answered 403 at
 *  runtime.  Every generated client therefore had to treat its own callee's
 *  authorization denial as an unexpected throw.
 *
 *  Fixing it HERE rather than per-backend is the point of the table: one arm
 *  moves the five emitters and `deriveContextOperations` together, so the
 *  conformance error-response dimension stays balanced instead of showing four
 *  backends drifting from one. */
export function errorStatuses(
  kind: OpErrorKind,
  guarded = false,
  /** Resolver for the app-global denial-ladder rungs — maps an error name to
   *  its `httpStatus`-overridden status, defaulting to that name's stdlib code.
   *  Originally only the structural conflicts (M-T3.4a: the destroy FK-restrict
   *  `ReferencedInUse`); M-T5.20 extended it to the `DomainError` domain floor
   *  and the `Forbidden` rung so the DECLARED response set moves in lockstep
   *  with the runtime handler arm. (`NotFound` is deliberately excluded — see
   *  the note below.) Omitted ⇒ the literal defaults (409 / 422 / 403 —
   *  byte-identical output). */
  resolve?: (name: string) => number,
): number[] {
  const referencedInUse = resolve?.("ReferencedInUse") ?? 409;
  // The domain floor (RS-15: a well-formed request the domain refuses on
  // semantic grounds). 422 by default, which is ALSO the wire-validation tier's
  // status — so with no override the two collapse to a single declared 422 and
  // the emitted set is unchanged.
  const domain = resolve?.("DomainError") ?? 422;
  const forbidden = resolve?.("Forbidden") ?? 403;
  // NOTE the 404 rung is deliberately NOT resolved here (M-T5.20 gap): the
  // aggregate-not-found 404 has TWO producers and they differ per backend — the
  // exception handler (Hono's `AggregateNotFoundError` → onError) and a bare
  // framework return (`NotFound()` / `ResponseEntity.notFound()` / a `None`
  // check) on the find / getById / projection / workflow read paths.  Moving
  // only the handler arm would make Hono's getById answer the override while
  // .NET's answered 404, i.e. trade one drift for a worse cross-backend one.
  // Closing it means converting every bare-404 return site too.
  const set = (...statuses: number[]): number[] => [...new Set(statuses)].sort((a, b) => a - b);
  switch (kind) {
    // 400 = a malformed/unparseable body; 422 = the wire-validation tier
    // (`errors[]`); `domain` = the domain floor.  The first two are framework
    // tiers, not remappable rungs, so they stay literal.
    case "create":
      return set(400, 422, domain);
    case "getById":
      return [404];
    // destroy (DELETE /<aggs>/{id}) → 404 (not found) + 409 (still
    // referenced: cross-aggregate `X id` FK is ON DELETE RESTRICT — the
    // `ReferencedInUse` structural conflict, remappable via `httpStatus`).
    case "destroy":
      return set(404, referencedInUse);
    case "operation":
      return guarded ? set(400, forbidden, 404, 422, domain) : set(400, 404, 422, domain);
    case "workflow":
      return guarded ? set(400, forbidden, 422, domain) : set(400, 422, domain);
    case "findOptional":
      return guarded ? [403, 404] : [404];
    case "findList":
    case "findSingle":
      return guarded ? [403] : [];
    // `list` is the auto-`findAll`, which carries no `requires` of its own.
    case "list":
      return [];
  }
}

/** Human-readable `title` for an RFC 7807 problem, keyed by status — kept
 *  identical across backends so the (compared) ProblemDetails examples /
 *  descriptions don't drift.  Titles are the IANA HTTP status reason
 *  phrases. */
export function problemTitle(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    // Codes an `httpStatus <Error> -> <Code>` override may retarget a rung to
    // (M-T3.4a / M-T5.20) — kept here so a remapped rung's 7807 title and its
    // OpenAPI `description` stay a real reason phrase, not the generic fallback.
    case 402:
      return "Payment Required";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 409:
      return "Conflict";
    case 422:
      return "Unprocessable Entity";
    case 423:
      return "Locked";
    case 428:
      return "Precondition Required";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    case 502:
      return "Bad Gateway";
    default:
      return "Error";
  }
}
