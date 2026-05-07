// Full end-to-end smoke: generate → bundle → import bundle in Node →
// boot PGlite + the generated Hono app → dispatch a Request.
//
// The browser runtime worker exercises the same module shape; if
// this passes, the only browser-specific surface left is the
// postMessage RPC plumbing.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { createDddServices } from "../../out/language/ddd-module.js";
import { lowerModel } from "../../out/ir/lower.js";
import { enrichLoomModel } from "../../out/ir/enrichments.js";
import { generateTypeScript } from "../../out/generator/typescript/index.js";
import {
  harvestVersions,
  makeEntryStdin,
  makeLoomPlugin,
  resolveInFs,
  schemaPathFor,
} from "../src/bundle/plugin.ts";
import { synthDDL } from "../src/runtime/ddl.ts";

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
const fileMap = generateTypeScript(doc.parseResult.value);
const fs = new Map([...fileMap]);
const entry = "http/index.ts";
const schemaPath = schemaPathFor(entry);
if (!resolveInFs(fs, entry) || !resolveInFs(fs, schemaPath)) {
  console.error("entry/schema missing");
  process.exit(1);
}
console.log(`# generated ${fileMap.size} files`);

console.log("# 2/5 bundling (esbuild + esm.sh + plugin)…");
const ctx = {
  files: fs,
  fetchedUrls: new Set(),
  fetchCache: new Map(),
  versions: harvestVersions(fs),
};
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
  loader: { ".wasm": "binary" },
  plugins: [makeLoomPlugin(ctx)],
});
const bundleMs = Date.now() - bundleStart;
const code = out.outputFiles[0].text;
console.log(
  `# bundled ${(code.length / 1024).toFixed(0)} KB in ${bundleMs} ms (${ctx.fetchedUrls.size} esm.sh modules)`,
);

console.log("# 3/5 patching + writing bundle + importing…");
const { pgliteAssetUrl } = await import("../src/bundle/plugin.ts");
// Force PGlite's browser code path so it doesn't reach for
// node:fs/promises.readFile or createRequire.  PGlite has the same
// detection inlined into multiple Emscripten init functions, so we
// blanket-replace every occurrence.  Browser-side this branch falls
// through naturally because there's no Node `process`; Node-side we
// have to flip every detection point.
const detection = /typeof A7 == "object" && typeof A7\.versions == "object" && typeof A7\.versions\.node == "string"/g;
const matches = code.match(detection);
if (!matches || matches.length === 0) {
  console.error("FAIL: PGlite Node-detection pattern not found; bundle shape changed.");
  process.exit(1);
}
const patched = code.replace(detection, "false");
console.log(`# patched ${matches.length} Node-detection sites`);
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
