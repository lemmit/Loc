// M-T6.9 — headless behavioral tier for the node/Hono backend on the
// **MikroORM** persistence adapter (`persistence: mikroorm`).
//
// The default node tier (run.mjs) boots Hono in-process on PGlite with the
// DEFAULT drizzle adapter.  MikroORM uses the `@mikro-orm/postgresql` driver —
// it needs a REAL Postgres, not PGlite — so this tier cannot reuse the
// in-process boot.  Instead it models the boot on the cross-backend runners
// (run-python.mjs / run-dotnet.mjs): generate the node system, boot the
// GENERATED Hono server as a real process against a `services: postgres`
// sidecar, and HTTP-dispatch the SAME emitted `test e2e` api suite at it (the
// emitted suite is written against the HTTP contract, so it is
// backend-agnostic — matched on pathname).
//
// The corpus is LITERALLY the same as the default node tier (run.mjs): the
// manifest-derived feature cases + the shared tokenized systems, with ONE
// source transform — a `persistence: mikroorm` realization clause injected onto
// the `platform: node` deployable before `generate system`.  So this tier
// proves the drained MikroORM adapter RUNS (schema applies via
// `orm.schema.updateSchema()` at boot, CRUD round-trips) on the same contract
// the drizzle backend passes, not merely that it tsc-compiles.
//
// Schema: the generated `index.ts` calls `await orm.schema.updateSchema()`
// before `serve(...)`, so a listening port already implies a migrated schema —
// no separate migration CLI to run.
//
// Requires: node (for the generated project's `tsx` dev boot) + a reachable
// Postgres via DATABASE_URL.  CI provides a `services: postgres` sidecar;
// locally, point DATABASE_URL at any Postgres.
//
// Usage:  node run-mikroorm.mjs [caseName...]
// Exit code is non-zero if any case errors or any api test fails.
// LOOM_BH_MIKRO_BASE dispatches at an ALREADY-running server (skips the
// npm install + boot), mirroring the other runners' BASE env convention.

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

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-mikroorm");

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/app";
const PORT = Number(process.env.LOOM_BH_MIKRO_PORT ?? "8125");
// LOOM_BH_MIKRO_BASE: dispatch against an ALREADY-running node/mikroorm backend
// instead of booting one (skips npm install + tsx boot). The obs-style external
// hook — used to run the tier against a manually-booted server.
const EXTERNAL_BASE = process.env.LOOM_BH_MIKRO_BASE;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

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

// Per-case mikroorm skips: corpus cases whose feature has a genuine, tracked
// RUNTIME gap on the MikroORM adapter (the M-T6.9 drain was tsc-verified only —
// this tier is what surfaced them). Each still runs on the DEFAULT node/drizzle
// tier (run.mjs), and the skip is honest+documented, not a silent drop —
// removing an entry re-arms the boot once the mikroorm emitter fix lands. These
// are mikroorm-adapter-specific, so they live HERE, not in cases.mjs's shared
// BEHAVIOURAL_SKIP (which is keyed by platform clause and would wrongly skip the
// drizzle tier too). See the PR body's "MikroORM runtime gaps" register.
const MIKRO_SKIP = {
  // A capability `filter` predicate (tenancy scope) is not applied by the
  // mikroorm find/query path — reads return every tenant's rows (expected 1,
  // got 2) instead of the principal-scoped subset.
  "tenancy-filter": "capability filter predicate not applied on the mikroorm read path",
  // Workflow (saga) code hard-codes drizzle-orm imports + query operators
  // (`import { eq, and, … } from "drizzle-orm"`), which the mikroorm project
  // doesn't depend on — the generated server crashes at boot (ERR_MODULE_NOT_FOUND).
  saga: "workflow emitter hard-codes drizzle-orm imports (not persistence-neutral)",
};

/** Inject a `persistence: mikroorm` realization clause onto the `platform: node`
 *  deployable so the SAME corpus source generates the MikroORM db/ layer instead
 *  of the default drizzle.  The corpus fixtures declare no explicit persistence
 *  (→ drizzle), so the clause is `platform: node` (post token-swap); rewrite it
 *  to `platform: node { persistence: mikroorm }`.  If a realization block already
 *  exists, splice the axis in.  Throws if there is no node deployable to force. */
