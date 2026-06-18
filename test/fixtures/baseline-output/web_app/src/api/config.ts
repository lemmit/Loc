// Auto-generated.
// The API base the browser fetches against.  Resolution order:
//   1. window.__LOOM_API_BASE__ — an absolute path set by an embedding host
//      (e.g. the Loom playground iframe at `<deploy>/__loom_sandbox__/`) so
//      fetches don't depend on the bundle's current location.href when it
//      navigates client-side (BrowserRouter pushState) and the iframe URL
//      becomes a route path under which a relative base would resolve
//      elsewhere.
//   2. VITE_API_BASE_URL — baked at *build* time for a cross-origin / absolute
//      API URL (e.g. dev-compose points it at the target backend's port).
//   3. the generation-time default below — `/api`, RELATIVE, so the bundle is
//      same-origin by default: one host fronts both `/` and `/api` (the k8s
//      Ingress split, or a reverse proxy), no CORS.  The common case.
const fromWindow =
  typeof window !== "undefined"
    ? (window as { __LOOM_API_BASE__?: string }).__LOOM_API_BASE__
    : undefined;
const fromEnv = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL;
export const API_BASE_URL: string = fromWindow ?? fromEnv ?? "/api";
