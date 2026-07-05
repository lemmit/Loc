// A6.2 — headless behavioral tier for the Python (FastAPI) backend.
//
// The node tier (run.mjs) boots Hono in-process on PGlite and dispatches via
// `app.fetch`. No other backend has an in-process Postgres, so this tier boots
// the GENERATED FastAPI backend as a real process against a real Postgres
// (DATABASE_URL) and HTTP-dispatches the SAME emitted `test e2e` api suite at
// it — the emitted suite is written against the HTTP contract, so it is
// backend-agnostic (see docs/plans/a6.2-behavioral-tier-second-backend.md).
//
// This gates the *behavioral* runtime-semantics RS-rules (conformance-
// semantics.md) on a second backend per-PR: camelCase keys both directions
// (RS-1), enum declared casing (RS-2), no leaked columns (RS-3), temporal
// round-trip (RS-4), value-object survival (RS-7).
//
// Requires: `uv` on PATH and a reachable Postgres via DATABASE_URL
// (postgresql+asyncpg://…). CI provides a `services: postgres` sidecar; locally,
// point DATABASE_URL at any Postgres.
//
// Usage:  node run-python.mjs [caseName...]
// Exit code is non-zero if any case errors or any test fails.

import { build, transform } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-python");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql+asyncpg://postgres:postgres@localhost:5432/d";
const PORT = Number(process.env.LOOM_BH_PY_PORT ?? "8123");
// LOOM_BH_PY_BASE: dispatch against an ALREADY-running FastAPI backend instead
// of booting one (skips uv sync + uvicorn spawn). The obs-style external hook —
// used to run the tier against a manually-booted server.
const EXTERNAL_BASE = process.env.LOOM_BH_PY_BASE;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".venv") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: python` deployable dir: has app/main.py + pyproject.toml. */
function findPythonDeployable(genDir) {
  const mains = walk(genDir, (p) => p.endsWith("/app/main.py")).map((p) => resolve(p, "..", ".."));
  const dirs = [...new Set(mains)].filter((d) => existsSync(join(d, "pyproject.toml")));
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one python deployable, found ${dirs.length}: ${dirs.join(", ")}`);
  }
  return dirs[0];
}

/** Resolve when TCP :PORT accepts, or reject after the deadline. */
function waitForPort(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((res, rej) => {
    const tick = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        res();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) rej(new Error(`port ${port} never listened`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** The e2e-run entry (bundled by esbuild): loads the emitted api suite and
 *  dispatches each request over real HTTP at the booted FastAPI server. */
function entrySource(e2eFile) {
  const J = JSON.stringify;
  return `
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { transform as esbuildTransform } from "esbuild";
import { readFileSync } from "node:fs";

const E2E_FILE = ${J(e2eFile)};
const BASE = ${J(BASE)};

export async function run() {
  const compile = async (ts) => (await esbuildTransform(ts, { loader: "ts", format: "cjs" })).code;
  // The emitted suite calls absolute URLs (host/port irrelevant — matched on
  // pathname). Re-point every request at the booted FastAPI server.
  const dispatch = async (req) => {
    const u = new URL(req.url);
    const r = await fetch(BASE + u.pathname + u.search, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
    });
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: true, response: { status: r.status, statusText: r.statusText, headers, body: await r.text() } };
  };
  const cases = await loadApiTests({ source: readFileSync(E2E_FILE, "utf8"), compile, dispatch });
  return await runTests(cases);
}
`;
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhpy-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir], { stdio: "pipe" });
    const deplDir = findPythonDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <python>`)");

    if (!EXTERNAL_BASE) {
      // Install deps + boot uvicorn. Migrations auto-apply in the app lifespan.
      execFileSync("uv", ["sync"], { cwd: deplDir, stdio: "pipe" });
      server = spawn("uv", ["run", "uvicorn", "app.main:app", "--port", String(PORT)], {
        cwd: deplDir,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL, PORT: String(PORT) },
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`uvicorn exited early (code ${code})\n${serverLog.slice(-2000)}`))));
      await Promise.race([waitForPort(PORT), exited]);
    }

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(e2eFile));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    if (server && !server.killed) server.kill("SIGTERM");
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const corpus = JSON.parse(readFileSync(join(HERE, "corpus-python.json"), "utf8")).cases.filter(
  (c) => only.length === 0 || only.includes(c.name),
);

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  (${c.ddd})  [python → ${BASE}]\n`);
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
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [api] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
}

process.stdout.write(`\n${pass} passed, ${fail} failed${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 ? 1 : 0);