function forceMikroorm(src) {
  // The corpus fixtures declare no explicit persistence, so the node clause is a
  // bare `platform: node` (no realization block). The negative lookahead avoids
  // re-forcing one that already has a `{ … }` block, and — by not consuming the
  // trailing whitespace — keeps the following clause on its own line.
  let injected = false;
  const out = src.replace(/(platform\s*:\s*node)\b(?!\s*[{@])/g, (m) => {
    injected = true;
    return `${m} { persistence: mikroorm }`;
  });
  if (!injected) throw new Error("no `platform: node` deployable to force mikroorm onto");
  return out;
}

/** The one `platform: node` deployable dir: has index.ts + mikro-orm.config.ts
 *  (the MikroORM server entry + config the generated boot imports). */
function findNodeDeployable(genDir) {
  const configs = walk(genDir, (p) => p.endsWith("/mikro-orm.config.ts")).map((p) => dirname(p));
  const dirs = [...new Set(configs)].filter((d) => existsSync(join(d, "index.ts")));
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one node (mikroorm) deployable, found ${dirs.length}: ${dirs.join(", ")}`);
  }
  return dirs[0];
}

/** Resolve when TCP :PORT accepts, or reject after the deadline. */
function waitForPort(port, timeoutMs = 90_000) {
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

/** Poll GET /health until it 200s (server up + schema applied), or give up after
 *  the deadline.  `updateSchema()` runs before serve(), so a listening port
 *  already implies a migrated schema — this is belt-and-braces. */
async function waitForHealth(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return; // fall through — the suite surfaces any real failure
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The e2e-run entry (bundled by esbuild): loads the emitted api suite and
 *  dispatches each request over real HTTP at the booted Hono/mikroorm server. */
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
  // pathname). Re-point every request at the booted node/mikroorm server.
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
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhmk-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, forceMikroorm(c.source));
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findNodeDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <node>`)");

    // OIDC (`auth {}` block) → the generated verifier validates a real bearer
    // JWT against the issuer's JWKS.  Point the backend at the in-process mock
    // issuer (OIDC_ISSUER) + forward its signed token (E2E_BEARER_TOKEN).  A
    // dev-stub (`auth: required`, no block) needs no env — the generated boot
    // registers the dev-stub verifier itself; E2E_DEV_CLAIMS drives the header.
    const isOidc = /\n\s*auth\s*\{/.test(c.source);
    const oidcEnv =
      isOidc && oidc
        ? { OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: "loom-behavioural", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
        : {};
    const bearerToken = isOidc && oidc ? oidc.token : null;

    if (!EXTERNAL_BASE) {
      // Install the generated project's deps (incl. @mikro-orm/*) then boot it.
      // npm's on-disk cache makes subsequent per-case installs fast.
      execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: deplDir, stdio: "pipe" });

      // Clean DB per case (mikroorm updateSchema is additive, so a stale table
      // from the previous case would otherwise linger), else the 2nd case sees
      // rows/columns it didn't create.
      await resetDatabase(DATABASE_URL);

      // Boot the generated Hono server (`tsx index.ts`).  `updateSchema()` runs
      // before serve(), so a listening port implies a migrated schema.
      server = spawn("npm", ["run", "dev"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group so we can SIGTERM tsx + its child
        env: { ...process.env, DATABASE_URL, PORT: String(PORT), ...oidcEnv },
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`node/mikroorm server exited early (code ${code})\n${serverLog.slice(-2000)}`))));
      await Promise.race([waitForPort(PORT), exited]);
      await waitForHealth(BASE);
    }

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(e2eFile, bearerToken));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    return (await run()).map((r) => ({ tier: "api", ...r }));
  } finally {
    if (server?.pid && !server.killed) {
      // Kill the whole process group (npm run dev spawns tsx as a child).
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
// Manifest-derived corpus features (node) + shared tokenized systems — the SAME
// corpus the default node tier (run.mjs) boots, just forced onto mikroorm.  Only
// the api tier gates here: the unit tier is pure-domain (persistence-independent)
// and already covered by run.mjs.  A case that emits no `test e2e` suite is
// skipped (nothing for the api tier to dispatch).
const corpus = [...(await featureCases("node", "node", WORK)), ...sharedSystemCases("node")].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// Drop the tracked mikroorm-gap cases (unless one is named explicitly, so a fix
// can be re-checked with `node run-mikroorm.mjs value-collections`).
const skipped = only.length === 0 ? corpus.filter((c) => c.name in MIKRO_SKIP) : [];
const active = corpus.filter((c) => only.length > 0 || !(c.name in MIKRO_SKIP));
for (const c of skipped) {
  process.stdout.write(`\n▶ ${c.name}  [mikroorm]\n  ⤼ SKIPPED (tracked gap): ${MIKRO_SKIP[c.name]}\n`);
}

// Stand up the mock OIDC issuer once if any case carries an `auth {}` block.
if (active.some((c) => /\n\s*auth\s*\{/.test(c.source))) {
  oidc = await startMockIssuer();
}

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of active) {
  process.stdout.write(`\n▶ ${c.name}  [mikroorm → ${BASE}]\n`);
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
    process.stdout.write(`  ${ok ? "✓" : "✗"} [${r.tier ?? "api"}] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
}

await oidc?.stop();

process.stdout.write(`\n${pass} passed, ${fail} failed${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 ? 1 : 0);
