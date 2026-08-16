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
//
// Env knobs:
//   LOOM_BH_ELIXIR_BASE     dispatch at an already-running server (skip boot)
//   LOOM_BH_ELIXIR_PORT     port to boot on (default 8127)
//   LOOM_ELIXIR_DEP_CACHE   warm dependency-build dir (default .work-elixir/dep-cache)
//   LOOM_ELIXIR_NO_DEP_CACHE=1  disable warm dep reuse — every case does its own
//                           full `mix deps.get` + dep compile (debugging escape hatch)

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AUTHZ_LADDERS, DEV_CLAIMS, DEV_CLAIMS_UNAUTHORIZED, featureCases, resetDatabase, sharedSystemCases } from "./cases.mjs";
import { stopServer, waitForPort, waitForPortFree } from "./proc.mjs";
import { authzLadderTail, makeWireGate, recorderPreamble } from "./wire-differential.mjs";
import { startMockIssuer } from "./oidc-mock.mjs";

/** In-process mock OIDC issuer, started when the corpus has an `auth {}` case. */
let oidc = null;

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

// ── Warm dependency-build reuse ──────────────────────────────────────────────
// Every case generates a FRESH Phoenix project whose hex dep tree is identical
// (phoenix / ecto / postgrex / open_api_spex / opentelemetry → grpcbox +
// chatterbox rebar3 builds). Compiling that tree once PER CASE — 30+ times a
// run — is what made this the slowest behavioral leg by a factor of ~4. So the
// DEPENDENCY build is primed once per distinct dep set and reused: every mix
// invocation gets `MIX_DEPS_PATH` pointing at the shared, already-fetched deps
// dir, and each dep's compiled `_build/<env>/lib/<dep>` is symlinked into the
// case's own `_build` before the app is compiled.
//
// CORRECTNESS — only DEPENDENCY builds are shared, never the generated app.
// The warm tree is produced by `mix deps.compile` (deps only), the app's build
// dir is pruned from it at prime time, and it is skipped again at link time, so
// `_build/<env>/lib/<app>` is always ABSENT when a case starts. `mix ecto.migrate`
// / `mix phx.server` / `mix test` therefore compile the emitted code from scratch
// with exactly the flags they used before — a codegen bug can never be masked by
// a stale build.
//
// KEYING — a hash of the dep-DETERMINING slice of the generated mix.exs (the
// `defp deps` block plus the `elixir:` requirement) and the Erlang/Elixir the
// artefacts were built by — NOT the whole file, which carries the per-case app
// name. Dep sets do differ across the corpus (an
// `auth {}` case adds joken/joken_jwks, a HEEx `ui:` adds phoenix_live_view), so
// a mismatch simply primes a second warm tree next to the first. Any failure in
// the reuse path falls back to a plain, self-contained full compile for that case.
const DEP_CACHE_OFF = process.env.LOOM_ELIXIR_NO_DEP_CACHE === "1";
const DEP_CACHE_ROOT = process.env.LOOM_ELIXIR_DEP_CACHE ?? join(WORK, "dep-cache");
/** Written last, so a half-primed tree (crash / cancelled job) is never trusted. */
const WARM_MARKER = ".loom-warm-complete";
/** The two MIX_ENVs a case uses: `dev` (ecto.create/migrate + phx.server) and
 *  `test` (the emitted ExUnit unit tier). Deps compile per env, so warm both. */
const MIX_ENVS = ["dev", "test"];

/** `Elixir <v> / OTP <n> / erts-<v>` — the toolchain the BEAM artefacts belong
 *  to. Folded into the fingerprint so a warm tree restored from a CI cache built
 *  by a DIFFERENT Erlang/Elixir is never loaded (it is simply a different key).
 *  Deliberately narrowed to the version numbers: `elixir --version` also prints
 *  `smp:N:N`, which varies with the host's core count. */
let beamIdCache = null;
function beamId() {
  if (beamIdCache) return beamIdCache;
  let raw = "";
  try {
    raw = execFileSync("elixir", ["--version"], { encoding: "utf8" });
  } catch {
    /* no elixir on PATH — the case's own `mix` call reports it properly */
  }
  const otp = /Erlang\/OTP\s+(\S+)/.exec(raw)?.[1] ?? "?";
  const erts = /erts-(\S+?)]/.exec(raw)?.[1] ?? "?";
  const ex = /Elixir\s+(\S+)/.exec(raw)?.[1] ?? "?";
  beamIdCache = `elixir-${ex}/otp-${otp}/erts-${erts}`;
  return beamIdCache;
}

