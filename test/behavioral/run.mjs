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
// It then joins the outcomes onto the generated requirements graph
// (.loom/traceability.json) via `computeVerification` for a per-system
// Definition-of-Done verdict.
//
// This promotes the behavioral domain assertions — which otherwise only
// run nightly in the docker `conformance-full` leg — to a fast, per-PR,
// docker-free gate for the Hono/TS backend.  It reuses the playground's
// own runners (web/src/testing/*, web/src/runtime/ddl, src/verify) so the
// node tier and the in-browser Tests tab share one execution path.
//
// Usage:  npm ci  (in this dir, once) ; node run.mjs [caseName...]
// Exit code is non-zero if any case errors, any test fails, or any
// requirement is FAILING in the rollup.

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
function entrySource({ deplDir, e2eFile, unitFiles, traceFile }) {
  const J = JSON.stringify;
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { createHarness, runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { computeVerification } from ${J(join(REPO, "src/verify/verification.ts"))};
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
const TRACE_FILE = ${J(traceFile)};
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

  // Definition-of-Done rollup: join these outcomes onto the generated
  // requirements graph (.loom/traceability.json) via the same
  // computeVerification the playground Tests tab uses.  Null when the
  // source declares no requirements/testCases.
  let verification = null;
  try {
    const trace = JSON.parse(readFileSync(TRACE_FILE, "utf8"));
    const outcomes = out.map((r) => ({ name: r.name, suite: r.suite, status: r.status }));
    verification = computeVerification(trace.index, trace.requirements.map((r) => r.id), outcomes);
  } catch {
    /* no traceability emitted — verification stays null */
  }

  return { results: out, verification };
}
`;
}

/** Load the typed feature corpus (`test/fixtures/corpus/manifest.ts`) via a
 *  one-shot esbuild bundle — the SAME single source of truth the generation and
 *  compile tiers iterate, so the behavioural tier needs no hand-maintained
 *  per-backend allowlist. */
async function loadCorpusFeatures() {
  mkdirSync(WORK, { recursive: true });
  const bundled = join(WORK, "_manifest.mjs");
  await build({ entryPoints: [join(REPO, "test/fixtures/corpus/manifest.ts")], outfile: bundled, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { CORPUS } = await import(pathToFileURL(bundled).href);
  return CORPUS;
}

/** True when a `.ddd` carries a behavioural block this tier can run — a
 *  `test e2e "…"` (api) or a domain `test "…"` (unit). Features without one are
 *  generation/compile-only for now and are skipped (nothing to boot). */
function hasBehaviouralBlock(src) {
  return /(^|\n)\s*test\s+e2e\s+"/.test(src) || /(^|\n)\s*test\s+"/.test(src);
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bh-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  try {
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, c.source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findNodeDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    // Tiers are DERIVED from the emitted file map, not declared: a system that
    // emits an e2e suite runs the api tier; one that emits unit tests runs the
    // unit tier. No api/unit flags to drift out of sync.
    const e2eFile = existsSync(e2eDir)
      ? walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null
      : null;
    const unitFiles = walk(deplDir, (p) => p.endsWith(".test.ts") && !p.includes("/e2e/"));

    const traceFile = join(genDir, ".loom", "traceability.json");
    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource({ deplDir, e2eFile, unitFiles, traceFile }));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

// Feature cases — DERIVED from the typed corpus manifest: every feature that
// declares the `node` backend AND carries a behavioural block. One source of
// truth (manifest.ts + the `.ddd`), swapped to `node` in-process. No allowlist.
const featureCases = [];
for (const f of await loadCorpusFeatures()) {
  if (!f.backends.includes("node")) continue;
  const raw = readFileSync(join(REPO, "test/fixtures/corpus", `${f.id}.ddd`), "utf8");
  if (!hasBehaviouralBlock(raw)) continue;
  featureCases.push({ name: f.id, source: raw.replaceAll("__PLATFORM__", "node") });
}

// Example cases — the small curated set of broad, multi-aggregate systems that
// aren't single-feature corpus fixtures; the one thing left in corpus.json. Its
// UI-only entries are run-ui.mjs's job and are filtered out here.
const exampleCases = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases
  .filter((c) => !String(c.ddd).startsWith("corpus:") && (c.api || c.unit))
  .map((c) => ({ name: c.name, source: readFileSync(join(REPO, c.ddd), "utf8") }));

const corpus = [...featureCases, ...exampleCases].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// Both tiers gate: `api` (emitted `test e2e`) and `unit` (emitted
// aggregate `test`). A boot/infra error, or a FAILING requirement in the
// Definition-of-Done rollup, fails the case.
let pass = 0, fail = 0, errored = 0, reqFailing = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}\n`);
  let out;
  try {
    out = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR booting/running: ${err?.message ?? err}\n`);
    continue;
  }
  for (const r of out.results) {
    const ok = r.status === "pass";
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [${r.tier}] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
  const v = out.verification;
  if (v && v.summary.total > 0) {
    const s = v.summary;
    reqFailing += s.failing;
    process.stdout.write(
      `  ⟐ requirements: ${s.verified}/${s.total} verified` +
        `${s.failing ? `, ${s.failing} FAILING` : ""}` +
        `${s.unverified ? `, ${s.unverified} unverified` : ""}` +
        `${s.untested ? `, ${s.untested} untested` : ""}\n`,
    );
    for (const [id, r] of Object.entries(v.requirements)) {
      if (r.verdict === "FAILING") process.stdout.write(`      ✗ ${id} FAILING (${r.failingTestCaseIds.join(", ")})\n`);
    }
  }
}

const reqTail = reqFailing ? `, ${reqFailing} requirement(s) FAILING` : "";
process.stdout.write(`\n${pass} passed, ${fail} failed${reqTail}${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 || reqFailing > 0 ? 1 : 0);
