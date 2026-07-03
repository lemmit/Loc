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

/** Where auth mounts — the session probe (`/me`) and the OIDC redirect
 *  handshake (`/login`/`/callback`/`/logout`) — i.e. `/api/auth`. Auth is
 *  browser-facing traffic, same class as the domain routes, so it lives
 *  UNDER the API base: a single reverse-proxy / k8s-ingress rule
 *  (`/api → backend`) covers it, and the standalone + compose frontends
 *  (which call `${API_BASE_URL}/auth/...` with `API_BASE_URL` already `/api`)
 *  line up. Contrast the infra probes (`/health`, `/ready`), which are hit
 *  directly by Docker/k8s and stay at the root. */
export const AUTH_BASE_PATH = `${API_BASE_PATH}/auth`;

/** Host port the bundled dev Keycloak is published on in the generated
 *  `docker-compose.yml` (`8081:8080`; 8080 is left free for backends).
 *  Shared here so the system compose emitter AND the IR-level host-port
 *  uniqueness validator agree on the reserved port a user deployable must
 *  not collide with when auth is bundled. */
export const KEYCLOAK_HOST_PORT = 8081;
