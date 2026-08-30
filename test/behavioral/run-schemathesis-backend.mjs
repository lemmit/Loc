// Spec-driven API contract fuzzing (M-T9.21) — the python / java / dotnet /
// elixir legs.
//
// The node leg (run-schemathesis.mjs) boots Hono in-process on PGlite.  No
// other backend has an in-process Postgres, so these legs do what the
// behavioral runners do (run-python.mjs / run-dotnet.mjs / run-java.mjs /
// run-elixir.mjs): generate the SAME fixture with its backend deployable
// re-platformed, boot it as a real process against a real Postgres, and point
// the fuzzer at it.  Everything after "the server is listening" — the spec
// fetch, the checks, the finding keys, the ratcheting waiver register — is the
// shared core (schemathesis-core.mjs), so a root-cause fix clears its rule on
// every leg at once instead of on whichever copy was edited.
//
// WHY IT MATTERS THAT THIS IS NOT ONE BACKEND.  The mission's premise is that
// the adversarial request space is only covered where a human wrote the case;
// the four backends that were NOT fuzzed had exactly that coverage, and each
// owns its own router, its own body binding and its own error mapping.  The
// wire differential (M-T9.11) checks them against each other on
// EXAMPLE-shaped input — it cannot see a class of input none of them is ever
// sent.
//
// Usage:
//   cd test/behavioral && npm ci        # once
//   LOOM_SCHEMATHESIS=1 node run-schemathesis-backend.mjs <backend> [caseName...]
// or, from the repo root:  npm run test:schemathesis-python   (…-java, …-dotnet, …-elixir)
//
// Env — the shared ones are documented in schemathesis-core.mjs.  Per leg:
//   LOOM_SCHEMATHESIS_BASE       fuzz an ALREADY-running backend at this origin
//                                instead of booting one (the obs-style external
//                                hook: the toolchain for a backend may not be
//                                installable on the host, but a container
//                                publishing a port always is)
//   LOOM_SCHEMATHESIS_PORT       port to boot on (default: per-leg, 8140+)
//   DATABASE_URL                 python (postgresql+asyncpg://…) / elixir (ecto://…)
//   ConnectionStrings__Default   dotnet
//   SPRING_DATASOURCE_{URL,USERNAME,PASSWORD}   java
//
// ONE LEG AT A TIME per database.  Each case drops every schema before it boots
// (`resetDatabase`), so two legs pointed at the same Postgres pull the tables
// out from under each other mid-fuzz and report the wreckage as hundreds of
// findings.  CI gives each matrix job its own `services: postgres`; locally,
// run them sequentially or point each at its own database.
//
// Exit code is non-zero on any unwaived finding, any stale waiver, or a boot
// error.  Findings register: docs/audits/schemathesis-findings-2026-08.md.

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
import { fileURLToPath } from "node:url";
import { resetDatabase } from "./cases.mjs";
import { stopServer, waitForPort, waitForPortFree } from "./proc.mjs";
import { fuzzLeg, makeLogScraper, REPO, walk } from "./schemathesis-core.mjs";

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** Feature-rich fixtures: broad multi-aggregate systems with exactly ONE
 *  backend deployable (so the boot is unambiguous), covering creates, named
 *  operations, destroys, paged finds, find-by, value objects, money, enums,
 *  date-times and a workflow.  The same two the node leg fuzzes, with
 *  `platform: node` swapped for this leg's clause — the fixture is the
 *  CONSTANT, so a finding that appears on one backend and not another is a
 *  statement about the backends. */
const SHARED_CASES = [
  { name: "storefront-system", ddd: "web/src/examples/storefront-system.ddd", swap: true },
  { name: "sales-system", ddd: "web/src/examples/sales-system.ddd", swap: true },
];

/** Elixir is the exception, and the exception is itself a finding (F14).  The
 *  vanilla-Phoenix backend emits its OpenAPI document from the deployable's
 *  `serves:` api — a deployable that declares only `contexts:` publishes no
 *  /openapi.json at all, while the other four publish one derived from the
 *  routes either way.  The two shared fixtures declare no `api` block, so on
 *  elixir there would be no contract to fuzz against; this leg therefore runs
 *  the broad elixir storefront fixture, which does declare one.  When F14 is
 *  fixed this list collapses back into SHARED_CASES. */
