// RST-3 — headless behavioral tier for the Java (Spring Boot + JPA) backend.
//
// The node tier (run.mjs) boots Hono in-process on PGlite and dispatches via
// `app.fetch`. No other backend has an in-process Postgres, so this tier boots
// the GENERATED Java backend as a real process against a real Postgres
// (SPRING_DATASOURCE_URL) and HTTP-dispatches the SAME emitted `test e2e`
// api suite at it — the emitted suite is written against the HTTP contract, so
// it is backend-agnostic (matched on pathname). Sibling of run-dotnet.mjs; see
// docs/old/plans/runtime-semantics-tier-followups.md (RST-3).
//
// This gates the *behavioral* runtime-semantics RS-rules (conformance-
// semantics.md) on a FOURTH backend per-PR: camelCase keys both directions
// (RS-1), enum declared casing (RS-2), no leaked columns (RS-3), temporal
// round-trip (RS-4), bool create default (RS-6), value-object survival
// (RS-7), association round-trip (RS-8).
//
// Requires: JDK 21 + Gradle (`gradle`) on PATH and a reachable Postgres via
// SPRING_DATASOURCE_URL. CI provides a `services: postgres` sidecar; locally,
// point SPRING_DATASOURCE_URL at any Postgres (a jdbc: URL).
//
// Usage:  node run-java.mjs [caseName...]
// Exit code is non-zero if any case errors or any test fails.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { featureCases, resetDatabase, sharedSystemCases } from "./cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-java");

// Spring Boot's native datasource env vars. CI's `services: postgres` sidecar
// + the workflow set these; locally default to a plain localhost pg.
const DATASOURCE_URL = process.env.SPRING_DATASOURCE_URL ?? "jdbc:postgresql://127.0.0.1:5432/app";
const DATASOURCE_USERNAME = process.env.SPRING_DATASOURCE_USERNAME ?? "postgres";
const DATASOURCE_PASSWORD = process.env.SPRING_DATASOURCE_PASSWORD ?? "postgres";
const PORT = Number(process.env.LOOM_BH_JAVA_PORT ?? "8125");
// LOOM_BH_JAVA_BASE: dispatch against an ALREADY-running Java backend instead
// of booting one (skips gradle bootJar + java -jar). The obs-style external
// hook — used to run the tier against a manually-booted server.
const EXTERNAL_BASE = process.env.LOOM_BH_JAVA_BASE;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

/** Recursively collect files under `dir` matching `pred`. */
function walk(dir, pred, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "build" || e.name === ".gradle") continue;
      walk(p, pred, out);
    } else if (pred(p)) out.push(p);
  }
  return out;
}

/** The one `platform: java` deployable dir: has a build.gradle(.kts) + a
 *  Spring `…Application.java` under src/main. */
function findJavaDeployable(genDir) {
  const gradles = walk(genDir, (p) => p.endsWith("build.gradle") || p.endsWith("build.gradle.kts"));
  const dirs = [...new Set(gradles.map((p) => dirname(p)))].filter(
    (d) => existsSync(join(d, "src", "main", "java")) && walk(d, (p) => p.endsWith("Application.java")).length > 0,
  );
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one java deployable, found ${dirs.length}: ${dirs.join(", ")}`);
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
 *  after the deadline. Flyway migrations apply at startup (before the server
 *  listens), so a listening port already implies a migrated schema — this is
 *  belt-and-braces. */
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
 *  dispatches each request over real HTTP at the booted Java server. */
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
  // pathname). Re-point every request at the booted Java server.
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
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhjv-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  try {
    const srcPath = join(workDir, "system.ddd");
    writeFileSync(srcPath, c.source);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", srcPath, "-o", genDir], { stdio: "pipe" });
    const deplDir = findJavaDeployable(genDir);
    const e2eDir = join(genDir, "e2e");
    const e2eFile = existsSync(e2eDir) ? (walk(e2eDir, (p) => p.endsWith(".e2e.test.ts"))[0] ?? null) : null;
    if (!e2eFile) throw new Error("no emitted e2e suite (the system declares no `test e2e … against <java>`)");

    if (!EXTERNAL_BASE) {
      // Clean schema per case: each case emits its own migrations at a fixed
      // version, so a shared DB would fail Flyway validation on the 2nd case.
      const pgUrl = DATASOURCE_URL.replace(
        /^jdbc:postgresql:\/\//,
        `postgresql://${DATASOURCE_USERNAME}:${DATASOURCE_PASSWORD}@`,
      );
      await resetDatabase(pgUrl);
      // Build the runnable jar, then boot it. Flyway migrations auto-apply at
      // startup (before the server listens), so a listening port already
      // implies a migrated schema.
      execFileSync("gradle", ["--no-daemon", "-q", "bootJar"], { cwd: deplDir, stdio: "pipe" });
      const jar = readdirSync(join(deplDir, "build", "libs")).find(
        (f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"),
      );
      if (!jar) throw new Error("no jar produced by gradle bootJar");
      // Boot with the JDK that gradle's toolchain compiled against (Java 25):
      // the generated classes are class-file v69, so a stale PATH `java` (the
      // CI runner ships an older default) throws UnsupportedClassVersionError.
      // JAVA_HOME is set to the toolchain JDK by setup-java; fall back to PATH.
      const javaBin = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
      server = spawn(javaBin, ["-jar", join("build", "libs", jar)], {
        cwd: deplDir,
        stdio: "pipe",
        detached: true, // own process group so we can SIGTERM the whole app
        env: {
          ...process.env,
          SERVER_PORT: String(PORT),
          SPRING_DATASOURCE_URL: DATASOURCE_URL,
          SPRING_DATASOURCE_USERNAME: DATASOURCE_USERNAME,
          SPRING_DATASOURCE_PASSWORD: DATASOURCE_PASSWORD,
        },
      });
      let serverLog = "";
      server.stdout.on("data", (d) => { serverLog += d; });
      server.stderr.on("data", (d) => { serverLog += d; });
      const exited = new Promise((_, rej) => server.on("exit", (code) => rej(new Error(`java -jar exited early (code ${code})\n${serverLog.slice(-2000)}`))));
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
// Manifest-derived corpus features (java) + the shared tokenized systems — the
// same two sources every backend runner uses. No per-backend allowlist.
const corpus = [...(await featureCases("java", "java", WORK)), ...sharedSystemCases("java")].filter(
  (c) => only.length === 0 || only.includes(c.name),
);

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  [java → ${BASE}]\n`);
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
