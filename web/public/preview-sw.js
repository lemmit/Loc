// Loom playground — preview Service Worker.
//
// Registered under the playground's deploy path (e.g.
// `/loc/playground/preview-sw.js` on GitHub Pages).  Default scope
// is the directory the SW is served from, so any iframe loaded
// under that path is controlled.
//
// The SW serves the preview iframe out of `<base>/__loom_sandbox__/`:
//
//   - Index navigations (`<sandbox>/` and `<sandbox>/index.html`)
//     return the latest bundled HTML pushed by the parent page via
//     `postMessage({ type: "loom-sw/set-bundle", ... })`.
//   - Runtime API requests (`<sandbox>/runtime/*`) are forwarded
//     to a `MessagePort` the parent attached via
//     `postMessage({ type: "loom-sw/attach-runtime" }, [port])`.
//     The parent dispatches each forwarded request against its
//     in-process Hono + PGlite runtime worker and posts the
//     response back through the same port.
//
// Other in-scope requests under the sandbox prefix 404; out-of-
// origin and out-of-prefix requests pass through untouched
// (playground assets, esm.sh, jsdelivr).

const SANDBOX_PREFIX = "__loom_sandbox__/";
const RUNTIME_SUBPATH = "runtime/";

// Latest bundle pushed by the parent page.  Empty until the user
// runs Bundle, in which case sandbox routes return a 503 telling
// them to bundle first.
let currentBundle = null;

// MessagePort the parent provided for forwarding runtime requests.
// Replaced on every attach (e.g. when the parent re-mounts).
let runtimePort = null;
// Pending runtime requests, keyed by an id we generate per fetch.
const pendingRuntime = new Map();
let nextRuntimeId = 0;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    // Broadcast on every activation so freshly-installed SWs trigger
    // the parent's init effects.  Cold installs run install->activate
    // BEFORE the playground's React tree finishes mounting, so this
    // notification may land on no listeners; the parent's mount
    // effect attaches independently in that case.  Cheap enough to
    // fire unconditionally.
    await broadcastWake("activated");
  })());
});

/** Fire-and-forget broadcast to every controlled client so the
 *  parent can re-attach the runtime port + re-push the latest
 *  bundle.  We don't wait for an ack — the parent's reaction is
 *  to bump a revision counter that re-runs its existing init
 *  effects; if the broadcast misses (e.g. no clients controlled
 *  yet), the next sandbox fetch from a fresh-state SW will
 *  re-broadcast (see the throttled `maybeBroadcastWake` below). */
async function broadcastWake(reason) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: false });
    for (const client of clients) {
      client.postMessage({ type: "loom-sw/awake", reason });
    }
  } catch (_) {
    // best-effort — broadcast must never break a real fetch.
  }
}

// Throttle so a flurry of in-flight runtime requests after a SW
// revival doesn't spam the parent with N wake messages.  One per
// second is enough — the parent only needs to learn once that the
// SW lost state before its re-init effects fire.
let lastWakeBroadcastAt = 0;
function maybeBroadcastWake(reason) {
  const now = Date.now();
  if (now - lastWakeBroadcastAt < 1_000) return;
  lastWakeBroadcastAt = now;
  void broadcastWake(reason);
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "loom-sw/set-bundle") {
    currentBundle = data.bundle;
    // Ack so the parent can wait until `currentBundle` is in
    // place before navigating the iframe — otherwise a fetch
    // event could race the message and serve the previous bundle.
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ ok: true });
  } else if (data.type === "loom-sw/attach-runtime") {
    const port = event.ports && event.ports[0];
    if (!port) return;
    runtimePort = port;
    runtimePort.onmessage = (ev) => {
      const reply = ev.data;
      if (!reply || typeof reply.id !== "number") return;
      const slot = pendingRuntime.get(reply.id);
      if (!slot) return;
      pendingRuntime.delete(reply.id);
      slot(reply);
    };
    // Ack: the parent waits for this before letting the iframe
    // render so the bundle's first fetch can't outrun the attach.
    port.postMessage({ type: "attached" });
  } else if (data.type === "loom-sw/ping") {
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "loom-sw/pong" });
    }
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const swDir = new URL(".", self.location.href).pathname;
  if (!url.pathname.startsWith(swDir + SANDBOX_PREFIX)) return;
  event.respondWith(handleSandboxRequest(event.request, url));
});

