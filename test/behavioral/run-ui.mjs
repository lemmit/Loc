// Headless behavioral UI test tier (the sibling of run.mjs).
//
// For each corpus case with a React frontend + UI e2e: generate the
// system, `vite build` its generated React frontend, then serve that
// built bundle AND the generated Hono backend (on PGlite, in-process —
// no docker) from ONE in-process node HTTP server (static dist + `/api`
// delegated straight to `app.fetch`, same origin, no proxy/CORS), and
// run the EMITTED Playwright spec — the one Loom lowers from
//   test e2e "…" against <react-deployable>
// — against the live stack with a real (headless Chromium) browser.
//
// This is the UI counterpart to run.mjs's `api`/`unit` tiers: a fast,
// docker-free, per-PR gate for the page-object round-trips
// (`ui.orders.create(...)` → submit → read back) that the in-process
// `app.fetch` API tier can't exercise.  It closes the rollup gap run.mjs
// flagged: `against <web>` UI testCases were "unverified" until this tier
// landed.  It sidesteps the playground's in-browser npm bundle entirely
// (and so issue #1242) — the frontend is built with the same `vite build`
// the generated-*-e2e workflows use.
//
// The stack wiring itself (locate the deployables, build the frontend,
// serve dist + /api from one origin) lives in `ui-stack.mjs`, shared with
// `paged-ui.mjs`.  Two things about it are easy to get wrong:
//   1. The browser, the backend and the static bundle all share ONE
//      origin (one node server), so there is no proxy and no CORS.
//   2. Playwright is launched with async `spawn` (NOT `spawnSync`):
//      `spawnSync` blocks the event loop, which would freeze the
//      in-process server so every request hangs.
//
// Heavier than run.mjs (a real `npm install` of the React/Mantine tree +
// `vite build` + a Chromium download), so it is opt-in: its own npm
// script + CI workflow, never part of the fast `npm test`.
//
// Usage:  npm ci  (in this dir, once) ; node run-ui.mjs [caseName...]
// Exit code is non-zero if any case errors, any UI test fails, or any
// requirement is FAILING in the Definition-of-Done rollup.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildServerModule,
  findDistRoot,
  findFrontendDeployable,
  findNodeDeployable,
  outcomesFromPlaywrightJson,
  walk,
} from "./ui-stack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-ui");

/** Definition-of-Done rollup: join UI outcomes onto the requirements
 *  graph via the same computeVerification run.mjs / the playground use. */
async function rollup(genDir, workDir, outcomes) {
  const traceFile = join(genDir, ".loom", "traceability.json");
  if (!existsSync(traceFile)) return null;
  const entry = join(workDir, "verify-entry.mts");
  const bundle = join(workDir, "verify-bundle.mjs");
  writeFileSync(
    entry,
    `export { computeVerification } from ${JSON.stringify(join(REPO, "src/verify/verification.ts"))};\n`,
  );
  await build({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    logLevel: "warning",
  });
  const { computeVerification } = await import(pathToFileURL(bundle).href);
  const trace = JSON.parse(readFileSync(traceFile, "utf8"));
  return computeVerification(
    trace.index,
    trace.requirements.map((r) => r.id),
    outcomes,
  );
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhui-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    execFileSync(
      "node",
      [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir],
      { stdio: "pipe" },
    );
    const frontendDir = findFrontendDeployable(genDir);
    const e2eDir = join(frontendDir, "e2e");
    const uiSpecs = walk(e2eDir, (p) => p.endsWith(".ui.spec.ts"));
    if (uiSpecs.length === 0) return { skipped: "no .ui.spec.ts emitted" };
    const deplDir = findNodeDeployable(genDir);

    // 1. Build the generated frontend via ITS OWN build script (react/vue →
    //    vite→dist, svelte → vite→build, angular → ng→dist/<app>/browser,
    //    feliz → fable+vite→dist).  `npm run build` picks the right one per
    //    package.json; findDistRoot locates the emitted index.html.
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: frontendDir, stdio: "pipe" });
    const pkg = JSON.parse(readFileSync(join(frontendDir, "package.json"), "utf8"));
    if (pkg.scripts?.build) execFileSync(npm, ["run", "build"], { cwd: frontendDir, stdio: "pipe" });
    else execFileSync(npx, ["vite", "build"], { cwd: frontendDir, stdio: "pipe" });
    const distDir = findDistRoot(frontendDir);

    // 2. Boot ONE in-process server: built SPA + the generated Hono
    //    backend on PGlite (/api), same origin.
    const { startServer } = await buildServerModule(deplDir, workDir);
    server = await startServer({ distDir });
    process.stdout.write(`    stack on :${server.port}\n`);

    // 3. Install the e2e deps + Chromium, then run the emitted UI spec.
    //    ASYNC spawn — `spawnSync` would block the event loop and freeze
    //    the in-process server.
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: e2eDir, stdio: "pipe" });
    execFileSync(npx, ["playwright", "install", "--with-deps", "chromium"], {
      cwd: e2eDir,
      stdio: "pipe",
    });
    const reportFile = join(workDir, "report.json");
    await new Promise((res) => {
      const cp = spawn(npx, ["playwright", "test", "--reporter=list,json"], {
        cwd: e2eDir,
        stdio: "inherit",
        env: {
          ...process.env,
          E2E_BASE_URL: `http://127.0.0.1:${server.port}`,
          PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
        },
      });
      cp.on("exit", res);
    });
    if (!existsSync(reportFile)) throw new Error("Playwright produced no JSON report");
    const json = JSON.parse(readFileSync(reportFile, "utf8"));
    const results = outcomesFromPlaywrightJson(json).map((r) => ({ tier: "ui", ...r }));
    const verification = await rollup(
      genDir,
      workDir,
      results.map((r) => ({ name: r.name, status: r.status })),
    );
    return { results, verification };
  } finally {
    if (server) await server.close().catch(() => {});
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// Nightly-tier cases (non-React frontends) run only when explicitly named or
// under `--all` / LOOM_UI_ALL — so the per-PR behavioral-ui gate stays React-only
// (no extra frontend build cost per PR) while the nightly matrix covers the rest.
const allTiers = process.argv.includes("--all") || process.env.LOOM_UI_ALL === "1";
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases.filter(
  (c) =>
    (only.length === 0 || only.includes(c.name)) &&
    c.ui !== false &&
    (only.length > 0 || allTiers || c.uiTier !== "nightly"),
);

let pass = 0;
let fail = 0;
let errored = 0;
let reqFailing = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  (${c.ddd})\n`);
  let out;
  try {
    out = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR: ${err?.message ?? err}\n`);
    continue;
  }
  if (out.skipped) {
    process.stdout.write(`  ⃠ skipped: ${out.skipped}\n`);
    continue;
  }
  for (const r of out.results) {
    const ok = r.status === "pass";
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [${r.tier}] ${r.name}\n`);
    if (!ok && r.error)
      process.stdout.write(
        `      ${String(r.error).replace(/\[[0-9;]*m/g, "").split("\n").slice(0, 4).join("\n      ")}\n`,
      );
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
      if (r.verdict === "FAILING")
        process.stdout.write(`      ✗ ${id} FAILING (${r.failingTestCaseIds.join(", ")})\n`);
    }
  }
}

const reqTail = reqFailing ? `, ${reqFailing} requirement(s) FAILING` : "";
process.stdout.write(
  `\n${pass} passed, ${fail} failed${reqTail}${errored ? `, ${errored} cases errored` : ""}\n`,
);
process.exit(fail > 0 || errored > 0 || reqFailing > 0 ? 1 : 0);
