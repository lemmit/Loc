// Auto-generated.
// Browser hits localhost:<api_port> directly; baked at generation time
// from the target deployable's port.  Override at build time via
// VITE_API_BASE_URL for non-docker-compose deployments.  Hosts that
// embed the bundle behind a path (e.g. the Loom playground iframe at
// `<deploy>/__loom_sandbox__/`) can also set
// `window.__LOOM_API_BASE__` to an absolute path so fetches don't
// depend on the bundle's current location.href — useful when the
// bundle navigates client-side (BrowserRouter pushState) and the
// iframe URL becomes a route path under which a relative `runtime`
// would resolve elsewhere.
const fromWindow =
  typeof window !== "undefined"
    ? (window as { __LOOM_API_BASE__?: string }).__LOOM_API_BASE__
    : undefined;
const fromEnv = (import.meta as { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL;
export const API_BASE_URL: string = fromWindow ?? fromEnv ?? "/api";
