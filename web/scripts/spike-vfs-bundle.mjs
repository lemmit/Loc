// THROWAWAY SPIKE (Phase B3b).  Run with tsx.  Not wired into the app.
//
// The decisive proof: bundle a REAL generated Sales-System Hono
// backend through the VFS-npm esbuild plugin against real installed
// node_modules — the exact pipeline that fails on esm.sh today with
// "No matching export ... extractUsedTable".  Success here == the
// npm-in-browser engine fixes the drizzle blocker for real.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateTypeScript } from "../../out/generator/typescript/index.js";
import { makeEntryStdin, schemaPathFor } from "../src/bundle/plugin.ts";
import { install } from "../src/engine/npm/install.ts";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const log = (...a) => console.log(...a);
const here = path.dirname(fileURLToPath(import.meta.url));

// 1. generate the Sales-System backend (mirrors smoke-runtime.mjs).
const text = readFileSync(path.resolve(here, "../../examples/sales.ddd"), "utf8");
const services = createDddServices(NodeFileSystem);
const doc = services.shared.workspace.LangiumDocuments.createDocument(
  URI.parse("inmemory:///main.ddd"),
  text,
);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
if ((doc.diagnostics ?? []).some((d) => d.severity === 1)) {
  console.error("parse errors");
  process.exit(1);
}
const fileMap = generateTypeScript(doc.parseResult.value);
const entry = "http/index.ts";
const schemaPath = schemaPathFor(entry);
log(`# generated ${fileMap.size} files`);

// 2. one VFS: generated files (absolute) + installed node_modules.
/** @type {Map<string,string|Uint8Array>} */
const files = new Map();
for (const [p, c] of fileMap) files.set("/" + p, c);

const t0 = Date.now();
const res = await install(
  {
    hono: "^4.12.0",
    "@hono/zod-openapi": "^0.19.0",
    zod: "^3.24.0",
    "drizzle-orm": "^0.45.0",
    "@electric-sql/pglite": "0.4.5",
  },
  (p, d) => files.set(p, d),
);
log(`# installed ${res.versions.size} pkgs / ${res.fileCount} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 3. bundle through the VFS-npm plugin (no esm.sh).
const bundleStart = Date.now();
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
    plugins: [makeVfsNpmPlugin(files)],
  });
} catch (err) {
  log("FAIL — bundle errored:");
  for (const e of err.errors ?? [{ text: String(err) }]) log("  " + e.text);
  process.exit(1);
}
const code = out.outputFiles[0].text;
const ms = Date.now() - bundleStart;

// 4. verify: built clean, real createApp present, real drizzle code.
const hasCreateApp = /createApp/.test(code);
const hasDrizzle = /extractUsedTable/.test(code); // the symbol esm.sh DROPS — present here means real files bundled
log(`# bundled ${(code.length / 1024).toFixed(0)} KB in ${ms} ms`);
log(`  exports createApp: ${hasCreateApp}`);
log(`  contains real drizzle internals (extractUsedTable): ${hasDrizzle}`);

const ok = code.length > 50_000 && hasCreateApp && hasDrizzle;
log("");
log(
  ok
    ? "PASS — real generated backend bundles via the VFS-npm plugin with real drizzle (extractUsedTable present, not the esm.sh failure). The drizzle blocker is fixed by this engine. B3c (engine class + cache) is the remaining assembly."
    : "FAIL — bundle built but verification failed; inspect before B3c.",
);
process.exit(ok ? 0 : 1);
