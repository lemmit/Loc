// Build step (C2, step 1): prebuild a design pack's frontend VENDOR
// (react + the pack's UI libs) into shipped ESM chunks + an importmap,
// using NATIVE esbuild over a real installed node_modules.  Per
// session the playground then externalises the vendor and esbuild-wasm
// bundles only the generated app — taking the React bundle from
// ~5–26s down to ~1–2s (and removing the vendor install/extraction).
//
// Runs for every design pack (mantine / shadcn / mui / chakra),
// best-effort per pack — a failed pack just leaves no importmap so the
// engine falls back to bundling that pack's vendor in-browser.  The
// vendor entry set is harvested from each app's REAL external imports
// (not guessed from package.json roots), so subpaths like
// `@mui/material/styles` are covered.  Output:
//   web/public/vendor/<pack>/<specifier>.js   (entry per vendor spec)
//   web/public/vendor/<pack>/chunk-*.js       (esbuild shared chunks)
//   web/public/vendor/<pack>/importmap.json   (specifier → entry url)
//   web/public/vendor/<pack>/vendor.css       (pack CSS, e.g. mantine)

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import { readFileSync } from "node:fs";
import { install } from "../src/engine/npm/install.ts";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { resolveBare } from "../src/engine/node-resolve.ts";
import { harvestTsconfigPaths } from "../src/bundle/plugin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// Per pack: the example to read real frontend deps from, and any CSS
// the app imports from JS (prebuilt into vendor.css + injected by the
// iframe so the app's CSS imports can be stripped).  shadcn uses the
// Tailwind browser CDN (no static vendor.css); mui/chakra use runtime
// CSS-in-JS (bundled into the vendor JS).
const PACKS = [
  { pack: "mantine", ddd: "storybook-mantine.ddd", css: ["@mantine/core/styles.css", "@mantine/notifications/styles.css", "@mantine/dates/styles.css"] },
  { pack: "shadcn", ddd: "storybook-shadcn.ddd", css: [] },
  { pack: "mui", ddd: "storybook-mui.ddd", css: [] },
  { pack: "chakra", ddd: "storybook-chakra.ddd", css: [] },
];

const services = createDddServices(NodeFileSystem);
const sanitize = (spec) => spec.replace(/[@/]/g, "_");

// Specs that are never browser-runtime vendor JS, so they don't belong
// in the prebuilt vendor / importmap.  Mirrors the runtime plugin: the
// `tailwindcss`/`tw-animate-css` family is left external for the
// iframe's `@tailwindcss/browser` to compile at runtime, and
// `@tailwindcss/*` (vite plugin / native oxide) is build-only — the
// generated app never imports it.
const VENDOR_SKIP_RE = /^tailwindcss($|\/)|^tw-animate-css$|^@tailwindcss\//;

