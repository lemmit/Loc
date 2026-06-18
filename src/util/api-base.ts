// ---------------------------------------------------------------------------
// API base path — the single source of truth for the URL prefix every
// backend mounts its domain routes under, and every frontend / test / OpenAPI
// `servers` block targets.
//
// Historically `/api` was used ONLY when a SPA was embedded into a backend
// (the `hasEmbeddedSpa` fullstack mode) plus Elixir/Phoenix always. This
// constant promotes `/api` to the universal default so the whole stack is
// uniform: domain routes live under `/api`, infra endpoints (`/health`,
// `/ready`, the OpenAPI document) stay at the root, and a reverse proxy /
// k8s ingress can split `/api → backend` from `/ → SPA` on one origin.
//
// Phase 1 keeps this a constant (prefix-only). A later phase turns it into a
// per-system `basePath:` field (e.g. `/api/v1`) threaded from the IR — every
// consumer already reads through this module, so versioning lands in one place.
// ---------------------------------------------------------------------------

/** The canonical base path, leading slash, no trailing slash (e.g. `/api`). */
export const API_BASE_PATH = "/api";

/** `/api/` — leading + trailing slash, for backends that combine a relative
 *  route segment (ASP.NET `[Route("api/widgets")]`, FastAPI `prefix="/api"`). */
export function apiRoutePrefix(): string {
  return `${API_BASE_PATH}/`.replace(/^\//, "");
}
