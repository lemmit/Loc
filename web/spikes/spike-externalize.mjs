// THROWAWAY SPIKE (C2 step 2) — externalizeVendor: bundle ONLY the
// generated app (no vendor install, no vendor bundling).  Proves the
// esbuild-wasm input shrinks from MBs (app+vendor) to app-only, which
// is the ~15-26s -> ~1-2s bundle win.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { harvestTsconfigPaths } from "../src/bundle/plugin.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

const text = readFileSync(path.resolve(here, "../src/examples/storybook-mantine.ddd"), "utf8");
const s = createDddServices(NodeFileSystem);
const d = s.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///m.ddd"), text);
await s.shared.workspace.DocumentBuilder.build([d], { validation: true });
const fm = generateSystems(d.parseResult.value).files;
const entry = [...fm.keys()].find((p) => /\/src\/main\.tsx$/.test(p));

// NO install — vendor is externalised, only the generated app files
// are in the VFS.
const vfs = new Map();
for (const [p, c] of fm) vfs.set("/" + p, c);
const aliases = harvestTsconfigPaths(vfs, "/" + entry);

let ok = true,
  code = "";
const t0 = Date.now();
try {
  const out = await esbuild.build({
    entryPoints: ["/" + entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    logLevel: "silent",
    write: false,
    outdir: "/",
    plugins: [makeVfsNpmPlugin(vfs, "/node_modules", false, aliases, /* externalizeVendor */ true)],
  });
  code = (out.outputFiles.find((f) => f.path.endsWith(".js")) ?? out.outputFiles[0]).text;
} catch (err) {
  ok = false;
  log("FAIL — bundle errored:", err.errors?.[0]?.text ?? String(err));
}
const ms = Date.now() - t0;

const check = (label, cond) => { if (!cond) ok = false; log(`  ${cond ? "OK  " : "FAIL"} ${label}`); };
if (code) {
  log(`# app-only bundle: ${(code.length / 1024) | 0} KB in ${ms} ms (no install, vendor external)`);
  check("vendor left external (bare react/@mantine imports retained)", /from\s*["'](react|@mantine\/)/.test(code));
  check("app bundle is small (<800 KB — vendor not inlined)", code.length < 800_000);
  check("no Mantine source inlined (no MantineProvider impl)", !/function MantineProvider/.test(code));
}
log("");
log(ok ? "PASS — externalizeVendor bundles app-only; vendor stays external for the importmap." : "FAIL");
process.exit(ok ? 0 : 1);
