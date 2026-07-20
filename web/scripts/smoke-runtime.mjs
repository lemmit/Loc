// Full end-to-end smoke: generate → install (real npm tarballs) →
// bundle (VFS-npm plugin, NO esm.sh) → import in Node → boot PGlite +
// the generated Hono app → dispatch + round-trip a product.
//
// Runs the SAME pipeline the browser runtime worker runs, against two
// generator shapes:
//
//   1. legacy single-context (`generateTypeScript`, unqualified
//      `pgTable(...)` — tables live in `public`), and
//   2. system mode (`generateSystems`, per-context `pgSchema(...)` —
//      tables live under e.g. `sales`, so the repositories query
//      schema-qualified relations `from "sales"."products"`).
//
// Case 2 is the reliable gate for the per-context-pgSchema regression:
// the playground's `synthDDL` must `CREATE SCHEMA` + schema-qualify its
// DDL, or the backend boots but every query 500s on a missing `sales.*`
// relation.  The browser e2e (`e2e/runtime.spec.ts`) covers the same
// path but self-skips when the npm registry is unreachable; this Node
// smoke runs wherever CI has network, with no skip.
//
// Switched off the esm.sh bundler: esm.sh serves a broken drizzle-orm
// build (pg-core/utils drops the `extractUsedTable` export), which
// fails every backend bundle — the exact bug class the npm-in-browser
// engine was built to escape.  This smoke exercises that engine's
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
import { API_BASE_PATH } from "../../out/util/api-base.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import { generateSystems } from "../../out/system/index.js";
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

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

/** Parse + generate a single source file, returning the generated file
 *  Map plus the chosen Hono entry path.  `mode: "legacy"` uses the
 *  single-context emitter (entry at the root); `mode: "system"` uses
 *  the system composer (entry under the deployable slug). */
async function generateBackend(sourcePath, mode) {
  const text = readFileSync(sourcePath, "utf8");
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = docs.createDocument(URI.parse("inmemory:///main.ddd"), text);
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  if ((doc.diagnostics ?? []).some((d) => d.severity === 1)) {
    fail(`parse/validation errors in ${path.basename(sourcePath)}`);
  }
  if (mode === "legacy") {
    const files = generateTypeScript(doc.parseResult.value, BACKEND_PINS);
    return { files, entry: "http/index.ts" };
  }
  const { files } = generateSystems(doc.parseResult.value);
  const entry = [...files.keys()].find((p) => /^[^/]+\/http\/index\.ts$/.test(p));
  if (!entry) fail(`no Hono deployable in system output for ${path.basename(sourcePath)}`);
  return { files, entry };
}

let pgliteAssetsPromise = null;
/** Fetch + compile PGlite's WASM/data once, reused across cases. */
function pgliteAssets() {
  if (!pgliteAssetsPromise) {
    pgliteAssetsPromise = (async () => {
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
      return { pgliteWasmModule, initdbWasmModule, fsBundle };
    })();
  }
  return pgliteAssetsPromise;
}

/** Run the full generate→install→bundle→boot→dispatch pipeline for one
 *  source and assert a clean product round-trip.  `expectSchemaQualified`
 *  additionally asserts the synthesised DDL declares a Postgres schema —
 *  so the system-mode case can't silently degrade into testing an
 *  unqualified backend (which would no longer guard the regression). */
