// M-T9.3 — headless behavioral tier for the Elixir (plain Ecto/Phoenix) backend.
//
// The node tier (run.mjs) boots Hono in-process on PGlite and dispatches via
// `app.fetch`. No other backend has an in-process Postgres, so this tier boots
// the GENERATED Phoenix backend as a real process against a real Postgres
// (DATABASE_URL) and HTTP-dispatches the SAME emitted `test e2e` api suite at
// it — the emitted suite is written against the HTTP contract, so it is
// backend-agnostic (matched on pathname). Sibling of run-java.mjs; this is the
// FIFTH and final backend on the behavioral tier. See
// docs/new-plan/T9-toolchain-health.md (M-T9.3).
//
// This gates the *behavioral* runtime-semantics RS-rules (conformance-
// semantics.md) on a FIFTH backend per-PR: camelCase keys both directions
// (RS-1), enum declared casing (RS-2), no leaked columns (RS-3), temporal
// round-trip (RS-4), bool create default (RS-6), value-object survival
// (RS-7), association round-trip (RS-8).
//
// Requires: Erlang/OTP + Elixir (`mix`) on PATH and a reachable Postgres via
// DATABASE_URL (ecto:// form). CI provides a `services: postgres` sidecar;
// locally, point DATABASE_URL at any Postgres. Behind a TLS-fingerprint-
// allowlisting egress proxy, `mix deps.get` can't reach hex.pm from Elixir's
// :ssl — set HEX_MIRROR_URL (or run the repo's LOOM_HEX_MIRROR loopback
// mirror; see CLAUDE.md → "Egress proxy wrinkle (Elixir only)"). CI runners
// have direct hex.pm access, so no mirror is needed there.
//
// Usage:  node run-elixir.mjs [caseName...]
// Exit code is non-zero if any case errors or any test fails.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-elixir");

// Ecto's `DATABASE_URL` (config/dev.exs honors it). CI's `services: postgres`
// sidecar + the workflow set this; locally default to a plain localhost pg.
const DATABASE_URL = process.env.DATABASE_URL ?? "ecto://postgres:postgres@127.0.0.1:5432/app";
const PORT = Number(process.env.LOOM_BH_ELIXIR_PORT ?? "8127");
// LOOM_BH_ELIXIR_BASE: dispatch against an ALREADY-running Phoenix backend
// instead of booting one (skips mix deps.get + ecto.create/migrate +
// phx.server). The obs-style external hook — used to run the tier against a
// manually-booted server.
const EXTERNAL_BASE = process.env.LOOM_BH_ELIXIR_BASE;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "_build" || e.name === "deps") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: elixir` deployable dir: has a `mix.exs` and a
 *  `lib/<app>_web/router.ex` (the vanilla Phoenix project root). */
function findElixirDeployable(genDir) {
  const mixes = walk(genDir, (p) => p.endsWith("mix.exs"));
  const dirs = [...new Set(mixes.map((p) => dirname(p)))].filter(
    (d) => existsSync(join(d, "lib")) && walk(join(d, "lib"), (p) => p.endsWith("router.ex")).length > 0,
  );
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one elixir deployable, found ${dirs.length}: ${dirs.join(", ")}`);
  }
  return dirs[0];
}

/** Resolve when TCP :PORT accepts, or reject after the deadline. */
function waitForPort(port, timeoutMs = 180_000) {
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

/** Poll GET /ready until it 200s (DB reachable + schema migrated), or give up
 *  after the deadline. Migrations are applied by `mix ecto.migrate` before the
 *  server boots, so a listening port already implies a migrated schema — this
 *  is belt-and-braces. */
async function waitForReady(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${base}/ready`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return; // fall through — the suite will surface any real failure
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The e2e-run entry (bundled by esbuild): loads the emitted api suite and
 *  dispatches each request over real HTTP at the booted Phoenix server. */
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
  // pathname). Re-point every request at the booted Phoenix server.
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

/** The env every `mix` invocation shares: the dev config path (honors
 *  DATABASE_URL + PORT), plus any HEX_MIRROR_URL for proxied deps.get. */
function mixEnv(extra = {}) {
  return { ...process.env, DATABASE_URL, MIX_ENV: "dev", ...extra };
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhex-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir], { stdio: "pipe" });
    const deplDir = findElixirDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <elixir>`)");

    if (!EXTERNAL_BASE) {
      // Fetch hex deps, create + migrate the schema, then boot the server.
      // Migrations auto-apply here (before phx.server), so a listening port
      // already implies a migrated schema.
      execFileSync("mix", ["local.hex", "--force"], { cwd: deplDir, stdio: "pipe", env: mixEnv() });
      execFileSync("mix", ["local.rebar", "--force"], { cwd: deplDir, stdio: "pipe", env: mixEnv() });
      execFileSync("mix", ["deps.get"], { cwd: deplDir, stdio: "pipe", env: mixEnv() });
      execFileSync("mix", ["ecto.create"], { cwd: deplDir, stdio: "pipe", env: mixEnv() });
      execFileSync("mix", ["ecto.migrate"], { cwd: deplDir, stdio: "pipe", env: mixEnv() });

      server = spawn("mix", ["phx.server"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group so we can SIGTERM the whole app
        env: mixEnv({ PHX_SERVER: "true", PORT: String(PORT) }),
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`mix phx.server exited early (code ${code})\n${serverLog.slice(-2000)}`))));
      await Promise.race([waitForPort(PORT), exited]);
      await waitForReady(BASE);
    }

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(e2eFile));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    if (server?.pid && !server.killed) {
      // Kill the whole process group.
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        server.kill("SIGTERM");
      }
    }
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const corpus = JSON.parse(readFileSync(join(HERE, "corpus-elixir.json"), "utf8")).cases.filter(
  (c) => only.length === 0 || only.includes(c.name),
);

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  (${c.ddd})  [elixir → ${BASE}]\n`);
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
