// Synthesise the iframe document for the React preview.
//
// The output is handed to the sandbox stub (`public/sandbox/index.html`)
// over `postMessage` and rendered in place via `document.write`, so the
// document keeps a real URL on `SANDBOX_ORIGIN` — history/pushState and
// the URL parser all behave normally, and BrowserRouter is unchanged.
//
// The generated bundle's API base is `window.__LOOM_API_BASE__`
// (an absolute path under the stub's directory, e.g.
// `<base>/sandbox/runtime`).  An inline `fetch` shim installed here
// intercepts requests under that prefix and forwards them over the
// `MessagePort` the stub stashed on `window.__LOOM_PORT__`; every
// other fetch (Tailwind CDN, vendor chunks) falls through to the
// real `fetch`.  This replaces the old Service-Worker interception.
//
// When the bundle externalised a prebuilt design-pack vendor, the
// app's bare imports (`react`, `react-dom`, `@mantine/core`, …) are
// satisfied by a `<script type="importmap">` pointing at the vendor
// chunks, so every component shares one React instance.  A
// self-contained bundle inlines its deps and needs no importmap.

// Inline runtime `fetch` bridge.  Classic script so it runs
// synchronously during parse — before the bundle module fetches —
// and reads the port the stub left on `window.__LOOM_PORT__`.  Kept
// dependency-free and ES5-ish since it executes inside the generated
// app's document.
const RUNTIME_FETCH_SHIM = `
(function () {
  var port = window.__LOOM_PORT__;
  if (!port) return;
  var nextId = 1;
  var pending = Object.create(null);
  // In-flight runtime-request tracker — the test driver's
  // waitForLoadState("networkidle") polls this so a post-mutation
  // react-query refetch lands before the test reads the DOM.
  var net = window.__LOOM_NET__ || (window.__LOOM_NET__ = { inflight: 0, last: Date.now() });
  function netStart() { net.inflight++; net.last = Date.now(); }
  function netEnd() { net.inflight--; net.last = Date.now(); }
  port.onmessage = function (ev) {
    var r = ev.data;
    if (!r || typeof r.rid !== "number") return;
    var slot = pending[r.rid];
    if (!slot) return;
    delete pending[r.rid];
    slot(r);
  };
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var apiBase = window.__LOOM_API_BASE__;
    var req;
    try { req = new Request(input, init); }
    catch (e) { return realFetch ? realFetch(input, init) : Promise.reject(e); }
    var u;
    try { u = new URL(req.url, document.baseURI); }
    catch (e) { return realFetch ? realFetch(input, init) : Promise.reject(e); }
    if (!apiBase || u.pathname.indexOf(apiBase) !== 0) {
      return realFetch ? realFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
    }
    var routePath = u.pathname.slice(apiBase.length) + u.search;
    if (routePath.charAt(0) !== "/") routePath = "/" + routePath;
    return req.text().then(function (bodyText) {
      var headers = {};
      req.headers.forEach(function (v, k) { headers[k] = v; });
      var rid = nextId++;
      return new Promise(function (resolve) {
        netStart();
        var timer = setTimeout(function () {
          delete pending[rid];
          netEnd();
          resolve(new Response("Runtime timeout.\\n", { status: 504 }));
        }, 30000);
        pending[rid] = function (reply) {
          clearTimeout(timer);
          netEnd();
          if (reply.ok) {
            var nullBody = reply.status === 204 || reply.status === 205 || reply.status === 304;
            resolve(new Response(nullBody ? null : reply.body, {
              status: reply.status, statusText: reply.statusText, headers: reply.headers
            }));
          } else {
            resolve(new Response((reply.message || "Runtime error") + "\\n", { status: 500 }));
          }
        };
        port.postMessage({
          kind: "runtime", rid: rid, method: req.method,
          url: routePath, headers: headers, body: bodyText === "" ? null : bodyText
        });
      });
    });
  };
})();
`.trim();