/** Hash of the dep-determining slice of a generated mix.exs (plus the BEAM the
 *  artefacts would be built by). */
function depsFingerprint(mixExs) {
  const deps = /defp deps do\n([\s\S]*?)\n\s*end/.exec(mixExs)?.[1] ?? mixExs;
  const elixir = /elixir:\s*"[^"]*"/.exec(mixExs)?.[0] ?? "";
  const norm = `${beamId()}\n${elixir}\n${deps}`
    .replace(/#[^\n]*/g, "") // comments don't change resolution
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/** The OTP app name (`app: :my_app`) of a generated mix.exs. */
function appNameOf(mixExs) {
  return /\bapp:\s*:([a-z0-9_]+)/.exec(mixExs)?.[1] ?? null;
}

/** Fetch + compile the dep tree ONCE into `warm`, from this case's project.
 *  `mix deps.compile` builds dependencies only — the app is not compiled here
 *  (and is pruned defensively below), so the warm tree can never carry emitted
 *  code. */
function primeWarm(deplDir, warm, appName) {
  rmSync(warm, { recursive: true, force: true });
  mkdirSync(warm, { recursive: true });
  const shared = { MIX_DEPS_PATH: join(warm, "deps"), MIX_BUILD_ROOT: join(warm, "_build") };
  execFileSync("mix", ["deps.get"], { cwd: deplDir, stdio: "pipe", env: mixEnv(shared) });
  for (const env of MIX_ENVS) {
    execFileSync("mix", ["deps.compile"], { cwd: deplDir, stdio: "pipe", env: mixEnv({ ...shared, MIX_ENV: env }) });
  }
  if (appName) {
    for (const env of MIX_ENVS) rmSync(join(warm, "_build", env, "lib", appName), { recursive: true, force: true });
  }
  // The resolved lock rides along, so every later case resolves the SAME
  // versions the warm build was compiled from (and its `deps.get` is a no-op).
  if (existsSync(join(deplDir, "mix.lock"))) copyFileSync(join(deplDir, "mix.lock"), join(warm, "mix.lock"));
  writeFileSync(join(warm, WARM_MARKER), `${JSON.stringify({ createdAt: new Date().toISOString(), appName })}\n`);
}

/** Symlink every warm DEP build into this case's own `_build`, and seed the
 *  lock. The app's own build dir is never linked — it compiles fresh. */
function linkWarmDeps(deplDir, warm, appName) {
  for (const env of MIX_ENVS) {
    const from = join(warm, "_build", env, "lib");
    if (!existsSync(from)) continue;
    const to = join(deplDir, "_build", env, "lib");
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (name === appName) continue; // never seed a build of the generated app
      try {
        symlinkSync(join(from, name), join(to, name), "dir");
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
  }
  if (existsSync(join(warm, "mix.lock")) && !existsSync(join(deplDir, "mix.lock"))) {
    copyFileSync(join(warm, "mix.lock"), join(deplDir, "mix.lock"));
  }
}

/** Fingerprints this run actually used — everything else in the cache root is a
 *  tree an older dep set left behind (the CI cache restores by prefix, so they
 *  would otherwise accumulate ~45 MB at a time). Pruned after a FULL run only:
 *  a filtered run legitimately touches a subset. */
const usedFingerprints = new Set();

function pruneUnusedWarmTrees() {
  if (DEP_CACHE_OFF || !existsSync(DEP_CACHE_ROOT)) return;
  for (const name of readdirSync(DEP_CACHE_ROOT)) {
    if (usedFingerprints.has(name)) continue;
    rmSync(join(DEP_CACHE_ROOT, name), { recursive: true, force: true });
    process.stdout.write(`  ⌫ pruned stale warm dep tree ${name}\n`);
  }
}

/** `mix local.hex` / `local.rebar` install into ~/.mix — once per process, not
 *  once per case (each one is a network fetch of the archive). */
let mixToolingReady = false;
function ensureMixTooling(cwd) {
  if (mixToolingReady) return;
  execFileSync("mix", ["local.hex", "--force"], { cwd, stdio: "pipe", env: mixEnv() });
  execFileSync("mix", ["local.rebar", "--force"], { cwd, stdio: "pipe", env: mixEnv() });
  mixToolingReady = true;
}

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
function entrySource(e2eFile, bearerToken, hasAuth, authzLadder, unauthorizedCreds) {
  const J = JSON.stringify;
  const bearerEnv = bearerToken ? `, E2E_BEARER_TOKEN: ${J(bearerToken)}` : "";
  return `
${recorderPreamble()}
import { loadApiTests } from ${J(join(REPO, "web/src/testing/run-api-tests.ts"))};
import { runTests } from ${J(join(REPO, "web/src/testing/harness.ts"))};
import { transform as esbuildTransform } from "esbuild";
import { readFileSync } from "node:fs";

const E2E_FILE = ${J(e2eFile)};
const DEV_CLAIMS = ${J(DEV_CLAIMS)};
const AUTHZ_LADDER = ${J(authzLadder ?? null)};
const UNAUTHORIZED_CREDS = ${J(unauthorizedCreds ?? null)};
const BEARER_ENV = { E2E_DEV_CLAIMS: DEV_CLAIMS${bearerEnv} };
const BASE = ${J(BASE)};

export async function run() {
  const compile = async (ts) => (await esbuildTransform(ts, { loader: "ts", format: "cjs" })).code;
  // The emitted suite calls absolute URLs (host/port irrelevant — matched on
  // pathname). Re-point every request at the booted Phoenix server.
  // Recorded at the ONE dispatch chokepoint — see wire-differential.mjs.
  const dispatch = __record(async (req) => {
    const u = new URL(req.url);
    const r = await fetch(BASE + u.pathname + u.search, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
    });
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { ok: true, response: { status: r.status, statusText: r.statusText, headers, body: await r.text() } };
  });
  const cases = await loadApiTests({ source: readFileSync(E2E_FILE, "utf8"), compile, dispatch, env: BEARER_ENV });
  const results = await runTests(cases);
  // RS-9 — appended AFTER the tier so the probes never shift the ordinals the
  // golden aligns on, and so a failing tier is diagnosed on its own requests.
  await __frameworkProbes(dispatch, { auth: ${J(!!hasAuth)} });
  // M-T9.11 / M-T9.28 — the authorization ladder, RECORDED, so this backend's
  // 401/403/2xx are diffed against the node-oracle golden per-PR.
  ${authzLadderTail("results")}
  return { results, wire: __wire };
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
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, c.source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findElixirDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <elixir>`)");

    // OIDC (`auth {}` block) → point the Phoenix app at the in-process mock
    // issuer + forward its signed token.  Detect from source (verifier path is
    // backend-specific).
    const isOidc = /\n\s*auth\s*\{/.test(c.source);
    // Does this case's backend deployable enforce auth (either flavour —
    // dev stub or OIDC)?  A frontend's `auth: ui` rides its target's.
    // Drives the anonymous `/api/auth/me` probe — see __frameworkProbes.
    const hasAuth = /\n\s*auth:\s*required\b/.test(c.source);
    const oidcEnv =
      isOidc && oidc
        ? { OIDC_ISSUER: oidc.issuer, OIDC_CLIENT_ID: "loom-behavioural", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" }
        : {};
    const bearerToken = isOidc && oidc ? oidc.token : null;
    // M-T9.11 / M-T9.28 — the authorization ladder for this case (if any), plus
    // the authenticated-but-unauthorized credential in this system's auth
    // flavour: OIDC → a second mock-issuer token; dev-stub → the visitor claims.
    const authzLadder = AUTHZ_LADDERS[c.name] ?? null;
    const unauthorizedCreds = authzLadder
      ? isOidc
        ? oidc?.unauthorizedToken
          ? { authorization: `Bearer ${oidc.unauthorizedToken}` }
          : null
        : { "x-loom-dev-claims": Buffer.from(DEV_CLAIMS_UNAUTHORIZED).toString("base64") }
      : null;

    // Pure-domain unit tier (`test "…"` → ExUnit).  Collected below (after deps
    // are fetched) and prepended to the api results.
    const unitResults = [];

    if (!EXTERNAL_BASE) {
      // Fetch hex deps, create + migrate the schema, then boot the server.
      // Migrations auto-apply here (before phx.server), so a listening port
      // already implies a migrated schema.
      ensureMixTooling(deplDir);

      // Warm dep reuse (see the block above): point this case at the shared,
      // already-compiled dep tree — priming it first if this dep set is new.
      // `menv` folds MIX_DEPS_PATH into every mix invocation below; the app
      // itself still compiles from scratch, here, with the same flags.
      const mixExs = readFileSync(join(deplDir, "mix.exs"), "utf8");
      const appName = appNameOf(mixExs);
      let warmRoot = null;
      let warmDeps = null;
      let warmNote = "warm off";
      const tDeps = Date.now();
      /** Give up on the shared tree for this case — a pure-performance retreat. */
      const dropWarm = (why, keepComplete) => {
        rmSync(join(deplDir, "_build"), { recursive: true, force: true });
        rmSync(join(deplDir, "mix.lock"), { force: true });
        if (warmRoot && !(keepComplete && existsSync(join(warmRoot, WARM_MARKER)))) {
          rmSync(warmRoot, { recursive: true, force: true });
        }
        warmDeps = null;
        warmNote = `warm fallback (${String(why?.message ?? why).split("\n")[0].slice(0, 120)})`;
      };
      if (!DEP_CACHE_OFF) {
        const fp = depsFingerprint(mixExs);
        usedFingerprints.add(fp);
        warmRoot = join(DEP_CACHE_ROOT, fp);
        const hit = existsSync(join(warmRoot, WARM_MARKER));
        try {
          if (!hit) primeWarm(deplDir, warmRoot, appName);
          linkWarmDeps(deplDir, warmRoot, appName);
          warmDeps = join(warmRoot, "deps");
          warmNote = hit ? `warm hit ${fp}` : `warm primed ${fp}`;
        } catch (err) {
          // Purely a performance path: on ANY trouble with the shared tree,
          // throw the partial state away and let this case compile everything
          // itself. Never a correctness fallback — the app was never shared.
          // A HALF-primed tree is deleted (it would poison later cases); one
          // already marked complete survives — the trouble was this case's linking.
          dropWarm(err, true);
        }
      }
      /** Every mix invocation for this case, with the shared deps path folded in. */
      const menv = (extra = {}) => mixEnv({ ...(warmDeps ? { MIX_DEPS_PATH: warmDeps } : {}), ...extra });
      try {
        execFileSync("mix", ["deps.get"], { cwd: deplDir, stdio: "pipe", env: menv() });
      } catch (err) {
        // A warm tree that no longer RESOLVES (truncated cache restore, a dep
        // dir deleted underneath us) must not fail the case: discard it — marker
        // and all, so the next case re-primes — and fetch cold.
        if (!warmDeps) throw err;
        dropWarm(err, false);
        execFileSync("mix", ["deps.get"], { cwd: deplDir, stdio: "pipe", env: menv() });
      }
      const depsMs = Date.now() - tDeps;

      // Run the emitted ExUnit domain suite (pure domain — no DB tables — but
      // `mix test` boots the app in :test env, so the `api_test` DB must exist
      // for the Repo pool to connect).  ExUnit has no JUnit dep, so gate on the
      // "N tests, M failures" summary line.
      const testDir = join(deplDir, "test");
      const hasUnit = existsSync(testDir) && walk(testDir, (p) => p.endsWith("_test.exs")).length > 0;
      const tUnit = Date.now();
      if (hasUnit) {
        const testEnv = menv({ MIX_ENV: "test" });
        try {
          execFileSync("mix", ["ecto.create"], { cwd: deplDir, stdio: "pipe", env: testEnv });
        } catch {
          /* db may already exist */
        }
        let out = "";
        try {
          out = execFileSync("mix", ["test"], { cwd: deplDir, encoding: "utf8", env: testEnv });
        } catch (e) {
          out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
        }
        const m = /(\d+) tests?, (\d+) failures?/.exec(out);
        if (m) {
          const total = Number(m[1]);
          const failures = Number(m[2]);
          unitResults.push({ tier: "unit", name: `mix test (${total} tests)`, status: failures === 0 ? "pass" : "fail", error: failures === 0 ? undefined : `${failures} failure(s)` });
        } else {
          unitResults.push({ tier: "unit", name: "mix test", status: "fail", error: "no ExUnit summary (compile error?)" });
        }
      }

      const unitMs = Date.now() - tUnit;

      const tBoot = Date.now();
      execFileSync("mix", ["ecto.create"], { cwd: deplDir, stdio: "pipe", env: menv() });
      // Clean DB per case (context-named schemas + schema_migrations), else the
      // 2nd case collides.  ecto.create ensured the DB exists first.
      await resetDatabase(DATABASE_URL.replace("ecto://", "postgresql://"));
      execFileSync("mix", ["ecto.migrate"], { cwd: deplDir, stdio: "pipe", env: menv() });

      // Nothing may still be listening on PORT: `waitForPort` below cannot tell
      // this case's server from a previous case's leftover, and answering with
      // the wrong app against a freshly-dropped schema is exactly the 500 this
      // guards (see waitForPortFree).
      await waitForPortFree(PORT);
      server = spawn("mix", ["phx.server"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group so we can SIGTERM the whole app
        env: menv({ PHX_SERVER: "true", PORT: String(PORT), ...oidcEnv }),
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`mix phx.server exited early (code ${code})\n${serverLog.slice(-2000)}`))));
      await Promise.race([waitForPort(PORT), exited]);
      await waitForReady(BASE);
      const bootMs = Date.now() - tBoot;
      const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
      process.stdout.write(`  ⏱ deps ${s(depsMs)} [${warmNote}] · unit ${s(unitMs)} · migrate+boot ${s(bootMs)}\n`);
    }

    const entry = join(workDir, "entry.mts");
    const bundle = join(workDir, "bundle.mjs");
    writeFileSync(entry, entrySource(e2eFile, bearerToken, hasAuth, authzLadder, unauthorizedCreds));
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node20", packages: "external", logLevel: "warning" });
    const { run } = await import(pathToFileURL(bundle).href);
    const api = await run();
    return { results: [...unitResults, ...api.results], wire: api.wire };
  } finally {
    // AWAIT the exit — firing SIGTERM and moving on leaves the port occupied
    // into the next case, which then talks to the wrong app (see stopServer).
    await stopServer(server);
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
// Manifest-derived corpus features (vanilla elixir) + shared tokenized systems.
const corpus = [...(await featureCases("vanilla", "elixir", WORK)), ...sharedSystemCases("elixir")].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

// Stand up the mock OIDC issuer once if any case carries an `auth {}` block.
if (corpus.some((c) => /\n\s*auth\s*\{/.test(c.source))) {
  oidc = await startMockIssuer();
}

let pass = 0;
let fail = 0;
let errored = 0;
let skipped = 0;
// Cross-backend runtime wire differential (M-T9.11): every request this tier
// makes is recorded at the dispatch chokepoint and compared to the committed
// canonical golden (test/behavioral/wire-golden/), so a runtime-VALUE drift
// this backend alone introduces fails HERE, per-PR — not in a nightly report.
const wire = makeWireGate("elixir", WORK);
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  [elixir → ${BASE}]\n`);
  let out;
  try {
    out = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR booting/running: ${err?.message ?? err}\n`);
    continue;
  }
  for (const r of out.results) {
    if (r.status === "skip") {
      skipped++;
      process.stdout.write(`  ○ [${r.tier ?? "api"}] ${r.name}\n`);
      continue;
    }
    const ok = r.status === "pass";
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [${r.tier ?? "api"}] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${String(r.error).split("\n")[0]}\n`);
  }
  await wire.check(c.name, out.wire, out.results);
}

await oidc?.stop();

// Keep the shared dep-build cache bounded: a full run knows every dep set that
// is still live, so anything else in the cache root is dead weight the CI cache
// would otherwise carry forward.
if (only.length === 0) pruneUnusedWarmTrees();

const wireBad = await wire.finish();

process.stdout.write(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}${errored ? `, ${errored} cases errored` : ""}\n`);
process.exit(fail > 0 || errored > 0 || wireBad > 0 ? 1 : 0);
