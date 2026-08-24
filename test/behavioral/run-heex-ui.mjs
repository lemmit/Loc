// HEEx/LiveView behavioural UI leg — the rendered LiveView, driven in a real
// browser, per PR.
//
// WHY THIS IS NOT `run-ui.mjs`.  That runner assumes the SPA topology: a
// separate frontend deployable whose bundle is `vite build`-ed and served as
// static files, with `/api` delegated in-process to a Hono backend on PGlite —
// one origin, no docker, no database server.  LiveView has none of that shape.
// It IS the server: the pages are rendered by the Phoenix app itself, over a
// websocket, against a real Postgres.  There is no bundle to serve and nothing
// to proxy, so this leg boots the generated Phoenix app for real
// (`mix deps.get` → `ecto.create` → `ecto.migrate` → `phx.server`) and points
// Playwright at it.
//
// WHAT IT PROVES that nothing else per-PR does.  `generated-elixir-vanilla-
// build` proves the emitted Elixir COMPILES.  `behavioral-e2e-elixir` boots the
// same app but drives the **api** half of the emitted suite over HTTP — it
// never opens a browser, so every HEEx render arm is invisible to it.  The one
// gate that does render LiveView (`phoenix-ui-e2e.yml`) is `push: main` /
// `run-e2e`-label only, AND its emitted `smoke.spec.ts` only navigates each
// param-less route and asserts the URL — a page that mounts and renders an
// empty shell passes it.  So: a HEEx primitive arm can stop emitting a table
// cell, a form input or a detail field and every per-PR gate stays green.
//
// This leg closes that by running a REAL round-trip, twice over:
//
//   1. the EMITTED `<System>.ui.spec.ts` — what `src/system/ui-e2e-render.ts`
//      lowers from the fixture's `test e2e` block, over the page objects
//      `src/generator/elixir/page-objects-emit.ts` emits.  Until this leg
//      existed that spec had never been executed on Phoenix, and it did not
//      even resolve its own imports.
//   2. `heex-ui-roundtrip.pw.ts` — the create → LIST → detail leg the `test
//      e2e` DSL cannot yet spell (no "assert the row is in the list" verb).
//
// Both assert on RENDERED TEXT, so a 200 with an empty page fails.
//
// Runtime.  `mix` on PATH is used directly when present (CI provides it via
// `erlef/setup-beam`); otherwise every mix step runs inside the pinned
// `hexpm/elixir` image with `--network host`, which is how a sandbox without a
// BEAM toolchain runs the leg locally.  Behind a TLS-fingerprint-allowlisting
// egress proxy, Erlang's `:ssl` cannot reach hex.pm — set `LOOM_HEX_MIRROR=1`
// for the loopback mirror (docs/tools.md; `pkill -f hex-mirror.py` after a
// killed run).  Postgres comes from a docker sidecar unless `LOOM_HEEX_UI_PG_URL`
// supplies one.
//
// Usage:  cd test/behavioral && npm ci ; node run-heex-ui.mjs
// Exit non-zero on any failed spec, or if the stack never boots.
//
// Env knobs:
//   LOOM_HEEX_UI_PG_URL     external postgres (postgres://…), skips the sidecar
//   LOOM_HEEX_UI_PORT       port to boot Phoenix on (default 4111)
//   LOOM_HEEX_UI_IMAGE      elixir image for the no-`mix`-on-PATH path
//   LOOM_HEEX_UI_FORCE_DOCKER=1  use the container even when `mix` is on PATH
//   LOOM_HEX_MIRROR=1       route hex.pm through the loopback mirror
//   PLAYWRIGHT_BROWSERS_PATH  when set, the chromium download step is SKIPPED
//                           (the browser is already provisioned)

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stopServer, waitForPort } from "./proc.mjs";
import { outcomesFromPlaywrightJson } from "./ui-stack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-heex-ui");
const DDD = join(HERE, "heex-ui.ddd");
const ROUNDTRIP_SPEC = join(HERE, "heex-ui-roundtrip.pw.ts");

// Pinned to the same image the compile gate uses
// (test/e2e/generated-elixir-vanilla-build.test.ts), so a dep set that
// resolves there resolves here.
const IMAGE =
  process.env.LOOM_HEEX_UI_IMAGE ??
  "hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim";
const PORT = Number(process.env.LOOM_HEEX_UI_PORT ?? "4111");
const PG_DB = "heex_ui";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const log = (s) => process.stdout.write(`${s}\n`);

/** `mix` on PATH? CI has it (erlef/setup-beam); a bare sandbox does not, and
 *  falls back to the container. */
