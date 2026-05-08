// Synthesise the iframe document for the React preview.
//
// The output is pushed to `preview-sw.js`, which serves it when
// the iframe navigates to `<base>/__loom_sandbox__/`.  Real-origin
// iframe — postMessage, history, and the URL parser all behave
// normally with no shims required.
//
// Fetches the bundle issues are relative URLs (the bundler's
// `import.meta.env.VITE_API_BASE_URL` define swaps the
// generator's `http://localhost:NNNN` baseline for `"runtime"`),
// so requests resolve to `<base>/__loom_sandbox__/runtime/...` and
// land in the SW.  The SW forwards them through a MessageChannel
// to the parent's runtime worker and posts the response back.
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
  /** Pathname the iframe is served from, no trailing slash —
   *  e.g. `/loc/playground/__loom_sandbox__` on GH Pages.  The
   *  generated `main.tsx` reads this as `window.__LOOM_BASENAME__`
   *  and passes it to `<BrowserRouter basename>`, so route
   *  resolution works under the iframe's deploy path.  When
   *  unset, the bundle falls back to BrowserRouter's default
   *  (root). */
  sandboxBase?: string;
}

const REACT_FALLBACK_VERSION = "18.3.1";

function importMap(versions: Record<string, string>): Record<string, string> {
  const reactVer = versions["react"] ?? REACT_FALLBACK_VERSION;
  const reactDomVer = versions["react-dom"] ?? reactVer;
  // Only `react` and `react-dom` are externalised — everything
  // else (`react/jsx-runtime`, `react-dom/client`, …) is bundled
  // inline by esbuild and reaches React/React-DOM through these
  // two entries.  Keeping the importmap minimal also keeps the
  // esm.sh "external" set narrow, which is what dedupes Mantine
  // and friends to a single shard (see plugin.ts comment on
  // REACT_RUNTIME_EXTERNALS).
  return {
    "react": `https://esm.sh/react@${reactVer}?dev=false`,
    "react-dom": `https://esm.sh/react-dom@${reactDomVer}?dev=false&deps=react@${reactVer}`,
  };
}

const ESCAPE_END_SCRIPT = (s: string): string => s.replace(/<\/script/gi, "<\\/script");

function styleTagFor(css?: string): string {
  if (!css) return "";
  return `<style>\n${css}\n</style>`;
}

export function makePreviewHtml(args: MakePreviewArgs): string {
  const map = importMap(args.versions ?? {});
  const importMapJson = JSON.stringify({ imports: map }, null, 2);
  // No `<base href>`: relative URLs resolve against the iframe's
  // own document URL, which is `<base>/__loom_sandbox__/`.  This
  // is exactly what we want — the bundler's `runtime` API base
  // resolves to `<sandbox>/runtime/...`, which the SW intercepts.
  // A `<base href="/">` would have leaked the request out of the
  // SW scope on deploys with a non-root deploy base (e.g. GH
  // Pages at `/loc/playground/`).
  const basenameScript =
    args.sandboxBase != null
      ? `<script>window.__LOOM_BASENAME__ = ${JSON.stringify(args.sandboxBase)};</script>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loom Preview</title>
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
${basenameScript}
<script type="module">${ESCAPE_END_SCRIPT(args.js)}</script>
</body>
</html>`;
}