interface MakePreviewArgs {
  js: string;
  css?: string;
  /** Versions harvested from the generator's package.json.  Carried
   *  as bundle metadata (and part of the preview's cache key); the
   *  importmap itself comes from `vendorImportmap`. */
  versions?: Record<string, string>;
  /** C2: when the bundle externalised a prebuilt design-pack vendor,
   *  this importmap (bare spec → origin-absolute vendor chunk url)
   *  supplies react/@mantine/… to the iframe.  When set it REPLACES
   *  the version-derived react/react-dom map — the externalised app
   *  bundle resolves every bare import through it.  Absent → the
   *  bundle is self-contained and the version map applies. */
  vendorImportmap?: Record<string, string>;
  /** C2: origin-absolute url of the prebuilt vendor.css to link. */
  vendorCssUrl?: string;
  /** Basename for the app — the sandbox stub's directory, no trailing
   *  slash, e.g. `/loc/playground/sandbox` on GH Pages.  The
   *  generated `main.tsx` reads this as `window.__LOOM_BASENAME__`
   *  and passes it to `<BrowserRouter basename>`, so route
   *  resolution works under the iframe's deploy path.  When
   *  unset, the bundle falls back to BrowserRouter's default
   *  (root). */
  sandboxBase?: string;
  /** Origin-absolute url of the prebuilt sandbox UI-test driver module
   *  (public/sandbox/driver.js). When set, it is loaded as a module so
   *  serveDriverOps can attach to the bridge port and answer UI test ops
   *  against the sandbox document. Omitted in contexts that don't run UI
   *  tests. */
  driverUrl?: string;
}

const ESCAPE_END_SCRIPT = (s: string): string => s.replace(/<\/script/gi, "<\\/script");

// In-place reload controller.  Classic script (runs after the inline
// fetch shim in <head>, so the bridge port has already been started)
// that listens on the SAME `window.__LOOM_PORT__` for `loom-reload`
// messages the parent pushes after a rebuild.  On reload it swaps in
// the new bundle WITHOUT re-writing the document: the page shell,
// importmap, CSS link and — crucially — the current route (history)
// all survive, so the preview feels like an always-on app quietly
// refreshing rather than a full reload.
//
// `loom-reload` carries no `rid`, so the fetch shim's `port.onmessage`
// (which only handles numeric-rid runtime replies) ignores it; this
// listener only handles `kind === "reload"`.
//
// Note: re-importing the new bundle creates a fresh React root on a
// fresh `#root` node (avoids React's "createRoot on a container that
// already has a root" warning).  The previous bundle's root is left
// detached — component-local state does not survive a reload; only a
// full Fast-Refresh integration (deliberately out of scope) would
// preserve it.
const RELOAD_CONTROLLER = `
(function () {
  var port = window.__LOOM_PORT__;
  if (!port) return;
  var currentBlobUrl = null;
  function swapCss(css) {
    var el = document.getElementById("loom-css");
    if (!el) {
      el = document.createElement("style");
      el.id = "loom-css";
      document.head.appendChild(el);
    }
    el.textContent = css;
  }
  function mount(js) {
    var old = document.getElementById("root");
    var fresh = document.createElement("div");
    fresh.id = "root";
    if (old && old.parentNode) old.parentNode.replaceChild(fresh, old);
    else document.body.appendChild(fresh);
    if (currentBlobUrl) { try { URL.revokeObjectURL(currentBlobUrl); } catch (e) {} }
    var blob = new Blob([js], { type: "text/javascript" });
    currentBlobUrl = URL.createObjectURL(blob);
    var s = document.createElement("script");
    s.type = "module";
    s.src = currentBlobUrl;
    document.body.appendChild(s);
  }
  port.addEventListener("message", function (ev) {
    var r = ev.data;
    if (!r || r.kind !== "reload") return;
    if (typeof r.css === "string") swapCss(r.css);
    mount(r.js);
  });
})();
`.trim();

