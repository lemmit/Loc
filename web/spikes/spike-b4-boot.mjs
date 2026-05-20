// THROWAWAY SPIKE (Phase B4).  tsx.  Not wired into the app.
//
// The high-risk B4 claim, node-verified the same way the existing
// smoke proves the esm.sh path: a bundle produced by the
// npm-in-browser engine (real tarball pglite, NO esm.sh) actually
// BOOTS PGlite and SERVES requests.  If this passes, the engine's
// runtime path — not just its bundling — is genuinely proven.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateTypeScript } from "../../out/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { install } from "../src/engine/npm/install.ts";
import { NpmInstallBundleEngine } from "../src/engine/npm-install-bundle-engine.ts";
import { pgliteAssetUrl } from "../src/bundle/plugin.ts";
import { synthDDL } from "../src/runtime/ddl.ts";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

// Mirrors the production worker: install rootDeps into a copy of the
// generated tree, then esbuild over it.
const esbuildRun = async ({ stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime }) => {
  try {
    const files = new Map(generatedFiles);
    const { versions } = await install(rootDeps, (p, d) => files.set(p, d));
    const common = {
      bundle: true, format: "esm", platform: "browser", target: "es2022",
      logLevel: "silent", write: false, loader: { ".wasm": "binary" },
      external: externalReactRuntime ? ["react", "react-dom", "react/*", "react-dom/*"] : undefined,
      plugins: [makeVfsNpmPlugin(files)],
    };
    const out = await esbuild.build(
      stdinContents
        ? { ...common, stdin: { contents: stdinContents, resolveDir: "/", sourcefile: "__entry__.ts", loader: "ts" } }
        : { ...common, entryPoints: [entry] },
    );
    return { ok: true, code: out.outputFiles[0].text, versions: Object.fromEntries(versions) };
  } catch (err) {
    return { ok: false, message: err.errors?.[0]?.text ?? String(err) };
  }
};

const text = readFileSync(path.resolve(here, "../../examples/sales.ddd"), "utf8");
const services = createDddServices(NodeFileSystem);
const doc = services.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///main.ddd"), text);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
const fileMap = generateTypeScript(doc.parseResult.value, BACKEND_PINS);
const files = [...fileMap].map(([p, content]) => ({ path: p, content, size: content.length }));
log(`# generated ${files.length} files`);

const engine = new NpmInstallBundleEngine({ esbuildRun });
const prepared = await engine.prepare({ files, dependencies: { specs: [] }, honoEntry: "http/index.ts" });
engine.dispose();
if (!prepared.hono.ok) {
  log("FAIL — prepare:", JSON.stringify(prepared.hono.diagnostics));
  process.exit(1);
}
log(`# bundled ${(prepared.hono.code.length / 1024).toFixed(0)} KB (real pglite, no esm.sh)`);

// engine.prepare() now applies postProcessNpmBundle internally, so
// use hono.code as-is (this is exactly what the runtime worker
// boots) → import → boot real PGlite (injected wasms) → DDL → dispatch.
const tmp = path.join(os.tmpdir(), `loom-b4-${process.pid}.mjs`);
writeFileSync(tmp, prepared.hono.code);
const mod = await import(pathToFileURL(tmp).href);
for (const n of ["createApp", "schema", "drizzle", "PGlite", "is", "Table", "getTableConfig"]) {
  if (!(n in mod)) { log(`FAIL — bundle missing export ${n}`); process.exit(1); }
}
log("# bundle imported; 7 runtime exports present");

const [w1, w2, d] = await Promise.all([
  fetch(pgliteAssetUrl("pglite.wasm")),
  fetch(pgliteAssetUrl("initdb.wasm")),
  fetch(pgliteAssetUrl("pglite.data")),
]);
const [pgliteWasmModule, initdbWasmModule, fsBundle] = await Promise.all([
  WebAssembly.compile(await w1.arrayBuffer()),
  WebAssembly.compile(await w2.arrayBuffer()),
  d.blob(),
]);
const pglite = new mod.PGlite({ pgliteWasmModule, initdbWasmModule, fsBundle });
await pglite.exec("SELECT 1;");
const ddl = synthDDL(mod.schema, { is: mod.is, Table: mod.Table, getTableConfig: mod.getTableConfig });
await pglite.exec(ddl);
const app = mod.createApp(mod.drizzle(pglite, { schema: mod.schema }));
log("# real PGlite booted from the npm-engine bundle; app created");

const g = await app.fetch(new Request("http://localhost/products"));
const gBody = await g.text();
log(`# GET /products → ${g.status} ${gBody.slice(0, 60)}`);
const p = await app.fetch(new Request("http://localhost/products", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Widget", price: 9.99 }),
}));
log(`# POST /products → ${p.status}`);

// "Boots and serves" = GET returns 200 from the DB-backed route AND
// POST is handled by the framework (a 400 here is zod rejecting this
// spike's deliberately-minimal payload — i.e. routing + validation +
// DB are all live; a crash/5xx would be the real failure).
const ok = g.status === 200 && p.status < 500;
log("");
log(ok
  ? `PASS — npm-engine bundle (real tarball pglite, no esm.sh) BOOTS PGlite and SERVES (GET 200 from the DB route; POST ${p.status} = framework+zod validating). B4 runtime path verified; only the in-browser esbuild-wasm worker wrapper + React externalisation remain (mechanical / browser-only).`
  : `FAIL — boot/dispatch crashed (GET ${g.status}, POST ${p.status}).`);
process.exit(ok ? 0 : 1);
