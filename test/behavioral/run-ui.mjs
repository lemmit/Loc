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
// Two things make the wiring work and are easy to get wrong:
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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-ui");

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

/** Locate the built SPA root under a frontend dir — the dir that holds the
 *  emitted `index.html`.  Framework-agnostic: react/vue → `dist/`, SvelteKit
 *  (adapter-static) → `build/`, Angular → `dist/<app>/browser/`.  Excludes the
 *  source tree (a frontend's `index.html` also lives at its root pre-build) by
 *  only accepting a build-output dir (`dist`/`build` segment in the path). */
function findDistRoot(frontendDir) {
  const hits = walk(frontendDir, (p) => p.endsWith("/index.html")).filter((p) => {
    const rel = p.slice(frontendDir.length);
    return /[/\\](dist|build)[/\\]/.test(rel);
  });
  if (hits.length === 0) {
    throw new Error(`no built index.html under ${frontendDir} — did the frontend build?`);
  }
  // Prefer the shallowest (e.g. dist/index.html over a nested asset copy).
  hits.sort((a, b) => a.split("/").length - b.split("/").length);
  return dirname(hits[0]);
}

/** The frontend deployable dir: has e2e/playwright.config.ts.  Framework-agnostic
 *  — the emitted `.ui.spec.ts` + page objects are testid-driven, so the same
 *  round-trip runs against any frontend; the per-framework build command
 *  (`npm run build`) and built-root (findDistRoot) are resolved below. */
function findFrontendDeployable(genDir) {
  const hits = walk(genDir, (p) => p.endsWith("/e2e/playwright.config.ts")).map((p) =>
    resolve(p, "..", ".."),
  );
  const dirs = [...new Set(hits)];
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one frontend with a UI e2e suite (e2e/playwright.config.ts), found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** The bundled boot: createApp on PGlite, served (static dist + /api) over one HTTP origin. */
function serverEntrySource({ deplDir }) {
  const J = JSON.stringify;
  return `
import { synthDDL } from ${J(join(REPO, "web/src/runtime/ddl.ts"))};
import { createApp } from ${J(join(deplDir, "http/index.ts"))};
import * as schema from ${J(join(deplDir, "db/schema.ts"))};
import { drizzle } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".ico":"image/x-icon", ".woff2":"font/woff2", ".woff":"font/woff", ".ttf":"font/ttf", ".map":"application/json", ".txt":"text/plain", ".webmanifest":"application/manifest+json" };

export async function startServer({ distDir }) {
  const pglite = new PGlite();
  await pglite.exec(synthDDL(schema, { is, Table, getTableConfig }));
  const db = drizzle(pglite, { schema });
  const app = createApp(db);
  const server = createServer(async (req, res) => {
    try {
      const p = new URL(req.url, "http://localhost").pathname;
      // /api, /health, /ready → the generated Hono app, in-process.
      if (p === "/api" || p.startsWith("/api/") || p === "/health" || p === "/ready") {
        let body;
        if (req.method !== "GET" && req.method !== "HEAD") {
          const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks);
        }
        const fres = await app.fetch(new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body, duplex: "half" }));
        const buf = Buffer.from(await fres.arrayBuffer());
        const h = {}; fres.headers.forEach((v, k) => { h[k] = v; });
        res.writeHead(fres.status, h); res.end(buf); return;
      }
      // everything else → the built SPA, with index.html fallback for routes.
      let file = join(distDir, normalize(p)); let data;
      try { const s = await stat(file); if (s.isDirectory()) file = join(file, "index.html"); data = await readFile(file); }
      catch { if (extname(p)) { res.writeHead(404); res.end("not found"); return; } file = join(distDir, "index.html"); data = await readFile(file); }
      const buf = Buffer.from(data);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "content-length": String(buf.length) }); res.end(buf);
    } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    close: () => new Promise((r) => server.close(() => { try { pglite.close?.(); } catch {} r(); })),
  };
}
`;
}

/** Bundle + import the boot module; returns { startServer }. */
async function buildServerModule(deplDir, workDir) {
  const entry = join(workDir, "server-entry.mts");
  const bundle = join(workDir, "server-bundle.mjs");
  writeFileSync(entry, serverEntrySource({ deplDir }));
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
  return import(pathToFileURL(bundle).href);
}

/** Recursively flatten a Playwright JSON report to {name,status,error} outcomes. */
function outcomesFromPlaywrightJson(json) {
  const out = [];
  const visit = (suites) => {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) {
        const err = spec.tests
          ?.flatMap((t) => t.results ?? [])
          .map((r) => r.error?.message)
          .find(Boolean);
        out.push({ name: spec.title, status: spec.ok ? "pass" : "fail", error: err });
      }
      visit(s.suites);
    }
  };
  visit(json.suites);
  return out;
}

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
