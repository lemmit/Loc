#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Build the showcase iframe bundles.
//
// For each (story × pack) in `docs/showcase/src/stories/registry.ts`:
//   1. Mutate the DDL to set `design: <pack>` on the webApp deployable.
//   2. Run the Loom generator -> a Map<path, content> of TSX/TS files.
//   3. Find the React entry (`<slug>/src/main.tsx`).
//   4. Bundle it through esbuild + the existing Loom bundler plugin
//      (the same one the playground worker uses, so output shape is
//      identical to what users see live).
//   5. Synthesize a self-contained iframe HTML that:
//        - sets `__LOOM_BASENAME__` and `__LOOM_API_BASE__` globals
//          the way the generated app expects;
//        - injects a `fetch` interceptor returning the story's
//          mock JSON so list/detail pages render with content;
//        - ships an importmap pointing react/react-dom at esm.sh
//          (same approach as the playground iframe).
//   6. Write `index.html`, `bundle.js`, `bundle.css` into
//      `docs/_site/showcase/iframes/<story>/<pack>/`.
//
// Finally, write a `manifest.json` listing every (story, pack)
// pair the showcase Vite app reads at runtime.
//
// Run with: `node scripts/build-showcase.mjs`
// (requires `npm run build` to have produced `out/` first.)
// ---------------------------------------------------------------------------

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const registryPath = path.resolve(repoRoot, "docs/showcase/src/stories/registry.ts");
const outRoot = path.resolve(repoRoot, "docs/_site/showcase");
const iframesRoot = path.join(outRoot, "iframes");

// Load the registry via tsx — same trick the project uses for its
// other Node-side scripts that consume TS source.
async function loadRegistry() {
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  try {
    const mod = await import(pathToFileURL(registryPath).href);
    return mod.STORIES;
  } finally {
    unregister();
  }
}

// makeLoomPlugin lives in this same package under src/bundle/.
async function loadBundlerPlugin() {
  const { register } = await import("tsx/esm/api");
  const unregister = register();
  try {
    const mod = await import(
      pathToFileURL(path.resolve(here, "../src/bundle/plugin.ts")).href
    );
    return { makeLoomPlugin: mod.makeLoomPlugin, harvestVersions: mod.harvestVersions };
  } finally {
    unregister();
  }
}

/** Inject `design: <pack>` into the `deployable webApp { ... }`
 *  block.  Mirrors the helper in test/generated-react-build.test.ts —
 *  same shape so single- and multi-line declarations both work. */
function injectDesign(src, pack) {
  if (pack === "mantine") return src; // mantine is the default
  const multiLine = /(deployable webApp \{)([^}]*?)\n(\s*)\}/;
  if (multiLine.test(src)) {
    return src.replace(
      multiLine,
      (_, head, body, indent) => `${head}${body}\n${indent}design: ${pack}\n${indent}}`,
    );
  }
  const singleLine = /(deployable webApp \{[^}\n]+?)(\s*)\}/;
  return src.replace(singleLine, `$1, design: ${pack}$2}`);
}

async function generate(ddl) {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = docs.createDocument(URI.parse("inmemory:///main.ddd"), ddl);
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errs.length > 0) {
    throw new Error(
      "DDL parse errors:\n" +
        errs.map((d) => `  L${d.range.start.line + 1}: ${d.message}`).join("\n"),
    );
  }
  return generateSystems(doc.parseResult.value).files;
}

/** Rewrite `@/foo` imports to absolute virtual-fs paths that
 *  the bundler plugin can resolve relatively.  shadcn's tsconfig
 *  declares `@/*` -> `./src/*`; from the bundle entry's
 *  perspective that's `<slug>/src/foo`.  The playground's
 *  esbuild plugin doesn't honour `tsconfigRaw.paths` (its broad
 *  `^[^./]` onResolve catches `@/foo` before the path-mapping
 *  step), so we normalise here to keep the showcase build
 *  self-contained — no playground-plugin changes required.  Done
 *  pre-bundle by string-replacing every TSX/TS file's import
 *  specifiers; cheap and accurate because Loom-generated code is
 *  consistent about quoting style. */
