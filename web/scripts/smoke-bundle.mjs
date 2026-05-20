// Node-side smoke for the bundler pipeline.  Generates the Hono
// backend from examples/sales.ddd via the real Loom toolchain, then
// runs the same plugin the browser worker uses against `esbuild`
// (Node binary).  Catches resolution / shim / esm.sh issues without
// needing a browser.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDddServices } from "../../out/language/ddd-module.js";
import { lowerModel } from "../../out/ir/lower.js";
import { enrichLoomModel } from "../../out/ir/enrichments.js";
import { generateTypeScript } from "../../out/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import {
  harvestVersions,
  makeEntryStdin,
  makeLoomPlugin,
  resolveInFs,
  schemaPathFor,
} from "../src/bundle/plugin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../../examples/sales.ddd");
const text = readFileSync(sourcePath, "utf8");

console.log(`# loading ${sourcePath}`);
const services = createDddServices(NodeFileSystem);
const docs = services.shared.workspace.LangiumDocuments;
const doc = docs.createDocument(URI.parse("inmemory:///main.ddd"), text);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
const errs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
if (errs.length > 0) {
  console.error("parse errors:", errs);
  process.exit(1);
}

const enriched = enrichLoomModel(lowerModel(doc.parseResult.value));
console.log(`# generated context count: ${enriched.contexts.length}`);
const fileMap = generateTypeScript(doc.parseResult.value, BACKEND_PINS);
console.log(`# generator emitted ${fileMap.size} files`);

const fs = new Map([...fileMap]);
const entry = "http/index.ts";
if (!resolveInFs(fs, entry)) {
  console.error(`entry not present: ${entry}`);
  process.exit(1);
}

const ctx = {
  files: fs,
  fetchedUrls: new Set(),
  fetchCache: new Map(),
  versions: harvestVersions(fs),
};
console.log(`# harvested ${ctx.versions.size} pinned versions: ${[...ctx.versions.entries()].map(([k, v]) => `${k}@${v}`).join(", ")}`);

const schemaPath = schemaPathFor(entry);
if (!resolveInFs(fs, schemaPath)) {
  console.error(`schema not present: ${schemaPath}`);
  process.exit(1);
}

console.log("# bundling…");
const start = Date.now();
let out;
try {
  out = await esbuild.build({
    stdin: {
      contents: makeEntryStdin(entry, schemaPath),
      resolveDir: "/",
      sourcefile: "__entry__.ts",
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
    sourcemap: false,
    loader: { ".wasm": "binary" },
    plugins: [makeLoomPlugin(ctx)],
  });
} catch (err) {
  console.error("bundle failed:");
  for (const m of err.errors ?? []) {
    console.error(`  ${m.location?.file ?? "?"}:${m.location?.line ?? "?"}: ${m.text}`);
  }
  process.exit(1);
}

const durationMs = Date.now() - start;
const code = out.outputFiles[0].text;
console.log(`# OK: bundled ${(code.length / 1024).toFixed(1)} KB in ${durationMs} ms`);
console.log(`# fetched ${ctx.fetchedUrls.size} external module(s)`);
console.log(`# warnings: ${out.warnings.length}, errors: ${out.errors.length}`);
for (const w of out.warnings) {
  console.log(`  warn: ${w.location?.file ?? "?"}:${w.location?.line ?? "?"}: ${w.text}`);
}

// Sanity: the bundle should expose all the runtime-needed exports.
const expected = ["createApp", "schema", "drizzle", "PGlite", "is", "Table", "getTableConfig"];
const missing = expected.filter((name) => !code.includes(name));
if (missing.length > 0) {
  console.error(`BUG: bundle missing expected names: ${missing.join(", ")}`);
  process.exit(1);
}
if (code.includes("node-postgres")) {
  console.error("WARN: bundle still references 'node-postgres' (shim may not be applied)");
}
console.log(`# bundle exports OK (${expected.length} runtime symbols); node-postgres absent`);

// Brief peek at fetched URLs to confirm we hit pglite / hono / zod.
const sample = [...ctx.fetchedUrls].sort().slice(0, 12);
console.log("# first fetched URLs:");
for (const u of sample) console.log(`  ${u}`);