const ELIXIR_CASES = [
  { name: "storefront-elixir", ddd: "web/src/examples/storefront-elixir.ddd", swap: false },
];

/** Cases one leg cannot fuzz at all, with the finding that says why.  A skip is
 *  NOT a waiver — a waiver attributes a finding the fuzzer produced, a skip says
 *  the fuzzer never ran — so it is spelled out here, printed in the run output,
 *  and carries the register entry that has to be struck before it is deleted. */
const SKIP = {
  // Empty since 2026-08-30: the one entry that lived here, dotnet ×
  // `storefront-system`, was drained with F14's fix (the emitter now qualifies
  // the colliding OpenAPI schema ids, so the document generates and the leg
  // fuzzes it like any other case).  The mechanism stays — the next
  // unfuzzable case is a one-line entry plus its register heading.
};

// ---------------------------------------------------------------------------
// Per-backend boot recipes
// ---------------------------------------------------------------------------

/** Everything that differs per backend, in one table: how to find the emitted
 *  deployable, what to build before booting, and how to spawn it. */
const BACKENDS = {
  python: {
    clause: "python",
    port: 8140,
    cases: SHARED_CASES,
    /** app/main.py + pyproject.toml. */
    find: (genDir) =>
      soleDir(
        genDir,
        walk(genDir, (p) => p.endsWith("/app/main.py")).map((p) => resolve(p, "..", "..")),
        (d) => existsSync(join(d, "pyproject.toml")),
        "python",
      ),
    prepare: (deplDir) => execFileSync("uv", ["sync"], { cwd: deplDir, stdio: "pipe" }),
    pgUrl: () => dbUrl("python").replace("+asyncpg", ""),
    spawn: (deplDir, port) =>
      spawn("uv", ["run", "uvicorn", "app.main:app", "--port", String(port)], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group: `uv run` holds the port in a CHILD uvicorn
        env: { ...process.env, DATABASE_URL: dbUrl("python"), PORT: String(port) },
      }),
  },

  dotnet: {
    clause: "dotnet",
    port: 8141,
    cases: SHARED_CASES,
    /** A csproj that is not the emitted test project. */
    find: (genDir) =>
      soleDir(
        genDir,
        walk(genDir, (p) => p.endsWith(".csproj") && !p.endsWith("Tests.csproj")).map((p) =>
          dirname(p),
        ),
        (d) => existsSync(join(d, "Program.cs")),
        "dotnet",
      ),
    prepare: (deplDir) => execFileSync("dotnet", ["restore"], { cwd: deplDir, stdio: "pipe" }),
    pgUrl: () => {
      const kv = Object.fromEntries(
        dbUrl("dotnet")
          .split(";")
          .filter(Boolean)
          .map((p) => p.split("=")),
      );
      return `postgresql://${kv.Username}:${kv.Password}@${kv.Host}:${kv.Port ?? 5432}/${kv.Database}`;
    },
    spawn: (deplDir, port) =>
      spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true,
        env: {
          ...process.env,
          PORT: String(port),
          ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
          ConnectionStrings__Default: dbUrl("dotnet"),
        },
      }),
  },

  java: {
    clause: "java",
    port: 8142,
    cases: SHARED_CASES,
    /** build.gradle(.kts) + a Spring application class. */
    find: (genDir) =>
      soleDir(
        genDir,
        walk(genDir, (p) => p.endsWith("build.gradle") || p.endsWith("build.gradle.kts")).map((p) =>
          dirname(p),
        ),
        (d) => existsSync(join(d, "src", "main")),
        "java",
      ),
    prepare: (deplDir) =>
      execFileSync("gradle", ["--no-daemon", "-q", "bootJar"], { cwd: deplDir, stdio: "pipe" }),
    pgUrl: () =>
      dbUrl("java").replace(
        /^jdbc:postgresql:\/\//,
        `postgresql://${process.env.SPRING_DATASOURCE_USERNAME ?? "postgres"}:${process.env.SPRING_DATASOURCE_PASSWORD ?? "postgres"}@`,
      ),
    spawn: (deplDir, port) => {
      const jar = readdirSync(join(deplDir, "build", "libs")).find(
        (f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"),
      );
      if (!jar) throw new Error("no jar produced by gradle bootJar");
      // Boot with the JDK gradle's toolchain compiled against (Java 25): the
      // generated classes are class-file v69, so a stale PATH `java` throws
      // UnsupportedClassVersionError.
      const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
      return spawn(javaBin, ["-jar", join("build", "libs", jar)], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true,
        env: {
          ...process.env,
          SERVER_PORT: String(port),
          SPRING_DATASOURCE_URL: dbUrl("java"),
          SPRING_DATASOURCE_USERNAME: process.env.SPRING_DATASOURCE_USERNAME ?? "postgres",
          SPRING_DATASOURCE_PASSWORD: process.env.SPRING_DATASOURCE_PASSWORD ?? "postgres",
        },
      });
    },
  },

  elixir: {
    clause: "elixir",
    port: 8143,
    cases: ELIXIR_CASES,
    /** mix.exs + lib/. */
    find: (genDir) =>
      soleDir(
        genDir,
        walk(genDir, (p) => p.endsWith("mix.exs")).map((p) => dirname(p)),
        (d) => existsSync(join(d, "lib")),
        "elixir",
      ),
    prepare: (deplDir) => {
      const env = { ...process.env, DATABASE_URL: dbUrl("elixir"), MIX_ENV: "dev" };
      execFileSync("mix", ["deps.get"], { cwd: deplDir, stdio: "pipe", env });
      execFileSync("mix", ["ecto.create"], { cwd: deplDir, stdio: "pipe", env });
    },
    pgUrl: () => dbUrl("elixir").replace("ecto://", "postgresql://"),
    /** Migrations must run AFTER the per-case schema reset, so they are a
     *  post-reset step rather than part of `prepare`. */
    migrate: (deplDir) =>
      execFileSync("mix", ["ecto.migrate"], {
        cwd: deplDir,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: dbUrl("elixir"), MIX_ENV: "dev" },
      }),
    spawn: (deplDir, port) =>
      spawn("mix", ["phx.server"], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl("elixir"),
          MIX_ENV: "dev",
          PHX_SERVER: "true",
          PORT: String(port),
        },
      }),
  },
};

