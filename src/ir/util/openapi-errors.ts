// Canonical per-operation error-response matrix — the single source of
// truth for which RFC 7807 error responses each backend declares on each
// operation.  Every backend (Hono / .NET / Phoenix) renders the SAME
// status set per operation kind so the conformance gate's per-operation
// error-response dimension compares equal.
//
// The body of every declared error response is the shared `ProblemDetails`
// schema (RFC 7807 core: `type`, `title`, `status`, `detail`, `instance`)
// served as `application/problem+json`.  Trace correlation rides on the
// `x-request-id` response header (not the body), so the body stays
// byte-identical across backends.
//
// The matrix is deterministic from route shape — no auth-conditionality —
// so the three emitters never drift:
//   create  (POST /<aggs>)            → 400  (domain / validation)
//   getById (GET  /<aggs>/{id})       → 404  (not found)
//   operation (POST /<aggs>/{id}/op)  → 400, 404
//   find (optional return)            → 404
//   workflow (POST /workflows/<wf>)   → 400
//   list / view / non-optional find   → (none beyond the universal 500)
//
// 500 is the universal fallback every route can produce; like most specs
// we don't enumerate it per operation (it would be noise on every path).

/** Media type for every RFC 7807 error body. */
export const PROBLEM_JSON = "application/problem+json";

/** Component-schema name for the shared RFC 7807 body. */
export const PROBLEM_SCHEMA = "ProblemDetails";

/** Operation kinds that map to a distinct error-status set. */
export type OpErrorKind =
  | "create"
  | "getById"
  | "operation"
  | "workflow"
  | "findOptional"
  | "findList"
  | "findSingle"
  | "list"
  | "view";

/** The HTTP error statuses a given operation kind declares, ascending. */
export function errorStatuses(kind: OpErrorKind): number[] {
  switch (kind) {
    case "create":
      return [400];
    case "getById":
      return [404];
    case "operation":
      return [400, 404];
    case "workflow":
      return [400];
    case "findOptional":
      return [404];
    case "findList":
    case "findSingle":
    case "list":
    case "view":
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
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 500:
      return "Internal Server Error";
    default:
      return "Error";
  }
}
