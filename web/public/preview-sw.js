// Loom playground — preview Service Worker (scaffolding).
//
// This file ships with the playground and registers under the
// playground's deploy path (e.g. `/loc/playground/preview-sw.js` on
// GitHub Pages).  Default scope is the directory the SW is served
// from, so any iframe loaded under that path is controlled.
//
// Status: SCAFFOLDING ONLY.  Nothing in the playground UI loads
// content through this SW yet — the existing srcdoc-based preview
// (web/src/preview/Preview.tsx + iframe-html.ts) is still the
// active path.  Future PRs will:
//
//   1. Have the parent page push the latest bundle (HTML + JS + CSS)
//      to this SW via `postMessage` and store it on `currentBundle`.
//   2. Switch the preview iframe `src` to a sandbox URL within scope
//      (e.g. `<base>/__loom_sandbox__/`), at which point the SW
//      below serves the synthesized HTML directly — replacing the
//      `srcdoc` + URL-fix + history-replaceState patches.
//   3. Bridge in-iframe `fetch(...)` calls to the runtime worker
//      via `MessageChannel`, replacing the `parent.postMessage`
//      fetch shim in iframe-html.ts.
//
// Until those land, this SW just claims clients and lets every
// fetch fall through.  A no-op SW is safe to ship: browsers will
// register it, install it, and skip its (empty) fetch handler for
// every request.

const SANDBOX_PREFIX = "__loom_sandbox__/";

// Bundle slot — populated by `postMessage({ type: "loom-sw/set-bundle", ... })`
// from the parent page.  Empty until a real bundle arrives, in which
// case the sandbox routes return a 503 telling the user to bundle
// first (rather than a confusing blank page).
let currentBundle = null;

self.addEventListener("install", () => {
  // Skip the default "wait for old SW to release clients" step so
  // a fresh page load picks up the new SW immediately.  Safe here
  // because the SW carries no version-coupled cached state — each
  // bundle is pushed live from the parent page.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take over any already-open clients (e.g. the playground tab
  // that registered us) without requiring a reload.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "loom-sw/set-bundle") {
    currentBundle = data.bundle;
    // Ack via the optional MessagePort the caller provided.  The
    // parent uses this to wait until `currentBundle` is in place
    // before it navigates the iframe — otherwise a fetch event
    // could race the message and serve the previous bundle.
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ ok: true });
  } else if (data.type === "loom-sw/ping") {
    // Round-trip probe used by sw-host to confirm the SW is alive.
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "loom-sw/pong" });
    }
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only intercept same-origin requests under our sandbox prefix.
  // Everything else (the playground's own assets, esm.sh fetches,
  // PGlite WASM from jsdelivr) must pass through untouched.
  if (url.origin !== self.location.origin) return;
  const swDir = new URL(".", self.location.href).pathname;
  if (!url.pathname.startsWith(swDir + SANDBOX_PREFIX)) return;

  event.respondWith(handleSandboxRequest(url));
});

async function handleSandboxRequest(url) {
  if (currentBundle == null) {
    return new Response(
      "Loom preview sandbox is not ready yet — bundle the source first.\n",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }
  const swDir = new URL(".", self.location.href).pathname;
  const sandboxRoot = swDir + SANDBOX_PREFIX;
  // Index navigation — sandbox root or `index.html`.  Anything else
  // under the prefix is reserved for the future runtime bridge
  // (`<sandbox>/runtime/...`); 404 it for now so a stray fetch is
  // a clear miss rather than landing on the index.
  if (url.pathname === sandboxRoot || url.pathname === sandboxRoot + "index.html") {
    return new Response(currentBundle.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Bundles are live-pushed; never let the browser serve a
        // stale one from disk cache.
        "cache-control": "no-store",
      },
    });
  }
  return new Response("Sandbox path not handled yet.\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
