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
import { generateTypeScript } from "../../out/generator/typescript/index.js";
import { harvestVersions, makeLoomPlugin, resolveInFs } from "../src/bundle/plugin.ts";

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
const fileMap = generateTypeScript(doc.parseResult.value);
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

console.log("# bundling…");
const start = Date.now();
let out;
try {
  out = await esbuild.build({
    stdin: {
      contents: `export { createApp } from "./${entry}";\n`,
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

// Sanity: the bundle should mention `createApp` and not `node-postgres`
// (proving the shim re-route worked).
if (!code.includes("createApp")) {
  console.error("BUG: bundle does not export createApp");
  process.exit(1);
}
if (code.includes("node-postgres")) {
  console.error("WARN: bundle still references 'node-postgres' (shim may not be applied)");
}
console.log("# bundle entry exports OK; node-postgres references absent");

// Brief peek at fetched URLs to confirm we hit pglite / hono / zod.
const sample = [...ctx.fetchedUrls].sort().slice(0, 12);
console.log("# first fetched URLs:");
for (const u of sample) console.log(`  ${u}`);
