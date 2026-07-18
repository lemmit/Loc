// RST-2 — headless behavioral tier for the .NET (ASP.NET + EF Core) backend.
//
// The node tier (run.mjs) boots Hono in-process on PGlite and dispatches via
// `app.fetch`. No other backend has an in-process Postgres, so this tier boots
// the GENERATED .NET backend as a real process against a real Postgres
// (ConnectionStrings__Default) and HTTP-dispatches the SAME emitted `test e2e`
// api suite at it — the emitted suite is written against the HTTP contract, so
// it is backend-agnostic (matched on pathname). Sibling of run-python.mjs; see
// docs/old/plans/runtime-semantics-tier-followups.md (RST-2).
//
// This gates the *behavioral* runtime-semantics RS-rules (conformance-
// semantics.md) on a THIRD backend per-PR: camelCase keys both directions
// (RS-1), enum declared casing (RS-2), no leaked columns (RS-3), temporal
// round-trip (RS-4), bool create default (RS-6), value-object survival (RS-7),
// association round-trip (RS-8).
//
// Requires: the .NET SDK (`dotnet`) on PATH and a reachable Postgres via
// ConnectionStrings__Default. CI provides a `services: postgres` sidecar;
// locally, point ConnectionStrings__Default at any Postgres.
//
// Usage:  node run-dotnet.mjs [caseName...]
// Exit code is non-zero if any case errors or any test fails.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEV_CLAIMS, featureCases, resetDatabase, sharedSystemCases } from "./cases.mjs";
import { startMockIssuer } from "./oidc-mock.mjs";

/** In-process mock OIDC issuer, started when the corpus has an `auth {}` case. */
let oidc = null;

/** .NET `Host=…;Port=…;Database=…;Username=…;Password=…` → a `pg` URL. */
function dotnetPgUrl(cs) {
  const kv = Object.fromEntries(cs.split(";").filter(Boolean).map((p) => p.split("=")));
  return `postgresql://${kv.Username}:${kv.Password}@${kv.Host}:${kv.Port ?? 5432}/${kv.Database}`;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-dotnet");

// The .NET connection string (its native env var). CI's `services: postgres`
// sidecar + the workflow set this; locally default to a plain localhost pg.
const CONNECTION_STRING =
  process.env.ConnectionStrings__Default ??
  "Host=127.0.0.1;Port=5432;Database=app;Username=postgres;Password=postgres";
const PORT = Number(process.env.LOOM_BH_DOTNET_PORT ?? "8124");
// LOOM_BH_DOTNET_BASE: dispatch against an ALREADY-running .NET backend instead
// of booting one (skips dotnet restore + dotnet run). The obs-style external
// hook — used to run the tier against a manually-booted server.
const EXTERNAL_BASE = process.env.LOOM_BH_DOTNET_BASE;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "bin" || e.name === "obj") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: dotnet` deployable dir: has Program.cs + a *.csproj. */
function findDotnetDeployable(genDir) {
  const csprojs = walk(genDir, (p) => p.endsWith(".csproj"));
  const dirs = [...new Set(csprojs.map((p) => dirname(p)))].filter((d) =>
    existsSync(join(d, "Program.cs")),
  );
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one dotnet deployable, found ${dirs.length}: ${dirs.join(", ")}`);
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
 *  after the deadline. Migrations apply before app.Run() in Program.cs, so a
 *  listening port already implies a migrated schema — this is belt-and-braces. */
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
 *  dispatches each request over real HTTP at the booted .NET server. */
function entrySource(e2eFile, bearerToken) {
  const J = JSON.stringify;
  const bearerEnv = bearerToken ? `, E2E_BEARER_TOKEN: ${J(bearerToken)}` : "";
  return `
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { transform as esbuildTransform } from "esbuild";
import { readFileSync } from "node:fs";

const E2E_FILE = ${J(e2eFile)};
const DEV_CLAIMS = ${J(DEV_CLAIMS)};
const BEARER_ENV = { E2E_DEV_CLAIMS: DEV_CLAIMS${bearerEnv} };
const BASE = ${J(BASE)};

export async function run() {
  const compile = async (ts) => (await esbuildTransform(ts, { loader: "ts", format: "cjs" })).code;
  // The emitted suite calls absolute URLs (host/port irrelevant — matched on
  // pathname). Re-point every request at the booted .NET server.
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
  const cases = await loadApiTests({ source: readFileSync(E2E_FILE, "utf8"), compile, dispatch, env: BEARER_ENV });
  return await runTests(cases);
}
`;
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhdn-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, c.source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findDotnetDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <dotnet>`)");

    // OIDC (`auth {}` block) → point the backend at the in-process mock issuer
    // + forward its signed token.  NO_PROXY keeps the loopback JWKS fetch off
    // any ambient proxy.  Detect from source (the emitted verifier path is
    // backend-specific).
    const isOidc = /\n\s*auth\s*\{/.test(c.source);
    const oidcEnv =
      isOidc && oidc
        ? { OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: "loom-behavioural", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
        : {};
    const bearerToken = isOidc && oidc ? oidc.token : null;

    if (!EXTERNAL_BASE) {
      // Clean DB per case (context-named schemas), else the 2nd case collides.
      await resetDatabase(dotnetPgUrl(CONNECTION_STRING));
      // Restore then boot the app. Migrations auto-apply at startup (before
      // app.Run()), so a listening port already implies a migrated schema.
      execFileSync("dotnet", ["restore"], { cwd: deplDir, stdio: "pipe" });
      server = spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group so we can SIGTERM the whole app, not just the wrapper
        env: {
          ...process.env,
          PORT: String(PORT),
          ASPNETCORE_URLS: `http://127.0.0.1:${PORT}`,
          ConnectionStrings__Default: CONNECTION_STRING,
          ...oidcEnv,
        },
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`dotnet run exited early (code ${code})\n${serverLog.slice(-2000)}`))));
      await Promise.race([waitForPort(PORT), exited]);
      await waitForReady(BASE);
    }

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(e2eFile, bearerToken));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return await run();
  } finally {
    if (server?.pid && !server.killed) {
      // Kill the whole process group (dotnet run spawns the app as a child).
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
// Manifest-derived corpus features (dotnet) + shared tokenized systems.
const corpus = [...(await featureCases("dotnet", "dotnet", WORK)), ...sharedSystemCases("dotnet")].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// Stand up the mock OIDC issuer once if any case carries an `auth {}` block.
if (corpus.some((c) => /\n\s*auth\s*\{/.test(c.source))) {
  oidc = await startMockIssuer();
}

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  [dotnet → ${BASE}]\n`);
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

await oidc?.stop();

process.stdout.write(`\n${pass} passed, ${fail} failed${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 ? 1 : 0);
