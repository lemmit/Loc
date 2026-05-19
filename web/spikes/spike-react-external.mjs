// THROWAWAY SPIKE (review #2 parity).  tsx.  Not wired into the app.
//
// Node-verifies the #2 mechanism that can't be browser-checked here:
// when NpmInstallBundleEngine bundles a system-mode React frontend,
// react/react-dom are kept EXTERNAL (so the iframe importmap supplies
// one shared instance) rather than a second React being bundled in —
// the dual-React / "Invalid hook call" failure the default-flip would
// otherwise risk.  Full preview correctness (importmap injection in
// iframe-html) remains e2e; this proves the engine half.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import { makeVfsNpmPlugin } from "../src/engine/npm/esbuild-vfs-plugin.ts";
import { install } from "../src/engine/npm/install.ts";
import { NpmInstallBundleEngine } from "../src/engine/npm-install-bundle-engine.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log(...a);

// Mirrors the production worker (install rootDeps → esbuild), honours
// externalReactRuntime exactly as the worker does.
const esbuildRun = async ({ stdinContents, entry, generatedFiles, rootDeps, externalReactRuntime }) => {
  try {
    const files = new Map(generatedFiles);
    const { versions } = await install(rootDeps, (p, d) => files.set(p, d));
    const common = {
      bundle: true, format: "esm", platform: "browser", target: "es2022",
      logLevel: "silent", write: false, outdir: "/", loader: { ".wasm": "binary" },
      plugins: [makeVfsNpmPlugin(files, "/node_modules", !!externalReactRuntime)],
    };
    const out = await esbuild.build(
      stdinContents
        ? { ...common, stdin: { contents: stdinContents, resolveDir: "/", sourcefile: "__entry__.ts", loader: "ts" } }
        : { ...common, entryPoints: [entry] },
    );
    const js = out.outputFiles.find((f) => f.path.endsWith(".js")) ?? out.outputFiles[0];
    const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
    return { ok: true, code: js.text, css: css?.text, versions: Object.fromEntries(versions) };
  } catch (err) {
    return { ok: false, message: err.errors?.[0]?.text ?? String(err) };
  }
};

// System-mode generate (acme.ddd has Hono + React deployables).
const text = readFileSync(path.resolve(here, "../../examples/acme.ddd"), "utf8");
const services = createDddServices(NodeFileSystem);
const doc = services.shared.workspace.LangiumDocuments.createDocument(URI.parse("inmemory:///main.ddd"), text);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
const fileMap = generateSystems(doc.parseResult.value).files;
const files = [...fileMap].map(([p, content]) => ({ path: p, content, size: content.length }));

const honoEntry = [...fileMap.keys()].find((p) => /^[^/]+\/http\/index\.ts$/.test(p));
const reactEntry = [...fileMap.keys()].find((p) => /^[^/]+\/src\/main\.tsx$/.test(p));
log(`# generated ${files.length} files; hono=${honoEntry} react=${reactEntry}`);
if (!honoEntry || !reactEntry) { log("FAIL — example lacks Hono+React deployables"); process.exit(1); }

const engine = new NpmInstallBundleEngine({ esbuildRun });
const prepared = await engine.prepare({ files, dependencies: { specs: [] }, honoEntry, reactEntry });
engine.dispose();

const r = prepared.react;
let ok = true;
const check = (label, cond) => { log(`  ${cond ? "OK  " : "FAIL"} ${label}`); if (!cond) ok = false; };

check("hono bundle ok", prepared.hono.ok);
check("react bundle present + ok", r != null && r.ok);
if (r && r.ok) {
  check("Mantine CSS extracted (react.css non-empty)", !!r.css && r.css.length > 1000);
  // React 19 + automatic JSX: the app imports react/jsx-runtime and
  // react-dom/client (not bare "react"); the external react/* +
  // react-dom/* globs keep those out of the bundle.
  check(
    "react runtime kept EXTERNAL (react / react-dom imports retained)",
    /from\s*"(react|react-dom)(\/[^"]+)?"/.test(r.code),
  );
  check(
    "react-dom client kept EXTERNAL",
    /from\s*"react-dom(\/[^"]+)?"/.test(r.code),
  );
  // A second bundled React would carry its scheduler/runtime guts; a
  // properly-externalised bundle does not define them locally.
  check(
    "no second React bundled in (no react reconciler internals)",
    !/__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED/.test(r.code),
  );
  check("versions carry react for the importmap", !!r.versions.react);
  check("versions carry react-dom for the importmap", !!r.versions["react-dom"]);
}

log("");
log(ok
  ? "PASS — npm engine keeps React external on the frontend build (importmap supplies one instance). #2 engine-half verified; only iframe importmap wiring remains for e2e."
  : "FAIL — React not externalised as expected; #2 still a default-flip risk.");
process.exit(ok ? 0 : 1);
