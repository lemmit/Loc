// Build step (C1): produce a local npm tarball mirror for the curated
// stacks so the playground installs same-origin instead of hitting
// registry.npmjs.org — killing the ~30s cold install and the e2e
// network saturation.
//
// Generates each shipped example, collects every deployable's
// package.json dependencies, resolves the full transitive plan, and
// downloads each tarball into web/public/npm-mirror/ with a
// manifest.json mapping `name@version → filename`.  Run before
// `vite build` (CI has network); output is gitignored and copied
// into dist/ by Vite.  At runtime the vfs-bundler worker fetches the
// manifest and prefers these over the registry.

import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../../out/language/ddd-module.js";
import { generateSystems } from "../../out/system/index.js";
import { generateTypeScript } from "../../out/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../out/platform/hono/v4/pins.js";
import { planInstall } from "../src/engine/npm/resolve-tree.ts";
import { fetchTarball, fetchPackument, packumentFileName } from "../src/engine/npm/registry.ts";
import { RUNTIME_VERSIONS } from "../src/bundle/plugin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const outDir = path.resolve(here, "../public/npm-mirror");

// The examples a user can pick — generating each gives us the real
// dependency surface to mirror.  Single-context (.ts) examples use
// generateTypeScript; system-mode use generateSystems.
const EXAMPLES = [
  "examples/acme.ddd",
  "examples/sales.ddd",
  "web/src/examples/sales-system.ddd",
  "web/src/examples/banking-system.ddd",
  "web/src/examples/inventory-system.ddd",
  "web/src/examples/storybook-mantine.ddd",
  "web/src/examples/storybook-shadcn.ddd",
  "web/src/examples/storybook-shadcn-v4.ddd",
  "web/src/examples/storybook-mui.ddd",
  "web/src/examples/storybook-mui-v7.ddd",
  "web/src/examples/storybook-chakra.ddd",
  "web/src/examples/storybook-chakra-v3.ddd",
];

const services = createDddServices(NodeFileSystem);

function genFiles(text) {
  const doc = services.shared.workspace.LangiumDocuments.createDocument(
    URI.parse(`inmemory:///${Math.random().toString(36).slice(2)}.ddd`),
    text,
  );
  return services.shared.workspace.DocumentBuilder.build([doc], { validation: true }).then(() => {
    const model = doc.parseResult.value;
    // System mode when any deployable exists; else single Hono project.
    try {
      const sys = generateSystems(model).files;
      if (sys.size > 0) return sys;
    } catch {
      /* fall through to single-context */
    }
    return generateTypeScript(model, BACKEND_PINS);
  });
}

// Collect the union of all deployables' dependencies across examples.
const rootDeps = { "@electric-sql/pglite": RUNTIME_VERSIONS["@electric-sql/pglite"] };
for (const rel of EXAMPLES) {
  const abs = path.join(root, rel);
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    console.warn(`# skip (missing): ${rel}`);
    continue;
  }
  const files = await genFiles(text);
  for (const [p, c] of files) {
    if (!p.endsWith("package.json")) continue;
    try {
      const deps = JSON.parse(c).dependencies ?? {};
      Object.assign(rootDeps, deps);
    } catch {
      /* ignore malformed */
    }
  }
  console.log(`# collected deps from ${rel}`);
}
console.log(`# ${Object.keys(rootDeps).length} root deps; resolving full plan…`);

const plan = [...(await planInstall(rootDeps)).values()];
console.log(`# ${plan.length} packages to mirror`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const manifest = {};
let done = 0;
let skipped = 0;
const concurrency = 8;
let cursor = 0;
// Best-effort: retry each tarball, and on persistent failure SKIP it
// (omit from the manifest) rather than abort.  A skipped package just
// falls back to the registry at runtime — so a transient download
// failure can never break the deploy.
async function fetchWithRetry(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchTarball(url);
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}
async function worker() {
  while (cursor < plan.length) {
    const pkg = plan[cursor++];
    const key = `${pkg.name}@${pkg.version}`;
    const file = key.replace(/[@/]/g, "_") + ".tgz";
    try {
      const bytes = await fetchWithRetry(pkg.meta.dist.tarball);
      writeFileSync(path.join(outDir, file), bytes);
      manifest[key] = file;
    } catch (err) {
      skipped++;
      console.warn(`#   skip ${key}: ${err instanceof Error ? err.message : err}`);
    }
    if (++done % 20 === 0) console.log(`#   ${done}/${plan.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 0));
console.log(
  `# wrote ${Object.keys(manifest).length} tarballs + manifest.json` +
    (skipped ? ` (${skipped} skipped → registry fallback)` : "") +
    " to web/public/npm-mirror/",
);

// Packument mirror: cache each package's (abbreviated) metadata under
// packuments/ so the in-browser resolver (planInstall → fetchPackument)
// reads dependency metadata same-origin too.  Without this the bundler
// still hits registry.npmjs.org once per package for metadata — the
// residual traffic that saturates the e2e job under concurrency.  Per
// package best-effort: a miss just falls back to the registry at runtime.
const packDir = path.join(outDir, "packuments");
mkdirSync(packDir, { recursive: true });
const names = [...new Set(plan.map((p) => p.name))];
let pmDone = 0;
let pmSkipped = 0;
let pmCursor = 0;
async function packumentWithRetry(name, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fetchPackument(name);
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}
async function packumentWorker() {
  while (pmCursor < names.length) {
    const name = names[pmCursor++];
    try {
      const pack = await packumentWithRetry(name);
      writeFileSync(path.join(packDir, packumentFileName(name)), JSON.stringify(pack, null, 0));
    } catch (err) {
      pmSkipped++;
      console.warn(`#   skip packument ${name}: ${err instanceof Error ? err.message : err}`);
    }
    if (++pmDone % 40 === 0) console.log(`#   packuments ${pmDone}/${names.length}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, packumentWorker));
console.log(
  `# wrote ${names.length - pmSkipped} packuments` +
    (pmSkipped ? ` (${pmSkipped} skipped → registry fallback)` : "") +
    " to web/public/npm-mirror/packuments/",
);
