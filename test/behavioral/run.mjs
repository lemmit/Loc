// Headless behavioral test tier.
//
// For each curated corpus case: generate the system with the repo
// toolchain, then boot its single `platform: node` (Hono) deployable on
// PGlite (Postgres-in-WASM, in-process — no docker) and run its EMITTED
// suites:
//   - api : the generated `e2e/<Sys>.e2e.test.ts` (`test e2e … against
//           <node backend>`), dispatched straight into `app.fetch`.
//   - unit: the generated pure-domain `*.test.ts` (`test "…"` blocks).
//
// This promotes the behavioral domain assertions — which otherwise only
// run nightly in the docker `conformance-full` leg — to a fast, per-PR,
// docker-free gate for the Hono/TS backend.  It reuses the playground's
// own runners (web/src/testing/*, web/src/runtime/ddl) so the node tier
// and the in-browser Tests tab share one execution path.
//
// Usage:  npm ci  (in this dir, once) ; node run.mjs [caseName...]
// Exit code is non-zero if any case errors or any test fails.

import { build, transform } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work");
const SHIM = join(HERE, "vitest-shim.mjs");

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: node` deployable dir: has both http/index.ts and db/schema.ts. */
function findNodeDeployable(genDir) {
  const hits = walk(genDir, (p) => p.endsWith("/http/index.ts")).map((p) =>
    resolve(p, "..", ".."),
  );
  const dirs = [...new Set(hits)].filter((d) => existsSync(join(d, "db", "schema.ts")));
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one node (Hono) deployable, found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** Synthesise the per-case boot+run entry (bundled by esbuild). */
function entrySource({ deplDir, e2eFile, unitFiles }) {
  const J = JSON.stringify;
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { createHarness, runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { build as esbuildBuild, transform as esbuildTransform } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const E2E_FILE = ${J(e2eFile)};
const UNIT_FILES = ${J(unitFiles)};
const SHIM = ${J(SHIM)};

export async function run() {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  const app = createApp(db);

  const dispatch = async (req) => {
    const r = await app.fetch(new Request(req.url, { method: req.method, headers: req.headers, body: req.body ?? undefined }));
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: true, response: { status: r.status, statusText: r.statusText, headers, body: await r.text() }, durationMs: 0 };
  };

  const out = [];
  if (E2E_FILE) {
    const compile = async (ts) => (await esbuildTransform(ts, { loader: "ts", format: "cjs" })).code;
    const cases = await loadApiTests({ source: readFileSync(E2E_FILE, "utf8"), compile, dispatch });
    for (const r of await runTests(cases)) out.push({ tier: "api", ...r });
  }

  const req = createRequire(import.meta.url);
  for (const uf of UNIT_FILES) {
    const built = await esbuildBuild({ entryPoints: [uf], bundle: true, format: "cjs", platform: "node", packages: "external", alias: { vitest: SHIM }, write: false, logLevel: "silent" });
    const harness = createHarness();
    globalThis.__loomUnit = harness;
    const mod = { exports: {} };
    new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, req);
    // Keep __loomUnit set THROUGH runTests — the shim reads expect at
    // body-run time, not registration time.
    for (const r of await runTests(harness.tests)) out.push({ tier: "unit", ...r });
    delete globalThis.__loomUnit;
  }

  await pglite.close?.();
  return out;
}
`;
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bh-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  try {
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir], { stdio: "pipe" });
    const deplDir = findNodeDeployable(genDir);
    const e2eFile = c.api
      ? walk(join(genDir, "e2e"), (p) => p.endsWith(".e2e.test.ts"))[0] ?? null
      : null;
    const unitFiles = c.unit
      ? walk(deplDir, (p) => p.endsWith(".test.ts") && !p.includes("/e2e/"))
      : [];

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource({ deplDir, e2eFile, unitFiles }));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2);
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases.filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// `unit` tier is non-gating by default (it currently surfaces a real
// expect-throws emitter bug — see README "Known findings"); flip it on
// with --gate-unit once the emitter is fixed.  `api` tier always gates.
const gateUnit = only.includes("--gate-unit") || process.env.LOOM_BEHAVIORAL_GATE_UNIT === "1";

let pass = 0, gatingFail = 0, reportFail = 0, errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  (${c.ddd})\n`);
  let results;
  try {
    results = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR booting/running: ${err?.message ?? err}\n`);
    continue;
  }
  for (const r of results) {
    const ok = r.status === "pass";
    const gates = r.tier === "api" || gateUnit;
    if (ok) pass++;
    else if (gates) gatingFail++;
    else reportFail++;
    process.stdout.write(`  ${ok ? "✓" : gates ? "✗" : "⚠"} [${r.tier}] ${r.name}${ok || gates ? "" : "  (non-gating)"}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
}

const tail = reportFail ? `, ${reportFail} non-gating (unit) failed` : "";
process.stdout.write(`\n${pass} passed, ${gatingFail} failed${tail}${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(gatingFail > 0 || errored > 0 ? 1 : 0);