// Content-Security-Policy for the preview document.
//
// This is the egress lock the cross-origin sandbox needs once
// untrusted user expressions run in the preview: it can't phone home.
// It's harmless (pure hardening) while same-origin, so we always emit
// it.  After esm.sh was removed the document loads nothing third-party
// except the Tailwind compiler (shadcn packs only), so the allowlist
// is small:
//
//   - script-src 'self'        vendor chunks + dynamic-import splits
//                              (served same-origin from deployBase/vendor;
//                              after the origin flip they must be served
//                              from SANDBOX_ORIGIN too, where 'self' still
//                              matches the iframe).
//     'unsafe-inline'          the shim / hostScript / bundle module +
//                              the importmap (all inline).
//     'unsafe-eval'            the Tailwind in-browser JIT (shadcn).
//     cdn.tailwindcss.com /
//     cdn.jsdelivr.net         the Tailwind CDN scripts (shadcn v3 / v4).
//   - style-src 'self' 'unsafe-inline'   vendor.css link + inline <style>
//                              + Mantine/Tailwind runtime-injected styles.
//   - img-src / font-src       same-origin + data:/blob: (no web fonts
//                              from CDNs in the current packs — if one is
//                              added, widen this).
//   - connect-src 'none'       THE lock.  The app's only network call is
//                              its API, which the fetch shim answers over
//                              the bridge port without touching the
//                              network; any other fetch/XHR/WebSocket is
//                              refused.
//   - base-uri / form-action 'none'   no base-tag hijack, no native form
//                              navigation out of the sandbox.
const PREVIEW_CSP = [
  "default-src 'none'",
  // `blob:` is needed by the in-place reload controller, which mounts
  // each rebuilt bundle as a `<script type="module" src=blob:…>` so
  // the preview refreshes without re-writing the whole document.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Which Tailwind dialect the bundled CSS is written in, or `null`
 *  for non-Tailwind (pre-compiled) CSS like Mantine's.
 *
 *  - `"v3"`: shadcn@v3 — globals.css opens with `@tailwind base;
 *    @tailwind components; @tailwind utilities;`.  Compiled by the
 *    Tailwind 3 Play CDN + an inlined `window.tailwind.config`.
 *  - `"v4"`: shadcn@v4 — Tailwind 4 is CSS-first; globals.css opens
 *    with `@import "tailwindcss";` and carries its config inline via
 *    `@theme` / `@custom-variant`.  Compiled by `@tailwindcss/browser`
 *    (the v4 successor to the Play CDN); no JS config object. */
function tailwindFlavor(css?: string): "v3" | "v4" | null {
  if (!css) return null;
  if (/^\s*@tailwind\b/m.test(css)) return "v3";
  if (/^\s*@import\s+["']tailwindcss["']/m.test(css)) return "v4";
  return null;
}

function styleTagFor(css?: string): string {
  if (!css) return "";
  // In the playground we have no Tailwind build pipeline
  // (esbuild-wasm's CSS loader is plain text), so Tailwind-authored
  // CSS is routed through an in-browser JIT compiler that processes
  // `<style type="text/tailwindcss">` blocks at load time and
  // watches the DOM for new classes.  v3 → Play CDN; v4 →
  // `@tailwindcss/browser`.  Mantine's pre-compiled CSS goes through
  // a plain `<style>` tag — no JIT needed.
  const flavor = tailwindFlavor(css);
  if (flavor === "v3") {
    return `<style id="loom-css" type="text/tailwindcss">\n${css}\n</style>`;
  }
  if (flavor === "v4") {
    // `@tailwindcss/browser` resolves `@import "tailwindcss"`
    // itself, but cannot fetch the third-party `@import
    // "tw-animate-css"` (bare specifier, no resolver) — strip it so
    // the compile doesn't error.  Same intentional divergence as
    // v3's `tailwindcss-animate`: animation utilities won't run in
    // the preview but render fine in a real `vite build` deploy.
    const v4 = css.replace(/^\s*@import\s+["']tw-animate-css["'];?\s*$/m, "");
    return `<style id="loom-css" type="text/tailwindcss">\n${v4}\n</style>`;
  }
  return `<style id="loom-css">\n${css}\n</style>`;
}

/** Tailwind Play CDN configuration — mirrors `designs/shadcn/tailwind-
 *  config.hbs` so the JIT compiler sees the same theme extension
 *  (CSS-variable colour palette, custom radius scale) the generated
 *  build would have used at compile time.  Inlined as a `<script>`
 *  rather than fetched so first paint doesn't need a second network
 *  round-trip for an external config module.
 *
 *  Drift guard: `test/iframe-tailwind-drift.test.ts` asserts the
 *  `container`, `extend.colors`, and `extend.borderRadius` blocks
 *  here match the shadcn pack's `tailwind-config.hbs` byte-for-byte
 *  (after whitespace normalisation).  When updating one, update the
 *  other and the test stays green; if they drift, the test names
 *  the offending block.
 *
 *  Intentional divergence: the hbs ships `tailwindcss-animate` and
 *  `keyframes`/`animation` blocks the Play CDN can't run (no plugin
 *  loader available).  Animations on shadcn primitives that lean on
 *  `tailwindcss-animate` (e.g. accordion) won't animate in the
 *  preview but render fine in `npm run dev` of the generated app. */
const TAILWIND_PLAY_CONFIG = `
tailwind.config = {
  darkMode: ["class"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
};
`.trim();

export function makePreviewHtml(args: MakePreviewArgs): string {
  // A prebuilt-vendor bundle is externalised — every bare import
  // (react, @mantine/core, …) resolves through the prebuilt importmap.
  // A self-contained bundle inlines its deps, so it needs no importmap.
  const map = args.vendorImportmap ?? {};
  const importMapJson = JSON.stringify({ imports: map }, null, 2);
  const vendorCssLink = args.vendorCssUrl
    ? `<link rel="stylesheet" href="${args.vendorCssUrl}">`
    : "";
  // No `<base href>`: relative URLs resolve against the document's
  // own URL (the stub's path on SANDBOX_ORIGIN).  Inject the globals
  // the bundle reads:
  //   - __LOOM_BASENAME__: feeds <BrowserRouter basename>, so route
  //     resolution survives the iframe being mounted under a deploy
  //     subpath (e.g. `/loc/playground/sandbox`).
  //   - __LOOM_API_BASE__: absolute path the generator's `config.ts`
  //     uses for `API_BASE_URL`.  Must be absolute (leading `/`) so
  //     fetches don't resolve against the current client-side route;
  //     the inline fetch shim matches this prefix and forwards those
  //     requests over the bridge port (everything else passes through
  //     to the real `fetch`).
  const hostScript =
    args.sandboxBase != null
      ? `<script>` +
        `window.__LOOM_BASENAME__ = ${JSON.stringify(args.sandboxBase)};` +
        `window.__LOOM_API_BASE__ = ${JSON.stringify(args.sandboxBase + "/runtime")};` +
        // Normalise the start route to the basename root: the stub's
        // own URL ends in `…/sandbox/index.html`, which BrowserRouter
        // would otherwise fail to match against the user's routes.
        // Same-origin replaceState — never hits the network.
        `try{history.replaceState(null,"",${JSON.stringify(args.sandboxBase + "/")});}catch(e){}` +
        `</script>`
      : "";
  // In-browser Tailwind compiler — only when the bundle's CSS is
  // Tailwind-authored.  Must run BEFORE the bundle so the DOM
  // observer is registered ahead of first paint.
  //   - v3: inline `window.tailwind.config` (the CDN reads it on
  //     init) then the Tailwind 3 Play CDN.
  //   - v4: just `@tailwindcss/browser` — Tailwind 4 config lives
  //     in the CSS (`@theme` / `@custom-variant`), so there is no
  //     JS config object to inline.
  const twFlavor = tailwindFlavor(args.css);
  const tailwindScripts =
    twFlavor === "v3"
      ? `<script>${TAILWIND_PLAY_CONFIG}</script>\n` +
        `<script src="https://cdn.tailwindcss.com"></script>`
      : twFlavor === "v4"
        ? `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`
        : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loom Preview</title>
<script>${ESCAPE_END_SCRIPT(RUNTIME_FETCH_SHIM)}</script>
<script type="importmap">
${ESCAPE_END_SCRIPT(importMapJson)}
</script>
${vendorCssLink}
${tailwindScripts}
${styleTagFor(args.css)}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #fff; font-family: system-ui, sans-serif; }
  /* iOS Safari auto-zooms when a focused input has font-size < 16px,
     blowing past the user's pinch-zoom setting and forcing them to
     re-pan after every tap.  Mantine / shadcn primitives ship 14 px
     inputs by default; the @media guard makes sure the override only
     fires on phones where the auto-zoom kicks in, leaving desktop
     typography untouched.  Targets the form-control trio that
     triggers the heuristic; buttons and labels aren't affected. */
  @media (max-width: 768px) {
    input, select, textarea {
      font-size: 16px !important;
    }
  }
</style>
</head>
<body>
<div id="root"></div>
${hostScript}
<script type="module">${ESCAPE_END_SCRIPT(args.js)}</script>
<script>${ESCAPE_END_SCRIPT(RELOAD_CONTROLLER)}</script>
${args.driverUrl ? `<script type="module" src="${args.driverUrl}"></script>` : ""}
</body>
</html>`;
}