async function runCase({ label, sourcePath, mode, expectSchemaQualified }) {
  console.log(`\n=== case: ${label} (${path.basename(sourcePath)}) ===`);

  console.log("# 1/5 generating…");
  const { files, entry } = await generateBackend(sourcePath, mode);
  const schemaPath = schemaPathFor(entry);
  if (!resolveInFs(files, entry) || !resolveInFs(files, schemaPath)) {
    fail(`entry/schema missing (${entry} / ${schemaPath})`);
  }
  console.log(`# generated ${files.size} files; entry ${entry}`);

  console.log("# 2/5 installing real npm tarballs + bundling (VFS plugin, no esm.sh)…");
  const vfs = new Map();
  for (const [p, c] of files) vfs.set("/" + p, c);
  // The Hono deployable's package.json sits next to its entry: at the
  // root for legacy mode, under the slug for system mode.
  const slugMatch = entry.match(/^(.+)\/http\/index\.ts$/);
  const pkgPath = slugMatch ? `${slugMatch[1]}/package.json` : "package.json";
  const pkg = JSON.parse(files.get(pkgPath) ?? "{}");
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
  console.log(`# bundled ${(code.length / 1024).toFixed(0)} KB in ${Date.now() - bundleStart} ms`);

  console.log("# 3/5 post-processing + importing…");
  const patched = postProcessNpmBundle(code);
  const tmpFile = path.join(os.tmpdir(), `loom-bundle-${mode}-${process.pid}.mjs`);
  writeFileSync(tmpFile, patched);
  const mod = await import(pathToFileURL(tmpFile).href);
  for (const name of ["createApp", "schema", "drizzle", "PGlite", "is", "Table", "getTableConfig"]) {
    if (!(name in mod)) fail(`bundle missing export: ${name}`);
  }

  console.log("# 4/5 DDL synth + PGlite + createApp…");
  const ddl = synthDDL(mod.schema, {
    is: mod.is,
    Table: mod.Table,
    getTableConfig: mod.getTableConfig,
  });
  if (expectSchemaQualified) {
    // Guards that this case is genuinely exercising a pgSchema-qualified
    // backend (the regression surface) — not silently a public-schema one.
    if (!/CREATE SCHEMA IF NOT EXISTS/.test(ddl)) {
      console.log("--- DDL ---\n" + ddl + "\n-----------");
      fail("expected a CREATE SCHEMA in the system-mode DDL (pgSchema not exercised)");
    }
    if (!/CREATE TABLE IF NOT EXISTS "[^"]+"\."products"/.test(ddl)) {
      console.log("--- DDL ---\n" + ddl + "\n-----------");
      fail('expected a schema-qualified "products" table in the system-mode DDL');
    }
    console.log("# DDL is schema-qualified (CREATE SCHEMA + qualified products table)");
  }

  const assets = await pgliteAssets();
  const pglite = new mod.PGlite(assets);
  await pglite.exec("SELECT 1;");
  await pglite.exec(ddl);
  const db = mod.drizzle(pglite, { schema: mod.schema });
  const app = mod.createApp(db);
  console.log("# app booted");

  console.log("# 5/5 dispatching requests against in-process backend…");
  // Domain routes mount under the shared API base path (`/api`); infra
  // (`/health`, `/ready`) stays at the root.
  const productsUrl = `http://localhost${API_BASE_PATH}/products`;
  const list0 = await app.fetch(new Request(productsUrl));
  if (list0.status !== 200)
    fail(`GET ${API_BASE_PATH}/products expected 200, got ${list0.status}: ${await list0.text()}`);

  const created = await app.fetch(
    new Request(productsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "WIDGET-1", price: { amount: 5.0, currency: "USD" } }),
    }),
  );
  if (created.status >= 400)
    fail(`POST ${API_BASE_PATH}/products returned ${created.status}: ${await created.text()}`);

  const list1 = await app.fetch(new Request(productsUrl));
  const body = await list1.text();
  if (list1.status !== 200) fail(`GET /products (after create) expected 200, got ${list1.status}: ${body}`);
  const parsed = JSON.parse(body);
  // A `crudish` aggregate's findAll returns the paged envelope
  // ({ items, page, pageSize, total, totalPages }); a plain findAll returns a
  // bare array. Accept either so the smoke matches the current contract.
  const rows = Array.isArray(parsed) ? parsed : parsed.items;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].sku !== "WIDGET-1") {
    fail(`expected 1 product 'WIDGET-1', got ${JSON.stringify(parsed)}`);
  }
  console.log(`# OK — round-tripped 1 product (${rows[0].sku}) through PGlite + drizzle + Hono`);

  await pglite.close();
}

await runCase({
  label: "legacy single-context (unqualified pgTable)",
  sourcePath: path.resolve(here, "../../examples/sales.ddd"),
  mode: "legacy",
  expectSchemaQualified: false,
});

await runCase({
  label: "system mode (per-context pgSchema)",
  sourcePath: path.resolve(here, "../src/examples/sales-system.ddd"),
  mode: "system",
  expectSchemaQualified: true,
});

console.log("\n# all green");