function hasMix() {
  if (process.env.LOOM_HEEX_UI_FORCE_DOCKER === "1") return false;
  try {
    execFileSync("mix", ["--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** The playwright version this checkout ships — the one whose browser
 *  revisions a pre-provisioned `PLAYWRIGHT_BROWSERS_PATH` store contains.
 *  `undefined` when the repo has no playwright, in which case nothing is
 *  pinned and the emitted harness resolves its own. */
function provisionedPlaywrightVersion() {
  for (const pkg of ["playwright-core", "playwright", "@playwright/test"]) {
    const file = join(REPO, "node_modules", pkg, "package.json");
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, "utf8")).version;
    } catch {
      /* unreadable — try the next */
    }
  }
  return undefined;
}

/** Start the loopback hex mirror when LOOM_HEX_MIRROR=1.  The cert/CA dance
 *  lives in `test/e2e/support/hex-mirror.ts` — bundled rather than reimplemented
 *  so the two Elixir-in-docker paths cannot drift. */
async function startMirror(workDir) {
  if (process.env.LOOM_HEX_MIRROR !== "1") return undefined;
  const entry = join(workDir, "mirror-entry.mts");
  const bundle = join(workDir, "mirror.mjs");
  const src = join(REPO, "test/e2e/support/hex-mirror.ts");
  await build({
    stdin: {
      contents: `export { startHexMirror } from ${JSON.stringify(src)};\n`,
      resolveDir: workDir,
      sourcefile: entry,
      loader: "ts",
    },
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    packages: "external",
    logLevel: "warning",
  });
  const { startHexMirror } = await import(pathToFileURL(bundle).href);
  return await startHexMirror();
}

/** Bring up the postgres sidecar (unless one was supplied) and return the
 *  `ecto://` URL the Phoenix app connects with. */
function startPostgres(name) {
  const external = process.env.LOOM_HEEX_UI_PG_URL;
  if (external) {
    // Re-spelled as Ecto's `ecto://` scheme (config/dev.exs reads DATABASE_URL),
    // and re-pointed at THIS leg's database name so a shared server can host it
    // alongside the other legs' schemas.
    const u = new URL(external);
    const host = u.hostname || "127.0.0.1";
    const user = u.username || "postgres";
    const pass = u.password || "postgres";
    return { url: `ecto://${user}:${pass}@${host}:${u.port || "5432"}/${PG_DB}`, container: null };
  }
  const port = 55432;
  execFileSync(
    "docker",
    // biome-ignore format: one flag per line is noise here
    ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=postgres", "-e", `POSTGRES_DB=${PG_DB}`, "-p", `${port}:5432`, "postgres:18-alpine"],
    { stdio: "pipe", timeout: 300_000 },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { stdio: "pipe", timeout: 5_000 });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("postgres sidecar never became ready");
      execFileSync("sleep", ["0.5"]);
    }
  }
  return { url: `ecto://postgres:postgres@127.0.0.1:${port}/${PG_DB}`, container: name };
}