async function buildPack({ pack, ddd, css: cssSpecs }) {
  // 1. Generate the pack's app to read its real frontend deps.
  const text = readFileSync(path.resolve(here, "../src/examples/" + ddd), "utf8");
  const doc = services.shared.workspace.LangiumDocuments.createDocument(
    URI.parse(`inmemory:///${pack}.ddd`),
    text,
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const fm = generateSystems(doc.parseResult.value).files;
  const slug = [...fm.keys()].find((p) => /\/src\/main\.tsx$/.test(p))?.split("/")[0];
  if (!slug) {
    console.warn(`# ${pack}: no React deployable — skip`);
    return;
  }
  const frontDeps = JSON.parse(fm.get(`${slug}/package.json`)).dependencies ?? {};

  // 2. Install the vendor into an in-memory VFS.
  const vfs = new Map();
  const t0 = Date.now();
  await install(frontDeps, (p, b) => vfs.set(p, b));
  const src = {
    read: (p) => { const v = vfs.get(p); return v == null ? undefined : (typeof v === "string" ? v : new TextDecoder().decode(v)); },
    exists: (p) => vfs.has(p),
  };

  // 3. Harvest the EXACT set of bare specifiers the generated app
  // imports — including subpaths (`@hookform/resolvers/zod`,
  // `@mui/material/styles`) — by bundling the app app-only
  // (externalizeVendor) and reading the externals off esbuild's
  // metafile.  Guessing from frontDeps' package roots misses subpaths
  // and leaves them unresolved in the iframe importmap; harvesting from
  // the real bundle is the source of truth for what the importmap must
  // cover.
  // App-only VFS (no node_modules) so every bare specifier the app
  // imports is left external by the plugin's externalizeVendor branch
  // — those externals ARE the vendor specifier set the importmap must
  // cover.  An onResolve recorder captures them as esbuild resolves.
  const appVfs = new Map();
  const entryAbs = "/" + [...fm.keys()].find((p) => /\/src\/main\.tsx$/.test(p));
  for (const [p, c] of fm) appVfs.set("/" + p, c);
  const appAliases = harvestTsconfigPaths(appVfs, entryAbs);
  const externals = new Set();
  const recordExternals = {
    name: "record-externals",
    setup(build) {
      build.onEnd((result) => {
        for (const out of Object.values(result.metafile?.outputs ?? {})) {
          for (const imp of out.imports ?? []) {
            if (imp.external && !imp.path.startsWith(".") && !imp.path.startsWith("/")) {
              externals.add(imp.path);
            }
          }
        }
      });
    },
  };
  await esbuild.build({
    entryPoints: [entryAbs],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    metafile: true,
    write: false,
    outdir: "/app",
    logLevel: "silent",
    plugins: [makeVfsNpmPlugin(appVfs, "/node_modules", false, appAliases, true), recordExternals],
  });
  const jsSpecs = [...externals].filter((spec) => !VENDOR_SKIP_RE.test(spec));
  const entryPoints = [];
  for (const spec of jsSpecs) {
    const resolved = resolveBare(spec, src);
    if (resolved) entryPoints.push({ out: sanitize(spec), in: resolved });
    else console.warn(`#   ${pack}: skip (unresolved) ${spec}`);
  }

  const outDir = path.resolve(here, `../public/vendor/${pack}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 4. Native esbuild: bundle all entries with code-splitting so
  // shared deps (react, @floating-ui, …) land in shared chunks.
  const jsOut = await esbuild.build({
    entryPoints,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    outdir: "/vendor",
    write: false,
    logLevel: "silent",
    plugins: [makeVfsNpmPlugin(vfs)],
  });
  for (const f of jsOut.outputFiles) {
    writeFileSync(path.join(outDir, f.path.split("/").pop()), f.text);
  }
  // `imports` is a standard importmap (specifier → relative url, made
  // origin-absolute by the consumer).  `css` is our own sibling field
  // (the consumer reads this manifest, never injects it verbatim) —
  // the vendor.css url when the pack ships precompiled CSS, else null.
  const importmap = { imports: {}, css: null };
  const baseUrl = `vendor/${pack}/`;
  for (const e of entryPoints) {
    const spec = jsSpecs.find((s) => sanitize(s) === e.out);
    importmap.imports[spec] = baseUrl + e.out + ".js";
  }

  // 5. CSS bundle (pack stylesheets) → vendor.css.
  const cssEntries = cssSpecs.map((spec) => resolveBare(spec, src)).filter(Boolean);
  if (cssEntries.length) {
    importmap.css = baseUrl + "vendor.css";
    const cssOut = await esbuild.build({
      entryPoints: cssEntries,
      bundle: true,
      minify: true,
      outdir: "/css",
      write: false,
      logLevel: "silent",
      plugins: [makeVfsNpmPlugin(vfs)],
    });
    const css = cssOut.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
    writeFileSync(path.join(outDir, "vendor.css"), css);
  }

  writeFileSync(path.join(outDir, "importmap.json"), JSON.stringify(importmap, null, 0));
  console.log(
    `# ${pack}: ${jsOut.outputFiles.length} JS + ${Object.keys(importmap.imports).length}-spec importmap` +
      (cssEntries.length ? " + vendor.css" : "") +
      ` (${Date.now() - t0} ms)`,
  );
}

for (const cfg of PACKS) {
  try {
    await buildPack(cfg);
  } catch (err) {
    // Best-effort per pack: a failure leaves no importmap → the
    // engine falls back to bundling that pack's vendor in-browser.
    console.warn(`# ${cfg.pack}: FAILED — ${err instanceof Error ? err.message : err}`);
  }
}

