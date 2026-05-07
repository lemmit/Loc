// Synthesise the iframe document for the React preview.
//
// The React bundle is loaded inside the iframe; it mounts on
// `#root` at evaluation time.  All fetches the bundle issues
// against any `http://localhost:*` host get intercepted by the
// shim below and routed via `postMessage` to the parent window,
// which forwards them to the runtime worker (where the Hono +
// PGlite backend lives).  This avoids needing a Service Worker.
//
// We keep the shim small and inline-injected so it sits before
// the bundle's first import — no race, no SW lifecycle.
//
// React runtime modules (`react`, `react-dom`, `react/jsx-runtime`,
// …) are externalised at bundle time and provided via a dynamic
// `<script type="importmap">` here, so every component shares the
// same React instance.  Without that, the bundle ends up with
// multiple React copies and `useRef` returns null at runtime.

interface MakePreviewArgs {
  js: string;
  css?: string;
  /** Versions harvested from the generator's package.json.
   *  Lookups for `react` / `react-dom` decide what the importmap
   *  pins; if unset, falls back to a known-good 18.x. */
  versions?: Record<string, string>;
}

const REACT_FALLBACK_VERSION = "18.3.1";

function importMap(versions: Record<string, string>): Record<string, string> {
  const reactVer = versions["react"] ?? REACT_FALLBACK_VERSION;
  const reactDomVer = versions["react-dom"] ?? reactVer;
  // Importmap rules per spec: keys ending in "/" must map to URL
  // values ending in "/".  esm.sh URLs with `?query` parameters
  // can't satisfy that, so we list each required sub-path
  // explicitly (jsx-runtime, jsx-dev-runtime, react-dom/client).
  return {
    "react": `https://esm.sh/react@${reactVer}?dev=false`,
    "react-dom": `https://esm.sh/react-dom@${reactDomVer}?dev=false&deps=react@${reactVer}`,
    "react-dom/client": `https://esm.sh/react-dom@${reactDomVer}/client?dev=false&deps=react@${reactVer}`,
    "react/jsx-runtime": `https://esm.sh/react@${reactVer}/jsx-runtime?dev=false`,
    "react/jsx-dev-runtime": `https://esm.sh/react@${reactVer}/jsx-dev-runtime?dev=false`,
  };
}

const ROUTING_FIX_SRC = `
// Best-effort: reset the iframe's URL to "/" so React Router's
// BrowserRouter sees a path it can match.  srcdoc iframes start
// at "about:srcdoc" with pathname "srcdoc", which doesn't match
// any route the generator emits.  Wrapped in try/catch because
// some browsers refuse history mutations from opaque origins.
try { history.replaceState({}, "", "/"); } catch (_) {}
`;

const FETCH_SHIM_SRC = `
(function () {
  const orig = globalThis.fetch.bind(globalThis);
  let nextId = 0;
  const pending = new Map();

  globalThis.addEventListener("message", function (ev) {
    const d = ev.data;
    if (!d || d.type !== "loom-fetch-response") return;
    const slot = pending.get(d.id);
    if (!slot) return;
    pending.delete(d.id);
    if (d.ok) {
      slot.resolve(new Response(d.body, {
        status: d.status,
        statusText: d.statusText,
        headers: d.headers,
      }));
    } else {
      slot.reject(new Error(d.message));
    }
  });

  function shouldIntercept(url) {
    // Anything pointed at a localhost:<port> host — the React
    // generator bakes that URL from the target deployable's port,
    // and the runtime worker is ready to dispatch any path there.
    return /^https?:\\/\\/localhost(?::\\d+)?\\//.test(url);
  }

  async function readBody(b) {
    if (b == null) return null;
    if (typeof b === "string") return b;
    if (b instanceof URLSearchParams) return b.toString();
    if (b instanceof FormData) {
      const out = {};
      b.forEach((v, k) => { out[k] = String(v); });
      return JSON.stringify(out);
    }
    try {
      return await new Response(b).text();
    } catch (_) {
      return null;
    }
  }

  function headersToObject(h) {
    if (!h) return {};
    const out = {};
    if (h instanceof Headers) { h.forEach((v, k) => { out[k] = v; }); return out; }
    if (Array.isArray(h)) { for (const [k, v] of h) out[k] = v; return out; }
    return Object.assign({}, h);
  }

  globalThis.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input && input.url ? input.url : "";
    if (!shouldIntercept(url)) return orig(input, init);

    const method = (init && init.method) || (typeof input !== "string" && input.method) || "GET";
    const headers = headersToObject(
      (init && init.headers) || (typeof input !== "string" && input.headers) || null,
    );
    const body = await readBody(
      (init && init.body) || (typeof input !== "string" && input.body) || null,
    );

    const id = ++nextId;
    return new Promise(function (resolve, reject) {
      pending.set(id, { resolve, reject });
      parent.postMessage(
        { type: "loom-fetch", id, url, method, headers, body },
        "*",
      );
    });
  };
})();
`;

const ESCAPE_END_SCRIPT = (s: string): string => s.replace(/<\/script/gi, "<\\/script");

function styleTagFor(css?: string): string {
  if (!css) return "";
  return `<style>\n${css}\n</style>`;
}

export function makePreviewHtml(args: MakePreviewArgs): string {
  const map = importMap(args.versions ?? {});
  const importMapJson = JSON.stringify({ imports: map }, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loom Preview</title>
<base href="/">
<script type="importmap">
${ESCAPE_END_SCRIPT(importMapJson)}
</script>
${styleTagFor(args.css)}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #fff; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div id="root"></div>
<script>${ESCAPE_END_SCRIPT(ROUTING_FIX_SRC)}</script>
<script>${ESCAPE_END_SCRIPT(FETCH_SHIM_SRC)}</script>
<script type="module">${ESCAPE_END_SCRIPT(args.js)}</script>
</body>
</html>`;
}
