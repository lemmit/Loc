// THROWAWAY SPIKE (Phase B3c).  Run with tsx.  Not wired into the app.
//
// Drives the assembled NpmInstallBundleEngine class end-to-end:
// prepare() = harvest deps from the generated package.json → install
// real tarballs → bundle via makeVfsNpmPlugin.  Node esbuild is
// injected as the EsbuildRun (B4 supplies the esbuild-wasm worker).
// Proves the CLASS works, not just the loose parts.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateTypeScript } from "../../out/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { install } from "../src/engine/npm/install.ts";
import { NpmInstallBundleEngine } from "../src/engine/npm-install-bundle-engine.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

// node-esbuild EsbuildRun: the seam B4 fills with an esbuild-wasm worker.
// Mirrors the production worker: install rootDeps into a copy of the
// generated tree, then esbuild over it.
const esbuildRun = async ({ stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime }) => {
  try {
    const files = new Map(generatedFiles);
    const { versions } = await install(rootDeps, (p, d) => files.set(p, d));
    const common = {
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
      write: false,
      loader: { ".wasm": "binary" },
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
    return { ok: false, message: (err.errors?.[0]?.text) ?? String(err) };
  }
};

// Generate the Sales-System backend.
const text = readFileSync(path.resolve(here, "../../examples/sales.ddd"), "utf8");
const services = createDddServices(NodeFileSystem);
const doc = services.shared.workspace.LangiumDocuments.createDocument(
  URI.parse("inmemory:///main.ddd"),
  text,
);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
const fileMap = generateTypeScript(doc.parseResult.value, BACKEND_PINS);
const files = [...fileMap].map(([p, content]) => ({
  path: p,
  content,
  size: content.length,
}));
log(`# generated ${files.length} files`);

// Drive the real engine class.
const engine = new NpmInstallBundleEngine({ esbuildRun });
const t0 = Date.now();
const prepared = await engine.prepare({
  files,
  dependencies: { specs: [] },
  honoEntry: "http/index.ts",
});
log(`# engine.prepare() in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
engine.dispose();

const ok =
  prepared.hono.ok &&
  /createApp/.test(prepared.hono.code) &&
  /extractUsedTable/.test(prepared.hono.code) &&
  prepared.hono.code.length > 50_000;
log(`  hono.ok=${prepared.hono.ok} createApp=${prepared.hono.ok && /createApp/.test(prepared.hono.code)} realDrizzle=${prepared.hono.ok && /extractUsedTable/.test(prepared.hono.code)}`);
if (!prepared.hono.ok) log(`  diagnostics: ${JSON.stringify(prepared.hono.diagnostics)}`);

log("");
log(
  ok
    ? "PASS — NpmInstallBundleEngine.prepare() assembles install + VFS bundle into a valid PreparedBuild with real drizzle. Class verified; B4 = esbuild-wasm worker builder + boot parity (real-pglite postprocess, React externalisation)."
    : "FAIL — engine.prepare did not produce a valid hono bundle.",
);
process.exit(ok ? 0 : 1);
