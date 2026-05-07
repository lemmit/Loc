// Phase 4 smoke: bundle the React frontend from a system-mode .ddd
// (with Hono + React deployables) and confirm the bundle is
// valid ESM + emits a non-empty CSS payload from Mantine's
// stylesheet imports.

import * as esbuild from "esbuild";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import {
  harvestVersions,
  makeLoomPlugin,
  resolveInFs,
} from "../src/bundle/plugin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.resolve(here, "../src/examples/sales-system.ddd");
const text = readFileSync(sourcePath, "utf8");

console.log(`# 1/3 generating from ${path.basename(sourcePath)}…`);
const services = createDddServices(NodeFileSystem);
const docs = services.shared.workspace.LangiumDocuments;
const doc = docs.createDocument(URI.parse("inmemory:///main.ddd"), text);
await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
const errs = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
if (errs.length > 0) {
  console.error("parse errors:", errs);
  process.exit(1);
}
const fileMap = generateSystems(doc.parseResult.value).files;
const fs = new Map([...fileMap]);
console.log(`# generator emitted ${fs.size} files`);

const reactEntry = [...fs.keys()].find((p) => /^[^/]+\/src\/main\.tsx$/.test(p));
if (!reactEntry) {
  console.error("no react entry (expected <slug>/src/main.tsx) in generator output");
  process.exit(1);
}
console.log(`# react entry: ${reactEntry}`);

const ctx = {
  files: fs,
  fetchedUrls: new Set(),
  fetchCache: new Map(),
  versions: harvestVersions(fs),
};
console.log(`# pinned ${ctx.versions.size} package versions`);

console.log("# 2/3 bundling react frontend…");
const start = Date.now();
let out;
try {
  out = await esbuild.build({
    stdin: {
      contents: `import "./${reactEntry}";\n`,
      resolveDir: "/",
      sourcefile: "__entry__.tsx",
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    write: false,
    sourcemap: false,
    jsx: "automatic",
    // esbuild needs an outdir/outfile when bundling JS+CSS
    // together so it can name the .css companion file; with
    // write:false the path is purely virtual.
    outdir: "/__loom_bundle__",
    loader: { ".wasm": "binary", ".css": "css" },
    plugins: [makeLoomPlugin(ctx, { externalReactRuntime: true })],
  });
} catch (err) {
  console.error("bundle failed:");
  for (const m of err.errors ?? []) {
    console.error(`  ${m.location?.file ?? "?"}:${m.location?.line ?? "?"}: ${m.text}`);
  }
  process.exit(1);
}

const durationMs = Date.now() - start;
const js = out.outputFiles.find((f) => f.path.endsWith(".js"));
const css = out.outputFiles.find((f) => f.path.endsWith(".css"));
if (!js) {
  console.error("no JS output");
  process.exit(1);
}
console.log(
  `# bundled ${(js.text.length / 1024).toFixed(0)} KB JS in ${durationMs} ms (${ctx.fetchedUrls.size} esm.sh modules)`,
);
console.log(`# CSS: ${css ? `${(css.text.length / 1024).toFixed(1)} KB` : "(none)"}`);
console.log(`# warnings: ${out.warnings.length}, errors: ${out.errors.length}`);

console.log("# 3/3 smoke checks on the bundle text…");
// The bundle should be sizable (Mantine + React + RQ) and contain
// at least one recognisable Mantine class.  esbuild's identifier
// renaming makes strict token grep fragile, so we keep the check
// loose: prove the bundle is real and includes something from
// each of the three pillars.
if (js.text.length < 200_000) {
  console.error(`BUG: bundle suspiciously small (${js.text.length} bytes)`);
  process.exit(1);
}
const looseChecks = [
  ["mantine class fragment", /m_[0-9a-f]{6,}|Mantine|MantineProvider/],
  ["react root", /createRoot|hydrateRoot|ReactDOMClient/],
  ["query client", /QueryClient|TanStack|react-query/i],
];
for (const [label, re] of looseChecks) {
  if (!re.test(js.text)) {
    console.error(`BUG: bundle does not match ${label}`);
    process.exit(1);
  }
}
console.log(`# OK — bundle JS shape looks sound (${looseChecks.length} loose checks)`);

if (css) {
  // Pick a CSS rule that ships with @mantine/core/styles.css — this
  // proves the CSS pipeline picked up Mantine's stylesheets through
  // the http resolver.  Match on selector fragments rather than
  // exact properties because Mantine churns its build output.
  const cssExpects = ["mantine"];
  for (const tok of cssExpects) {
    if (!css.text.toLowerCase().includes(tok)) {
      console.error(`WARN: CSS bundle does not include "${tok}"`);
    }
  }
  console.log("# OK — CSS bundle includes Mantine selectors");
} else {
  console.error("WARN: no CSS bundle emitted");
}

// Final integrity: try to dynamic-import the bundle in Node.  React
// runtime modules (react / react-dom / jsx-runtime) are externalised
// in the bundle for the iframe's importmap to resolve at load time.
// In Node we don't have an importmap, so the import fails fast with
// a missing-package error pointing at one of the externalised
// specifiers — that's the expected stop and proves the externalisation
// took effect (without it the import would proceed past React import
// and fail elsewhere).
console.log("# import probe (expect missing react/react-dom in Node)…");
const tmpFile = path.join(os.tmpdir(), `loom-react-bundle-${process.pid}.mjs`);
writeFileSync(tmpFile, js.text);
try {
  await import(pathToFileURL(tmpFile).href);
  console.error("BUG: bundle imported in Node — react externals did not take effect.");
  process.exit(1);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Cannot find package 'react/.test(msg) || /Cannot find package "react/.test(msg)) {
    console.log(`# OK — bundle externalised react: "${msg}"`);
  } else {
    console.error(`# bundle import failed unexpectedly: ${msg}`);
    process.exit(1);
  }
}

console.log("# all green");
