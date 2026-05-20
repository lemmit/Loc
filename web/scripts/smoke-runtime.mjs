// Full end-to-end smoke: generate → install (real npm tarballs) →
// bundle (VFS-npm plugin, NO esm.sh) → import in Node → boot PGlite +
// the generated Hono app → dispatch + round-trip a product.
//
// Switched off the esm.sh bundler: esm.sh serves a broken drizzle-orm
// build (pg-core/utils drops the `extractUsedTable` export), which
// fails every backend bundle — the exact bug class the npm-in-browser
// engine was built to escape.  This smoke now exercises that engine's
// pipeline (the same install + makeVfsNpmPlugin + postProcessNpmBundle
// path the browser worker runs), so it reflects the runtime we intend
// to ship and is independent of esm.sh's upstream breakage.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateTypeScript } from "../../out/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import {
  makeEntryStdin,
  pgliteAssetUrl,
  resolveInFs,
  schemaPathFor,
  RUNTIME_VERSIONS,
} from "../src/bundle/plugin.ts";
import { synthDDL } from "../src/runtime/ddl.ts";
import { install } from "../src/engine/npm/install.ts";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { postProcessNpmBundle } from "../src/engine/npm/postprocess.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../../examples/sales.ddd");
const text = readFileSync(sourcePath, "utf8");

console.log(`# 1/5 generating from ${path.basename(sourcePath)}…`);
const services = createDddServices(NodeFileSystem);
const docs = services.shared.workspace.LangiumDocuments;
const doc = docs.createDocument(URI.parse("inmemory:///main.ddd"), text);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
if ((doc.diagnostics ?? []).some((d) => d.severity === 1)) {
  console.error("parse errors");
  process.exit(1);
}
const fileMap = generateTypeScript(doc.parseResult.value, BACKEND_PINS);
const entry = "http/index.ts";
const schemaPath = schemaPathFor(entry);
if (!resolveInFs(fileMap, entry) || !resolveInFs(fileMap, schemaPath)) {
  console.error("entry/schema missing");
  process.exit(1);
}
console.log(`# generated ${fileMap.size} files`);

console.log("# 2/5 installing real npm tarballs + bundling (VFS plugin, no esm.sh)…");
// One VFS: generated files (absolute paths) + installed node_modules.
const vfs = new Map();
for (const [p, c] of fileMap) vfs.set("/" + p, c);
const pkg = JSON.parse(fileMap.get("package.json") ?? "{}");
const rootDeps = {
  ...(pkg.dependencies ?? {}),
  "@electric-sql/pglite": RUNTIME_VERSIONS["@electric-sql/pglite"],
};
const t0 = Date.now();
const { versions, fileCount } = await install(rootDeps, (p, d) => vfs.set(p, d));
console.log(`# installed ${versions.size} pkgs / ${fileCount} files in ${Date.now() - t0} ms`);

const bundleStart = Date.now();
const out = await esbuild.build({
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
  outdir: "/",
  loader: { ".wasm": "binary" },
  plugins: [makeVfsNpmPlugin(vfs)],
});
const js = out.outputFiles.find((f) => f.path.endsWith(".js")) ?? out.outputFiles[0];
const code = js.text;
console.log(`# bundled ${(code.length / 1024).toFixed(0)} KB in ${Date.now() - bundleStart} ms (real node_modules)`);

console.log("# 3/5 post-processing + writing bundle + importing…");
// npm-engine postprocess: neutralise PGlite node-detection + rewrite
// import.meta.url to a real jsdelivr base (blob:-URL fix).
const patched = postProcessNpmBundle(code);
const tmpFile = path.join(os.tmpdir(), `loom-bundle-${process.pid}.mjs`);
writeFileSync(tmpFile, patched);
const mod = await import(pathToFileURL(tmpFile).href);
const expected = ["createApp", "schema", "drizzle", "PGlite", "is", "Table", "getTableConfig"];
for (const name of expected) {
  if (!(name in mod)) {
    console.error(`bundle missing export: ${name}`);
    process.exit(1);
  }
}
console.log(`# bundle module loaded; ${expected.length} exports verified`);

console.log("# 4/5 DDL synth + PGlite (with injected WASMs) + createApp…");
const ddl = synthDDL(mod.schema, {
  is: mod.is,
  Table: mod.Table,
  getTableConfig: mod.getTableConfig,
});
console.log("--- DDL ---");
console.log(ddl);
console.log("-----------");

const [pgliteRes, initdbRes, dataRes] = await Promise.all([
  fetch(pgliteAssetUrl("pglite.wasm")),
  fetch(pgliteAssetUrl("initdb.wasm")),
  fetch(pgliteAssetUrl("pglite.data")),
]);
const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
  WebAssembly.compile(await pgliteRes.arrayBuffer()),
  WebAssembly.compile(await initdbRes.arrayBuffer()),
  dataRes.blob(),
]);
const pglite = new mod.PGlite({ pgliteWasmModule, initdbWasmModule, fsBundle });
await pglite.exec("SELECT 1;");
await pglite.exec(ddl);
const db = mod.drizzle(pglite, { schema: mod.schema });
const app = mod.createApp(db);
console.log("# app booted");

console.log("# 5/5 dispatching requests against in-process backend…");
const res1 = await app.fetch(new Request("http://localhost/products"));
const body1 = await res1.text();
console.log(`# GET /products → ${res1.status} ${body1.slice(0, 80)}`);
if (res1.status !== 200) {
  console.error("FAIL: expected 200");
  process.exit(1);
}

const res2 = await app.fetch(new Request("http://localhost/products", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } }),
}));
const body2 = await res2.text();
console.log(`# POST /products → ${res2.status} ${body2.slice(0, 160)}`);
if (res2.status >= 400) {
  console.error("FAIL: POST returned error");
  process.exit(1);
}

const res3 = await app.fetch(new Request("http://localhost/products"));
const body3 = await res3.text();
console.log(`# GET /products again → ${res3.status} ${body3.slice(0, 220)}`);
const parsed = JSON.parse(body3);
if (!Array.isArray(parsed) || parsed.length !== 1 || parsed[0].sku !== "WIDGET-1") {
  console.error(`FAIL: expected 1 product 'WIDGET-1', got ${JSON.stringify(parsed)}`);
  process.exit(1);
}
console.log(`# OK — round-tripped 1 product (${parsed[0].sku}) through PGlite + drizzle + Hono`);

await pglite.close();
console.log("# all green");
