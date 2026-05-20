// Build step (C2, step 1): prebuild a design pack's frontend VENDOR
// (react + the pack's UI libs) into shipped ESM chunks + an importmap,
// using NATIVE esbuild over a real installed node_modules.  Per
// session the playground then externalises the vendor and esbuild-wasm
// bundles only the generated app — taking the React bundle from
// ~5–26s down to ~1–2s (and removing the vendor install/extraction).
//
// This script proves the mechanics for one pack (mantine).  Output:
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

const here = path.dirname(fileURLToPath(import.meta.url));

// react runtime subpaths the automatic JSX transform + entry use,
// beyond whatever the pack's package.json lists.
const REACT_SUBPATHS = ["react", "react-dom", "react-dom/client", "react/jsx-runtime"];
// CSS the pack imports from JS — prebuilt into vendor.css and injected
// by the iframe (so the app's CSS imports can be stripped).
const CSS_SPECS = [
  "@mantine/core/styles.css",
  "@mantine/notifications/styles.css",
  "@mantine/dates/styles.css",
];

const pack = "mantine";
const exampleDdd = "storybook-mantine.ddd";

// 1. Generate the pack's app to read its real frontend deps.
const text = readFileSync(path.resolve(here, "../src/examples/" + exampleDdd), "utf8");
const s = createDddServices(NodeFileSystem);
const d = s.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///m.ddd"), text);
await s.shared.workspace.DocumentBuilder.build([d], { validation: true });
const fm = generateSystems(d.parseResult.value).files;
const slug = [...fm.keys()].find((p) => /\/src\/main\.tsx$/.test(p))?.split("/")[0];
const frontDeps = JSON.parse(fm.get(`${slug}/package.json`)).dependencies ?? {};
console.log(`# ${pack}: ${Object.keys(frontDeps).length} frontend deps`);

// 2. Install the vendor into an in-memory VFS.
const vfs = new Map();
const t0 = Date.now();
await install(frontDeps, (p, b) => vfs.set(p, b));
console.log(`# installed vendor in ${Date.now() - t0} ms`);

// 3. Resolve every vendor entry specifier to its real entry file.
const src = {
  read: (p) => { const v = vfs.get(p); return v == null ? undefined : (typeof v === "string" ? v : new TextDecoder().decode(v)); },
  exists: (p) => vfs.has(p),
};
const jsSpecs = [...new Set([...REACT_SUBPATHS, ...Object.keys(frontDeps)])];
const entryPoints = [];
const importmap = { imports: {} };
const sanitize = (spec) => spec.replace(/[@/]/g, "_");
for (const spec of jsSpecs) {
  const resolved = resolveBare(spec, src);
  if (!resolved) { console.warn(`#   skip (unresolved): ${spec}`); continue; }
  entryPoints.push({ out: sanitize(spec), in: resolved });
}

// 4. Native esbuild: bundle all vendor entries with code-splitting so
// shared deps (react, @floating-ui, …) land in shared chunks.
const outDir = path.resolve(here, `../public/vendor/${pack}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

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

const baseUrl = `vendor/${pack}/`;
for (const f of jsOut.outputFiles) {
  const name = f.path.split("/").pop();
  writeFileSync(path.join(outDir, name), f.text);
}
for (const spec of jsSpecs) {
  if (entryPoints.some((e) => e.out === sanitize(spec))) {
    importmap.imports[spec] = baseUrl + sanitize(spec) + ".js";
  }
}

// 5. CSS bundle (pack stylesheets) → vendor.css.
const cssEntries = CSS_SPECS.map((spec) => resolveBare(spec, src)).filter(Boolean);
if (cssEntries.length) {
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
console.log(`# wrote ${jsOut.outputFiles.length} JS files + importmap (${Object.keys(importmap.imports).length} specs) + vendor.css to public/vendor/${pack}/`);