/** Poll `/health` until the app answers, or the boot promise rejects first. */
async function waitForHealth(base, exited, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raced = await Promise.race([
      fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) }).then(
        (r) => (r.ok ? "ok" : "retry"),
        () => "retry",
      ),
      exited,
    ]);
    if (raced === "ok") return;
    if (Date.now() > deadline) throw new Error(`server never answered ${base}/health`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  const genDir = mkdtempSync(join(tmpdir(), "loom-heex-ui-"));
  const pgName = `loom-heex-ui-pg-${process.pid}`;
  let pg = null;
  let mirror;
  let server;
  let failures = 0;
  try {
    log(`▶ generating ${DDD}`);
    execFileSync("node", [join(REPO, "bin/cli.js"), "generate", "system", DDD, "-o", genDir], {
      stdio: "pipe",
    });
    const projDir = join(genDir, "phoenix_app");
    const e2eDir = join(projDir, "e2e");
    if (!existsSync(join(projDir, "mix.exs"))) throw new Error("no phoenix deployable generated");
    const emittedSpec = join(e2eDir, "HeexUiSystem.ui.spec.ts");
    // A missing emitted spec is the WHOLE point of the leg — never skip past it.
    if (!existsSync(emittedSpec)) {
      throw new Error("the emitted HeexUiSystem.ui.spec.ts is absent — nothing to drive");
    }

    // The LiveView socket lives in `priv/static/assets/app.js`.  Without it the
    // page is inert HTML: `phx-submit` never fires, so the create form would
    // "fail" for a reason that has nothing to do with what is under test.
    // Built on the HOST (node is here; the elixir image has no npm).
    log("▶ building the LiveView assets (app.js + app.css)");
    const assetsDir = join(projDir, "assets");
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: assetsDir, stdio: "pipe", timeout: 600_000 });
    execFileSync(npm, ["run", "build"], { cwd: assetsDir, stdio: "pipe", timeout: 600_000 });

    log("▶ starting postgres");
    pg = startPostgres(pgName);

    mirror = await startMirror(WORK);
    const useMix = hasMix();
    log(`▶ booting the generated Phoenix app on :${PORT} (${useMix ? "host mix" : `docker ${IMAGE}`})`);
    const env = {
      ...process.env,
      DATABASE_URL: pg.url,
      MIX_ENV: "dev",
      PHX_SERVER: "true",
      PORT: String(PORT),
    };
    // ONE shell chain either way: deps → schema → serve.  `phx.server` is last
    // and blocks, so the process staying alive IS the "migrations applied"
    // signal, exactly as run-elixir.mjs relies on.
    const bootScript =
      `${mirror?.shellPrefix ?? ""}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get && mix ecto.create && mix ecto.migrate && mix phx.server`;
    server = useMix
      ? spawn("bash", ["-c", bootScript], { cwd: projDir, env, stdio: "pipe", detached: true })
      : spawn(
          "docker",
          [
            "run", "--rm",
            // The mirror's own args already carry `--network host` (it must, to
            // reach the loopback listener); passing it twice is a docker error.
            ...(mirror?.dockerArgs ?? ["--network", "host"]),
            "-v", `${projDir}:/app`, "-w", "/app",
            "-e", `DATABASE_URL=${pg.url}`, "-e", "MIX_ENV=dev",
            "-e", "PHX_SERVER=true", "-e", `PORT=${PORT}`,
            IMAGE, "bash", "-c", bootScript,
          ],
          { stdio: "pipe", detached: true },
        );
    let serverLog = "";
    server.stdout.on("data", (d) => {
      serverLog += d;
    });
    server.stderr.on("data", (d) => {
      serverLog += d;
    });
    const exited = new Promise((_, rej) =>
      server.on("exit", (code) =>
        rej(new Error(`the Phoenix boot exited early (code ${code})\n${serverLog.slice(-4000)}`)),
      ),
    );
    const base = `http://127.0.0.1:${PORT}`;
    await Promise.race([waitForPort(PORT, 900_000), exited]);
    await waitForHealth(base, exited);
    log(`    LiveView answering on ${base}`);

    // The hand-written list leg, alongside the emitted spec.  Renamed on the
    // way in so the repo's own vitest run never discovers it.
    copyFileSync(ROUNDTRIP_SPEC, join(e2eDir, "heex-roundtrip.spec.ts"));

    log("▶ driving the rendered LiveView in a browser");
    execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: e2eDir, stdio: "pipe", timeout: 600_000 });
    // A provisioned browser store means chromium is already there; downloading
    // over it is pure runner time (and the sandbox forbids it outright).  It
    // does pin a VERSION though: a browser store carries one build revision,
    // and the emitted harness's floating `@playwright/test: ^1.49.0` will
    // happily resolve to a release that wants a newer one ("Executable doesn't
    // exist at …/chromium_headless_shell-<newer>").  So when the store is
    // pre-provisioned, pin the harness to the playwright this checkout ships —
    // the same one the store was provisioned for.  Unset (CI), nothing is
    // pinned and chromium is downloaded normally.
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
      const pinned = provisionedPlaywrightVersion();
      if (pinned) {
        log(`    pinning the e2e harness to @playwright/test@${pinned} (provisioned browser store)`);
        execFileSync(npm, ["install", "--no-audit", "--no-fund", "--no-save", `@playwright/test@${pinned}`], { cwd: e2eDir, stdio: "pipe", timeout: 600_000 });
      }
    } else {
      execFileSync(npx, ["playwright", "install", "--with-deps", "chromium"], { cwd: e2eDir, stdio: "pipe", timeout: 600_000 });
    }
    const reportFile = join(WORK, "report.json");
    rmSync(reportFile, { force: true });
    await new Promise((res) => {
      // --workers=1: both specs write to the SAME database, and the round-trip
      // spec asserts a row DELTA on the list.  Parallel workers would make that
      // delta depend on interleaving.
      const cp = spawn(npx, ["playwright", "test", "--workers=1", "--reporter=list,json"], {
        cwd: e2eDir,
        stdio: "inherit",
        env: { ...process.env, E2E_BASE_URL: base, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile },
      });
      cp.on("exit", res);
    });
    if (!existsSync(reportFile)) throw new Error("Playwright produced no JSON report");
    const results = outcomesFromPlaywrightJson(JSON.parse(readFileSync(reportFile, "utf8")));
    // An empty run is a FAILURE, not a pass: a spec file that silently stopped
    // being collected is exactly the regression this leg is here to catch.
    if (results.length === 0) throw new Error("Playwright ran no specs");
    // Playwright keeps a trace + screenshot per failure (`retain-on-failure` in
    // the emitted config).  `genDir` is a tmpdir this runner deletes on the way
    // out, so lift them into WORK where CI's artifact step can find them.
    const traces = join(e2eDir, "test-results");
    if (existsSync(traces)) cpSync(traces, join(WORK, "test-results"), { recursive: true });

    log("");
    for (const r of results) {
      const ok = r.status === "pass";
      if (!ok) failures++;
      log(`  ${ok ? "✓" : "✗"} ${r.name}`);
      if (!ok && r.error) {
        const lines = String(r.error).replace(/\[[0-9;]*m/g, "").split("\n").slice(0, 8);
        log(`      ${lines.join("\n      ")}`);
      }
    }
  } finally {
    await stopServer(server);
    mirror?.stop();
    if (pg?.container) {
      try {
        execFileSync("docker", ["rm", "-f", pg.container], { stdio: "pipe", timeout: 60_000 });
      } catch {
        /* best effort */
      }
    }
    rmSync(genDir, { recursive: true, force: true });
  }

  log(`\n${failures === 0 ? "PASS" : `FAIL (${failures} spec(s))`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  log(`ERROR: ${err?.stack ?? err}`);
  process.exit(1);
});
