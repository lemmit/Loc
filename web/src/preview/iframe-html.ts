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
  // shadcn-generated globals.css starts with `@tailwind base; @tailwind
  // components; @tailwind utilities;` — those are PostCSS directives that
  // need a build step.  In the playground we don't have a Tailwind build
  // pipeline (esbuild-wasm's CSS loader is plain text), so we detect the
  // directives and route the CSS through Tailwind's Play CDN: a JIT
  // compiler that processes `<style type="text/tailwindcss">` blocks at
  // load time and watches the DOM for new classes.  Mantine's
  // pre-compiled CSS goes through the regular `<style>` tag — no JIT
  // needed.
  if (/^\s*@tailwind\b/m.test(css)) {
    return `<style type="text/tailwindcss">\n${css}\n</style>`;
  }
  return `<style>\n${css}\n</style>`;
}

/** True when the bundled CSS contains `@tailwind` directives, which is
 *  the playground's signal that the iframe needs the Tailwind Play CDN
 *  + a matching tailwind.config (currently identifies the shadcn pack;
 *  future packs that ship Tailwind would benefit from the same path). */
function needsTailwindCdn(css?: string): boolean {
  return !!css && /^\s*@tailwind\b/m.test(css);
}

/** Tailwind Play CDN configuration — mirrors `themes/shadcn/tailwind-
 *  config.hbs` so the JIT compiler sees the same theme extension
 *  (CSS-variable colour palette, custom radius scale,
 *  tailwindcss-animate plugin substitute) the generated build would
 *  have used at compile time.  Inlined as a `<script>` rather than
 *  fetched so first paint doesn't need a second network round-trip
 *  for an external config module. */
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
  const map = importMap(args.versions ?? {});
  const importMapJson = JSON.stringify({ imports: map }, null, 2);
  // No `<base href>`: relative URLs resolve against the iframe's
  // own document URL, which is `<base>/__loom_sandbox__/`.  This
  // is exactly what we want — the bundler's `runtime` API base
  // resolves to `<sandbox>/runtime/...`, which the SW intercepts.
  // A `<base href="/">` would have leaked the request out of the
  // SW scope on deploys with a non-root deploy base (e.g. GH
  // Pages at `/loc/playground/`).
  // Inject two globals the bundle reads:
  //   - __LOOM_BASENAME__: feeds <BrowserRouter basename>, so route
  //     resolution survives the iframe being mounted under a deploy
  //     subpath (e.g. `/loc/playground/__loom_sandbox__`).
  //   - __LOOM_API_BASE__: absolute path the generator's
  //     `config.ts` uses for `API_BASE_URL`.  Must be absolute
  //     (leading `/`) so fetches don't resolve against the iframe's
  //     current URL — once the user navigates client-side
  //     (e.g. to `<sandbox>/products/new`) a relative API base
  //     would resolve to `<sandbox>/products/runtime/...`, which
  //     hits the SW SPA fallback (HTML response) and breaks JSON
  //     parsing in the bundle.
  const hostScript =
    args.sandboxBase != null
      ? `<script>` +
        `window.__LOOM_BASENAME__ = ${JSON.stringify(args.sandboxBase)};` +
        `window.__LOOM_API_BASE__ = ${JSON.stringify(args.sandboxBase + "/runtime")};` +
        `</script>`
      : "";
  // Tailwind Play CDN + config — only when the bundle's CSS uses
  // `@tailwind` directives.  The CDN script must run BEFORE the
  // bundle so its DOM observer is registered; we put the config
  // script first (the CDN reads `window.tailwind.config` on init)
  // and the CDN script second.
  const tailwindScripts = needsTailwindCdn(args.css)
    ? `<script>${TAILWIND_PLAY_CONFIG}</script>\n` +
      `<script src="https://cdn.tailwindcss.com"></script>`
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
${tailwindScripts}
${styleTagFor(args.css)}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #fff; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div id="root"></div>
${hostScript}
<script type="module">${ESCAPE_END_SCRIPT(args.js)}</script>
</body>
</html>`;
}