/** The backend's database URL in ITS OWN native env var + dialect — the same
 *  ones the behavioral legs and the generated compose file use, so a postgres
 *  sidecar configured for one works for the other. */
function dbUrl(backend) {
  switch (backend) {
    case "python":
      return process.env.DATABASE_URL ?? "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/app";
    case "elixir":
      return process.env.DATABASE_URL ?? "ecto://postgres:postgres@127.0.0.1:5432/app";
    case "dotnet":
      return (
        process.env.ConnectionStrings__Default ??
        "Host=127.0.0.1;Port=5432;Database=app;Username=postgres;Password=postgres"
      );
    case "java":
      return process.env.SPRING_DATASOURCE_URL ?? "jdbc:postgresql://127.0.0.1:5432/app";
    default:
      throw new Error(`no database url for ${backend}`);
  }
}

/** Exactly one candidate dir must survive the filter — a fixture that emits two
 *  deployables of the same platform would make the boot ambiguous, and silently
 *  fuzzing whichever came first is the kind of "it ran, so it must be covered"
 *  the mission exists to stop. */
function soleDir(genDir, candidates, pred, label) {
  const dirs = [...new Set(candidates)].filter(pred);
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one ${label} deployable under ${genDir}, found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const backendKey = process.argv[2];
const cfg = BACKENDS[backendKey];
if (!cfg) {
  process.stderr.write(
    `usage: node run-schemathesis-backend.mjs <${Object.keys(BACKENDS).join("|")}> [case...]\n`,
  );
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = join(HERE, `.work-schemathesis-${backendKey}`);
const PORT = Number(process.env.LOOM_SCHEMATHESIS_PORT ?? cfg.port);
// LOOM_SCHEMATHESIS_BASE: fuzz an ALREADY-running backend instead of booting
// one.  The toolchain for a backend is not always installable on the host (a
// container that publishes a port always is), and this is also how a finding is
// re-driven by hand against a server left running under a debugger.
const EXTERNAL_BASE = process.env.LOOM_SCHEMATHESIS_BASE;

/** Generate one case at this leg's platform and boot it. */
async function boot(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-st-${backendKey}-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  const scraper = makeLogScraper();
  let server = null;
  /** Set once the server is spawned — flushed to workDir/server.log on stop. */
  let serverLog = () => "";
  const cleanup = async () => {
    await stopServer(server);
    const text = serverLog();
    if (text) writeFileSync(join(workDir, "server.log"), text);
    rmSync(genDir, { recursive: true, force: true });
  };
  try {
    // Re-platform the fixture, then generate from the REWRITTEN source (written
    // into workDir, so a failing run leaves the exact input on disk).
    const raw = readFileSync(join(REPO, c.ddd), "utf8");
    const source = c.swap ? raw.replaceAll("platform: node", `platform: ${cfg.clause}`) : raw;
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], {
      stdio: "pipe",
    });
    const deplDir = cfg.find(genDir);

    if (EXTERNAL_BASE) {
      return { base: EXTERNAL_BASE, workDir, stop: cleanup, drainErrors: () => scraper.drain() };
    }

    cfg.prepare?.(deplDir);
    // Clean DB per case (context-named schemas), else the 2nd case collides.
    await resetDatabase(cfg.pgUrl());
    cfg.migrate?.(deplDir);
    // Nothing may still be listening on PORT: `waitForPort` below cannot tell
    // this case's server from a previous case's leftover, and answering with
    // the wrong app against a freshly-dropped schema is exactly the 500 that
    // would then be reported as a finding (see proc.mjs).
    await waitForPortFree(PORT);

    server = cfg.spawn(deplDir, PORT);
    // The FULL server output is kept beside the report (and uploaded as a CI
    // artefact).  The scraper's deduped heads name WHICH exceptions fired; only
    // the raw log carries the stack under them, and a 500 finding is close to
    // undiagnosable without it.  Capped so a pathological run cannot fill the
    // disk — the head of the log is where the boot + first failures are.
    let log = "";
    const onOutput = (d) => {
      if (log.length < 8_000_000) log += d;
      scraper.push(d);
    };
    server.stdout.on("data", onOutput);
    server.stderr.on("data", onOutput);
    serverLog = () => log;
    const exited = new Promise((_, rej) =>
      server.on("exit", (code) =>
        rej(new Error(`${backendKey} backend exited early (code ${code})\n${log.slice(-2000)}`)),
      ),
    );
    await Promise.race([waitForPort(PORT), exited]);
    const base = `http://127.0.0.1:${PORT}`;
    await waitForReady(base);
    // The boot noise (migration output, framework banners) is not a finding —
    // only what the app logs while it is being FUZZED is.
    scraper.drain();
    return { base, workDir, stop: cleanup, drainErrors: () => scraper.drain() };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** `/ready` reports that the pool is healthy — poll it so the first fuzzed
 *  request is not the one that races the schema. */
async function waitForReady(base, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/ready`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return; // fall through — the fuzz run surfaces any real failure
    await new Promise((r) => setTimeout(r, 300));
  }
}

const skipped = SKIP[backendKey] ?? {};
const cases = cfg.cases.filter((c) => {
  if (!(c.name in skipped)) return true;
  process.stdout.write(`\n○ ${c.name}  [${backendKey}] SKIPPED — ${skipped[c.name]}\n`);
  return false;
});

// argv[2] is the backend selector — the case filter is everything after it.
await fuzzLeg({
  backend: backendKey,
  cases,
  work: WORK,
  boot,
  argv: process.argv.slice(3),
});