async function handleSandboxRequest(request, url) {
  const swDir = new URL(".", self.location.href).pathname;
  const sandboxRoot = swDir + SANDBOX_PREFIX;
  const subpath = url.pathname.slice(sandboxRoot.length);

  // Runtime bridge — `<sandbox>/runtime/*` forwards to the
  // parent's runtime worker.  Handle this BEFORE the
  // currentBundle check so `runtime/...` requests don't 503 just
  // because the user hasn't bundled (the runtime worker can be up
  // independently).
  if (subpath.startsWith(RUNTIME_SUBPATH)) {
    // Strip the `<deploy>/<sandbox>/runtime` prefix so the
    // forwarded URL's pathname matches what the bundled Hono app
    // registered its routes under (e.g. `/customers`).  Hono
    // matches on `new URL(request.url).pathname`; without this
    // rewrite it would see the full deploy path and 404 every
    // request.  Origin/search/hash are preserved.
    const routeUrl = new URL(request.url);
    routeUrl.pathname = "/" + subpath.slice(RUNTIME_SUBPATH.length);
    // If the SW has just been revived after a browser-imposed kill,
    // `runtimePort` is null even though the parent thinks it's
    // attached.  Nudge the parent to re-attach by broadcasting a
    // wake message; the parent's listener (Preview.tsx) re-runs
    // its attach + push effects.  This fetch itself still 502s —
    // React Query / the user's retry logic picks up the next
    // request once the port is back.
    if (!runtimePort) maybeBroadcastWake("runtime-fetch-without-port");
    return forwardRuntime(request, routeUrl.toString());
  }

  if (currentBundle == null) {
    // Same recovery path for the bundle.  After a revival, the SPA
    // entry would otherwise stay 503 forever — broadcast so the
    // parent re-pushes its latest bundle.
    maybeBroadcastWake("navigation-without-bundle");
    return new Response(
      "Loom preview sandbox is not ready yet — bundle the source first.\n",
      {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      },
    );
  }

  // SPA fallback — every non-runtime path under the sandbox prefix
  // serves the bundle's HTML.  The bundle's BrowserRouter (with
  // basename pinned to the sandbox path) then matches the path
  // against the user's routes.  This makes deep links and reloads
  // mid-route work — e.g. user clicks "Customers", URL becomes
  // `<sandbox>/customers`, reload returns the bundle, router
  // matches "/customers".
  return new Response(currentBundle.html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function forwardRuntime(request, forwardUrl) {
  if (!runtimePort) {
    return new Response("Runtime not attached.\n", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const id = ++nextRuntimeId;
  // Read the body up-front: streaming through MessagePort is
  // awkward and the runtime worker dispatches synchronously
  // anyway.  Empty/absent bodies arrive as null.
  const body = await readRequestBody(request);
  const headers = headersToObject(request.headers);
  return new Promise((resolve) => {
    const TIMEOUT_MS = 30_000;
    const timer = setTimeout(() => {
      pendingRuntime.delete(id);
      resolve(
        new Response("Runtime timeout.\n", {
          status: 504,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }, TIMEOUT_MS);
    pendingRuntime.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.ok) {
        // Web Fetch forbids passing a body for null-body statuses
        // (204 / 205 / 304).  Coerce empty body to null so the
        // Response constructor doesn't throw.
        const isNullBody = reply.status === 204 || reply.status === 205 || reply.status === 304;
        resolve(
          new Response(isNullBody ? null : reply.body, {
            status: reply.status,
            statusText: reply.statusText,
            headers: reply.headers,
          }),
        );
      } else {
        resolve(
          new Response(reply.message ?? "Runtime error.\n", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }
    });
    runtimePort.postMessage({
      id,
      url: forwardUrl,
      method: request.method,
      headers,
      body,
    });
  });
}

async function readRequestBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  try {
    const text = await request.text();
    return text === "" ? null : text;
  } catch (_) {
    return null;
  }
}

function headersToObject(h) {
  const out = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
    return out;
  }
  return Object.assign({}, h);
}
