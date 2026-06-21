import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type HexMirror, startHexMirror } from "./support/hex-mirror";

// ---------------------------------------------------------------------------
// Runtime auth UI-gate smoke — proves the auth gate WORKS at runtime, not just
// that it compiles.  Each frontend serves the shared `auth-gate.ddd` fixture (a
// gated ui: an ungated "Public" link, an "admin"-gated link/page, a
// "superadmin"-gated link/page, and an "admin"-gated operation button).  The
// emitted SPA is built + `vite preview`d; a shared Playwright spec
// (test/e2e/support/auth-gate.spec.ts) mocks `/auth/me` to a chosen role (no
// backend) and asserts each gate site hides/shows correctly — the real
// client-side `currentUser.role === …` evaluation the compile-only build gates
// can't exercise.
//
// Opt-in — heavy (npm install + vite build + a Playwright browser download).
//   LOOM_AUTH_GATE_E2E=1 npx vitest run test/e2e/auth-gate-ui-e2e.test.ts
// Mirrors the generated-svelte-e2e harness.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "auth-gate-e2e", "auth-gate.ddd");
const sharedSpec = path.join(here, "support", "auth-gate.spec.ts");

const ENABLED = process.env.LOOM_AUTH_GATE_E2E === "1";

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", stdio: "pipe", timeout: 900_000 });
  } catch (e) {
    // execSync buries the child's stdout/stderr; surface them so a failing
    // `playwright test` (or build) shows WHICH assertion/step failed.
    const err = e as { stdout?: string; stderr?: string };
    const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new Error(`Command failed: ${cmd}\n${out}`);
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms`);
}

/** Generate the fixture as `platform: <fw>` into a fresh workdir, returning the
 *  emitted `web/` project dir. */
function generateAs(fw: string, work: string): string {
  const src = fs.readFileSync(fixture, "utf-8").replace("platform: svelte", `platform: ${fw}`);
  fs.writeFileSync(path.join(work, "main.ddd"), src);
  run(`node ${cli} generate system ${work}/main.ddd -o ${work}/out`, repoRoot);
  return path.join(work, "out", "web");
}

/** Copy the shared gate spec into the project's e2e/ dir, install it + a
 *  chromium browser, and run ONLY that spec against the running server.  The
 *  JSX frontends emit an `e2e/` harness (fixtures.ts + playwright.config);
 *  Angular doesn't, so synthesize a minimal one when missing. */
function runGateSpec(project: string, baseUrl: string): void {
  const e2e = path.join(project, "e2e");
  if (!fs.existsSync(path.join(e2e, "fixtures.ts"))) {
    fs.mkdirSync(e2e, { recursive: true });
    fs.writeFileSync(
      path.join(e2e, "package.json"),
      JSON.stringify({
        name: "gate-e2e",
        private: true,
        devDependencies: { "@playwright/test": "^1.56.0" },
      }),
    );
    fs.writeFileSync(
      path.join(e2e, "playwright.config.ts"),
      'import { defineConfig, devices } from "@playwright/test";\n' +
        'export default defineConfig({ testDir: ".", testMatch: /.*\\.spec\\.ts$/, ' +
        'use: { baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4200" }, ' +
        'projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }] });\n',
    );
    fs.writeFileSync(
      path.join(e2e, "fixtures.ts"),
      'export { test, expect } from "@playwright/test";\n',
    );
  }
  fs.copyFileSync(sharedSpec, path.join(e2e, "auth-gate.spec.ts"));
  run("npm install --no-audit --no-fund", e2e);
  run("npx playwright install --with-deps chromium", e2e);
  run(`E2E_BASE_URL=${baseUrl} npx playwright test auth-gate.spec.ts`, e2e);
}

/** Build the project, start its server (vite preview / static SPA serve) on a
 *  free port, run the shared gate spec against it, then tear the server down. */
async function buildServeTest(
  project: string,
  build: () => void,
  buildArtifact: string,
  serverArgv: (port: number) => string[],
): Promise<void> {
  build();
  expect(fs.existsSync(path.join(project, buildArtifact)), "frontend build output").toBe(true);
  const port = await freePort();
  const server = spawn("npx", serverArgv(port), { cwd: project, stdio: "pipe", detached: true });
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, 60_000);
    runGateSpec(project, baseUrl);
  } finally {
    if (server.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
}

const vitePreview = (port: number): string[] => [
  "vite",
  "preview",
  "--host",
  "127.0.0.1",
  "--port",
  String(port),
  "--strictPort",
];

describe.skipIf(!ENABLED)("auth UI-gate runtime smoke", () => {
  it("svelte: menu / page-guard / op-button gate by role", { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-svelte-"));
    const project = generateAs("svelte", work);
    expect(fs.existsSync(path.join(project, "svelte.config.js")), "svelte project emitted").toBe(
      true,
    );
    run("npm install --no-audit --no-fund", project);
    run("npx svelte-kit sync", project);
    await buildServeTest(project, () => run("npx vite build", project), "build", vitePreview);
  });

  // react + vue are plain Vite SPAs — same `vite preview` of the `dist/`
  // build, no svelte-kit sync.  The shared spec + selectors are identical.
  for (const fw of ["vue", "react"] as const) {
    it(`${fw}: menu / page-guard / op-button gate by role`, { timeout: 900_000 }, async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `loom-gate-${fw}-`));
      const project = generateAs(fw, work);
      expect(fs.existsSync(path.join(project, "vite.config.ts")), `${fw} project emitted`).toBe(
        true,
      );
      run("npm install --no-audit --no-fund", project);
      await buildServeTest(project, () => run("npx vite build", project), "dist", vitePreview);
    });
  }

  // Angular: `ng build` → dist/browser, served as a SPA (serve -s falls back to
  // index.html for client routes).  No emitted e2e/ harness — runGateSpec
  // synthesizes one.  Angular's op hook (`useApproveJob()`, id-less) never
  // eager-derefs, so it was already crash-free.  NB: the Angular CLI requires
  // Node >= 22.22.3; on an older patch the `ng build` step fails the version
  // gate (CI runs a current Node, so this leg is green there).
  it("angular: menu / page-guard / op-button gate by role", { timeout: 900_000 }, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-angular-"));
    const project = generateAs("angular", work);
    expect(fs.existsSync(path.join(project, "angular.json")), "angular project emitted").toBe(true);
    run("npm install --no-audit --no-fund", project);
    await buildServeTest(
      project,
      () => run("npx ng build", project),
      path.join("dist", "browser", "index.html"),
      (port) => ["serve", "-s", path.join("dist", "browser"), "-l", String(port)],
    );
  });
});

// ---------------------------------------------------------------------------
// Phoenix (LiveView) leg — server-rendered gate, separate mechanics.
//
// The JSX frontends above evaluate `currentUser.role === …` CLIENT-side (vite
// preview + Playwright mocking /auth/me).  Phoenix renders the gate
// SERVER-side: the sidebar wraps the admin/super links in
// `<%= if @current_user.role == "…" do %>` and each gated LiveView's
// handle_params redirects a non-matching role.  So this leg boots the actual
// generated Phoenix/Ash app and asserts the dead-render HTML over plain HTTP —
// no browser, no Playwright.
//
// Boot path (the in-sandbox recipe, mirroring generated-elixir-ash-build):
//   docker (hexpm/elixir) + LOOM_HEX_MIRROR (hex.pm via the loopback TLS mirror)
//   + a postgres:16 sidecar + `mix deps.get / ecto.create / ecto.migrate /
//   phx.server` on :4000, then curl from the host (--network host).
//
// Two facts about the dev-stub make the assertions what they are:
//   1. The LiveView `:browser` pipeline authenticates from the SESSION
//      (LiveAuth.verify_session reads session["current_user"]) — NOT from the
//      Auth plug's fixed-admin token (that's only on the :api JSON pipeline).
//      Nothing in the dev-stub seeds that session, so a raw request 302s to
//      /login.  We mint a signed session cookie carrying {role: "admin"} with
//      the SAME secret_key_base + signing_salt the generated endpoint verifies
//      with (config/dev.exs + endpoint.ex), so the server accepts it — the
//      server-side analogue of the JSX legs mocking /auth/me to "admin".
//   2. The generated dev endpoint omits `live_view: [signing_salt: …]`, which
//      LiveView requires to compute the dead-render session token; without it
//      even an authenticated render 500s.  We append it to the throwaway
//      config/dev.exs at boot (test-local; touches no committed source).
//
// With one fixed admin identity this proves BOTH gate branches per site:
//   GET /public → 200, sidebar shows nav-public + nav-admin (admin sees admin
//                 link) but NOT nav-super (admin is not superadmin);
//   GET /admin  → 200, renders "Admin Area", not the deny path;
//   GET /super  → 302 to "/" (the page-guard redirects a non-superadmin — the
//                 server-render equivalent of the JSX "forbidden" stub).
//
// Opt-in (LOOM_AUTH_GATE_E2E) AND skipped unless docker + LOOM_HEX_MIRROR are
// available — the same prerequisites the elixir-ash compile gate guards on.
// ---------------------------------------------------------------------------

const phoenixFixture = path.join(here, "fixtures", "auth-gate-e2e", "auth-gate-phoenix.ddd");
const ELIXIR_IMAGE = "hexpm/elixir:1.17.2-erlang-27.0.1-debian-bookworm-20240722-slim";

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// The native-mix boot needs hex.pm reachable from the container.  In this
// sandbox that means LOOM_HEX_MIRROR=1 (the loopback TLS mirror) — without it
// `mix deps.get` can't fetch through the fingerprinting proxy, so skip rather
// than hang.  (CI runners with direct hex access would set neither and use the
// compose gate instead; this leg is the in-sandbox runtime proof.)
const PHX_RUN = ENABLED && process.env.LOOM_HEX_MIRROR === "1" && dockerAvailable();

describe.skipIf(!PHX_RUN)("auth UI-gate runtime smoke (phoenix / server-rendered)", () => {
  let mirror: HexMirror | undefined;
  let workDir = "";
  let projDir = "";
  const pgName = `loom-gate-pg-${process.pid}`;
  const phxName = `loom-gate-phx-${process.pid}`;
  let phxLog = "";

  function sh(cmd: string, opts: Parameters<typeof execSync>[1] = {}): string {
    return execSync(cmd, { encoding: "utf-8", timeout: 900_000, ...opts }) as string;
  }

  /** Tail the phoenix server log (captured to a file) for failure triage. */
  function serverLogs(): string {
    try {
      const lines = fs.readFileSync(phxLog, "utf-8").split("\n");
      return lines.slice(-120).join("\n");
    } catch {
      return "(no phoenix log captured)";
    }
  }

  async function pollHttp(url: string, ok: (code: number) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    let last = "never reached";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (ok(res.status)) return;
        last = `status ${res.status}`;
      } catch (e) {
        last = String(e);
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    throw new Error(`${url} not ready within ${timeoutMs}ms (${last})\n${serverLogs()}`);
  }

  beforeAll(async () => {
    mirror = await startHexMirror();
    if (!mirror) throw new Error("LOOM_HEX_MIRROR mirror failed to start");

    // 1. Generate the Phoenix project.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gate-phoenix-"));
    sh(`node ${cli} generate system ${phoenixFixture} -o ${workDir}/out`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
    projDir = path.join(workDir, "out", "phoenix_app");
    expect(fs.existsSync(path.join(projDir, "mix.exs")), "phoenix project emitted").toBe(true);

    // 2. The generated dev endpoint omits `live_view: [signing_salt]`; LiveView
    //    needs it for the dead-render session token.  Inject it (test-local).
    fs.appendFileSync(
      path.join(projDir, "config", "dev.exs"),
      "\n# [auth-gate-smoke] LiveView dead-render needs a signing salt.\n" +
        'config :phoenix_app, PhoenixAppWeb.Endpoint, live_view: [signing_salt: "loom-gate-smoke-salt"]\n',
    );

    // 3. Postgres sidecar on the host (the app's dev default is
    //    postgres:postgres@localhost:5432/phoenix_app_dev; --network host below
    //    lets the container reach it on localhost).
    try {
      execSync(`docker rm -f ${pgName}`, { stdio: "ignore" });
    } catch {
      /* no stale container */
    }
    sh(
      `docker run -d --name ${pgName} -e POSTGRES_USER=postgres ` +
        `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=phoenix_app_dev ` +
        `-p 5432:5432 postgres:16`,
      { stdio: "pipe" },
    );
    for (let i = 0; i < 60; i++) {
      try {
        sh(`docker exec ${pgName} pg_isready -U postgres`, { stdio: "ignore" });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    const dockerArgs = mirror.dockerArgs.join(" ");
    const shellPrefix = mirror.shellPrefix;
    const dbUrl = "ecto://postgres:postgres@localhost:5432/phoenix_app_dev";

    // 4. Mint a signed session cookie carrying current_user.role == "admin"
    //    with the dev endpoint's own secret_key_base + signing_salt, so
    //    LiveAuth.verify_session accepts it (the dev-stub never seeds the
    //    session itself).  Done in-container so Plug.Crypto does the signing.
    fs.writeFileSync(
      path.join(projDir, "mint_cookie.exs"),
      [
        "# [auth-gate-smoke] Mint a signed Phoenix session cookie for the dev-stub",
        "# LiveAuth gate, using the endpoint's own secret_key_base + signing_salt.",
        'secret = "dev-secret-key-base-replace-in-production-with-mix-phx-gen-secret"',
        'salt = "loom-generated"',
        'session = %{"current_user" => %{role: System.get_env("ROLE") || "admin"}}',
        "binary = :erlang.term_to_binary(session)",
        "derived = Plug.Crypto.KeyGenerator.generate(secret, salt, iterations: 1000, length: 32, digest: :sha256)",
        'IO.puts("_phoenix_app_key=" <> Plug.Crypto.MessageVerifier.sign(binary, derived))',
      ].join("\n"),
    );

    // 5. Fetch deps + create/migrate the DB + boot phx.server (background), and
    //    mint the cookie along the way.  All inside the elixir image with the
    //    hex mirror's docker args + shell prefix.
    phxLog = path.join(workDir, "phx.log");
    const bootCmd =
      `${shellPrefix}mix local.hex --force && mix local.rebar --force && ` +
      `mix deps.get && mix ecto.create && mix ecto.migrate && ` +
      `mix run --no-start mint_cookie.exs > /app/cookie.txt && ` +
      `mix phx.server`;
    const dockerRun = [
      "docker",
      "run",
      "--rm",
      `--name ${phxName}`,
      dockerArgs,
      `-v ${projDir}:/app`,
      "-w /app",
      "-e MIX_ENV=dev",
      "-e PORT=4000",
      `-e DATABASE_URL=${dbUrl}`,
      ELIXIR_IMAGE,
      `bash -c '${bootCmd}'`,
    ].join(" ");
    const out = fs.openSync(phxLog, "w");
    spawn("bash", ["-c", dockerRun], { stdio: ["ignore", out, out], detached: true }).unref();

    // 6. Wait for the server (dep compile is heavy cold — generous window).
    await pollHttp("http://localhost:4000/health", (c) => c === 200, 720_000);
  }, 900_000);

  afterAll(() => {
    for (const name of [phxName, pgName]) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: "ignore" });
      } catch {
        /* ignore */
      }
    }
    mirror?.stop();
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 120_000);

  it("phoenix: server-rendered menu + page-guard gate by role", { timeout: 120_000 }, async () => {
    try {
      // The admin session cookie minted in-container (step 4).
      const cookie = fs.readFileSync(path.join(projDir, "cookie.txt"), "utf-8").trim();
      expect(cookie.startsWith("_phoenix_app_key="), "cookie minted").toBe(true);
      const hdr = { cookie };

      // Sanity: WITHOUT the cookie the LiveView session is empty → 302 /login.
      const anon = await fetch("http://localhost:4000/public", { redirect: "manual" });
      expect(anon.status, "anon /public redirects (no session)").toBe(302);
      expect(anon.headers.get("location")).toBe("/login");

      // /public — admin sees the menu, with the admin link shown and the
      // super link hidden (both gate branches in one render).
      const pub = await fetch("http://localhost:4000/public", { headers: hdr });
      expect(pub.status).toBe(200);
      const pubHtml = await pub.text();
      expect(pubHtml).toContain('data-testid="nav-public"');
      expect(pubHtml).toContain('data-testid="nav-admin"');
      expect(pubHtml).not.toContain('data-testid="nav-super"');

      // /admin — the page-guard ALLOWS admin: renders the page, no redirect.
      const adm = await fetch("http://localhost:4000/admin", { headers: hdr });
      expect(adm.status).toBe(200);
      expect(await adm.text()).toContain("Admin Area");

      // /super — the page-guard DENIES a non-superadmin: 302 back to "/".
      const sup = await fetch("http://localhost:4000/super", {
        headers: hdr,
        redirect: "manual",
      });
      expect(sup.status).toBe(302);
      expect(sup.headers.get("location")).toBe("/");
    } catch (err) {
      console.error(
        `\n===== phoenix server logs =====\n${serverLogs()}\n===============================\n`,
      );
      throw err;
    }
  });
});