function rewriteShadcnAliases(files, slug) {
  const out = new Map(files);
  const rewriteRe = /(import[^"']*?["'])@\/([^"']+)(["'])/g;
  for (const [path, content] of files) {
    if (!path.endsWith(".tsx") && !path.endsWith(".ts")) continue;
    if (!content.includes("@/")) continue;
    out.set(
      path,
      content.replace(rewriteRe, (_, head, rest, quote) => {
        const abs = `/${slug}/src/${rest}`;
        const fromDir = "/" + path.slice(0, path.lastIndexOf("/"));
        // Convert absolute target to a path relative to the
        // importing file's directory — the bundler resolves
        // ./relative imports through the virtual fs.
        const rel = relativePosix(fromDir, abs);
        return `${head}${rel}${quote}`;
      }),
    );
  }
  return out;
}

function relativePosix(fromDir, toAbs) {
  const fromParts = fromDir.split("/").filter(Boolean);
  const toParts = toAbs.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const ups = "../".repeat(fromParts.length - common);
  const tail = toParts.slice(common).join("/");
  const out = (ups + tail) || "./";
  return out.startsWith(".") ? out : "./" + out;
}

/** shadcn's `globals.css` uses Tailwind `@tailwind` directives that
 *  need PostCSS to compile.  esbuild's CSS loader can't parse them.
 *  The playground sidesteps this by routing the unprocessed CSS
 *  through the Tailwind Play CDN at iframe-render time
 *  (`web/src/preview/iframe-html.ts`); the showcase does the same
 *  here.  We strip the `import "./globals.css"` (or any other
 *  import of a `.css` file with @tailwind content) from the bundle
 *  entry-side, capture the raw CSS, and the iframe HTML injects
 *  it as `<style type="text/tailwindcss">` plus a Play CDN script.
 *
 *  Returns the modified file map plus any rawTailwindCss content
 *  that needs out-of-band injection. */
function extractTailwindCss(files) {
  let rawTailwindCss = "";
  const out = new Map();
  for (const [path, content] of files) {
    if (path.endsWith(".css") && /^\s*@tailwind\b/m.test(content)) {
      rawTailwindCss += "\n" + content;
      // Drop the file from the bundle entirely so esbuild doesn't
      // try to parse it; importers get their `import "./foo.css"`
      // rewritten away below.
      continue;
    }
    out.set(path, content);
  }
  if (rawTailwindCss === "") return { files, rawTailwindCss: "" };
  // Strip every `import "<path-to-stripped-css>"` from the
  // remaining TS/TSX files.  Loom emits this pattern only in
  // `<slug>/src/main.tsx` for shadcn (`import "./globals.css"`)
  // but the regex stays general for safety.
  const stripRe = /^\s*import\s+["'][^"']+\.css["'];?\s*$/gm;
  const stripped = new Map();
  for (const [path, content] of out) {
    if ((path.endsWith(".tsx") || path.endsWith(".ts")) && /\.css["']/.test(content)) {
      stripped.set(path, content.replace(stripRe, ""));
    } else {
      stripped.set(path, content);
    }
  }
  return { files: stripped, rawTailwindCss };
}

async function bundle(files, makeLoomPlugin, harvestVersions) {
  const reactEntry = [...files.keys()].find((p) =>
    /^[^/]+\/src\/main\.tsx$/.test(p),
  );
  if (!reactEntry) {
    throw new Error("no react entry found in generator output");
  }
  const slug = reactEntry.split("/")[0];
  const aliased = rewriteShadcnAliases(files, slug);
  const { files: prepared, rawTailwindCss } = extractTailwindCss(aliased);
  const ctx = {
    files: new Map(prepared),
    fetchedUrls: new Set(),
    fetchCache: new Map(),
    versions: harvestVersions(prepared, reactEntry),
  };
  const out = await esbuild.build({
    stdin: {
      contents: `import "./${reactEntry}";\n`,
      resolveDir: "/",
      sourcefile: "__entry__.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
    sourcemap: false,
    jsx: "automatic",
    outdir: "/__loom_bundle__",
    loader: { ".wasm": "binary", ".css": "css" },
    plugins: [makeLoomPlugin(ctx, { externalReactRuntime: true })],
  });
  const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
  const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
  // Combine: any CSS esbuild bundled (Mantine's precompiled
  // styles) PLUS any Tailwind-directive CSS we extracted out-of-
  // band (shadcn's globals.css).  The iframe HTML decides per-
  // chunk how to inject — bundleCss as plain `<style>`,
  // tailwindCss as `<style type="text/tailwindcss">` for the Play
  // CDN to compile.
  return {
    js: js?.text ?? "",
    bundleCss: css?.text ?? "",
    tailwindCss: rawTailwindCss,
    versions: ctx.versions,
  };
}

const REACT_FALLBACK = "18.3.1";
const ESCAPE_END_SCRIPT = (s) => s.replace(/<\/script/gi, "<\\/script");

/** Synthesize the iframe HTML.  Mirrors the playground's
 *  `iframe-html.ts` for the importmap + globals, plus a story-
 *  specific mock-fetch interceptor and Tailwind Play CDN injection
 *  when the generated CSS uses `@tailwind` directives (shadcn). */
function iframeHtml({ js, bundleCss, tailwindCss, versions, story }) {
  const reactVer = versions.get?.("react") ?? REACT_FALLBACK;
  const reactDomVer = versions.get?.("react-dom") ?? reactVer;
  const importMap = JSON.stringify(
    {
      imports: {
        react: `https://esm.sh/react@${reactVer}?dev=false`,
        "react-dom": `https://esm.sh/react-dom@${reactDomVer}?dev=false&deps=react@${reactVer}`,
      },
    },
    null,
    2,
  );
  // Tailwind Play CDN config — mirrors `themes/shadcn/tailwind-
  // config.hbs` (the same drift-guarded mapping the playground
  // iframe uses; see `web/src/preview/iframe-html.ts` for context
  // and `test/iframe-tailwind-drift.test.ts` for the equality
  // assertion).  Inlined as a `<script>` so first paint doesn't
  // need an extra round-trip for an external config.
  const tailwindConfigScript = tailwindCss
    ? `<script>
tailwind.config = {
  darkMode: ["class"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))", input: "hsl(var(--input))", ring: "hsl(var(--ring))",
        background: "hsl(var(--background))", foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
    },
  },
};
</script>`
    : "";
  const tailwindScripts = tailwindCss
    ? tailwindConfigScript +
      '\n<script src="https://cdn.tailwindcss.com"></script>'
    : "";
  const styleTag =
    (bundleCss ? `<style>\n${bundleCss}\n</style>` : "") +
    (tailwindCss ? `<style type="text/tailwindcss">\n${tailwindCss}\n</style>` : "");
  const initialPath = story.initialPath ?? "/";
  const mockJson = JSON.stringify(story.mockApi ?? {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${story.label}</title>
<script type="importmap">
${ESCAPE_END_SCRIPT(importMap)}
</script>
${tailwindScripts}
${styleTag}
<style>
  html, body { margin: 0; padding: 0; height: 100%; }
  body { background: #fff; font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<div id="root"></div>
<script>
  // Generated app reads __LOOM_BASENAME__ for <BrowserRouter basename>;
  // empty here means the iframe's own root acts as the app root, and
  // initial route is set by overriding history.replaceState before the
  // bundle runs.
  window.__LOOM_BASENAME__ = "";
  window.__LOOM_API_BASE__ = "";
  history.replaceState(null, "", ${JSON.stringify(initialPath)});

  // Mock-fetch interceptor — returns canned JSON for the story's
  // pre-declared paths so list/detail pages render with content
  // instead of perpetual loading skeletons.  Falls through to the
  // real network for anything not in the mock map (so e.g. esm.sh
  // imports keep working).
  (function () {
    const MOCK = ${ESCAPE_END_SCRIPT(mockJson)};
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input.url;
      try {
        const u = new URL(url, location.href);
        if (u.origin === location.origin && u.pathname in MOCK) {
          const body = JSON.stringify(MOCK[u.pathname]);
          return Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }
      } catch (_e) {}
      return orig(input, init);
    };
  })();
</script>
<script type="module">${ESCAPE_END_SCRIPT(js)}</script>
</body>
</html>`;
}

async function main() {
  console.log("# Building Loom showcase…");
  const stories = await loadRegistry();
  const { makeLoomPlugin, harvestVersions } = await loadBundlerPlugin();
  console.log(`# ${stories.length} stories × 2 packs = ${stories.length * 2} bundles`);

  await rm(iframesRoot, { recursive: true, force: true });
  await mkdir(iframesRoot, { recursive: true });

  const manifest = { stories: [] };
  const packs = ["mantine", "shadcn"];

  for (const story of stories) {
    const storyEntry = {
      id: story.id,
      label: story.label,
      group: story.group,
      blurb: story.blurb,
      packs: {},
    };
    for (const pack of packs) {
      const start = Date.now();
      process.stdout.write(`  - ${story.id} × ${pack}…`);
      const ddl = injectDesign(story.ddd, pack);
      const files = await generate(ddl);
      const { js, bundleCss, tailwindCss, versions } = await bundle(
        files,
        makeLoomPlugin,
        harvestVersions,
      );
      const html = iframeHtml({ js, bundleCss, tailwindCss, versions, story });
      const dir = path.join(iframesRoot, story.id, pack);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "index.html"), html, "utf-8");
      const ms = Date.now() - start;
      const kb = (js.length / 1024).toFixed(0);
      process.stdout.write(` ${kb} KB, ${ms} ms\n`);
      storyEntry.packs[pack] = `iframes/${story.id}/${pack}/index.html`;
    }
    manifest.stories.push(storyEntry);
  }

  await writeFile(
    path.join(outRoot, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  console.log(`# manifest -> ${path.relative(repoRoot, outRoot)}/manifest.json`);
  console.log("# done.");
}

main().catch((err) => {
  console.error("showcase build failed:", err);
  process.exit(1);
});
