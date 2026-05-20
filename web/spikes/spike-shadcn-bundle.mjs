// THROWAWAY SPIKE — full shadcn frontend bundle via the npm pipeline,
// mirroring the worker (install + jsx:automatic + makeVfsNpmPlugin
// with harvested tsconfig aliases).  Confirms the two preview bugs
// are fixed: `@/...` aliases resolve, and JSX uses the automatic
// runtime (no "React is not defined").

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import { harvestTsconfigPaths } from "../src/bundle/plugin.ts";
import { install } from "../src/engine/npm/install.ts";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

const text = readFileSync(path.resolve(here, "../src/examples/storybook-shadcn.ddd"), "utf8");
const s = createDddServices(NodeFileSystem);
const d = s.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///m.ddd"), text);
await s.shared.workspace.DocumentBuilder.build([d], { validation: true });
const fm = generateSystems(d.parseResult.value).files;
const entry = [...fm.keys()].find((p) => /^[^/]+\/src\/main\.tsx$/.test(p));
const slug = entry.split("/")[0];
log(`# generated ${fm.size} files; react entry ${entry}`);

const vfs = new Map();
for (const [p, c] of fm) vfs.set("/" + p, c);

const reactDeps = JSON.parse(fm.get(`${slug}/package.json`)).dependencies ?? {};
log(`# installing ${Object.keys(reactDeps).length} frontend deps…`);
const t0 = Date.now();
const { fileCount } = await install(reactDeps, (p, dd) => vfs.set(p, dd));
log(`# installed ${fileCount} files in ${Date.now() - t0} ms`);

const aliases = harvestTsconfigPaths(vfs, "/" + entry);
let ok = true,
  code = "";
try {
  const out = await esbuild.build({
    entryPoints: ["/" + entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
    outdir: "/",
    jsx: "automatic",
    loader: { ".wasm": "binary" },
    plugins: [makeVfsNpmPlugin(vfs, "/node_modules", false, aliases)],
  });
  code = (out.outputFiles.find((f) => f.path.endsWith(".js")) ?? out.outputFiles[0]).text;
} catch (err) {
  ok = false;
  log("FAIL — bundle errored:");
  for (const e of err.errors ?? [{ text: String(err) }]) log("  " + e.text);
}

const check = (label, cond) => {
  if (!cond) ok = false;
  log(`  ${cond ? "OK  " : "FAIL"} ${label}`);
};
if (code) {
  check("@/ aliases resolved (no bare @/ in bundle)", !/from\s*["']@\//.test(code));
  check("automatic JSX runtime (no bare React.createElement reliance)", /jsxs?\(|react\/jsx-runtime/.test(code));
  check("bundle non-trivial", code.length > 50_000);
}
log("");
log(ok ? "PASS — shadcn frontend bundles via npm pipeline (@/ + jsx automatic)." : "FAIL");
process.exit(ok ? 0 : 1);
