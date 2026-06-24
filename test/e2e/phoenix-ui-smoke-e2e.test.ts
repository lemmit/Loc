import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Phoenix/LiveView UI smoke — runtime end-to-end guard.
//
// The four SPA frontends run their emitted route-driven `e2e/smoke.spec.ts`
// against a `vite preview` of the built bundle (generated-{vue,svelte}-e2e.yml).
// LiveView is server-rendered, so its smoke needs the real server + a database
// booted — this is the Phoenix sibling of those gates.
//
// Boot the generated Phoenix app (mix deps.get + ecto.create/migrate +
// phx.server) against a postgres sidecar, then run the SPA's own emitted
// Playwright smoke (every param-less LiveView route navigates + asserts its
// URL) against http://localhost:<port>.  Proves the routes the generator wired
// actually mount and render — the runtime regression class the `mix compile`
// gate (generated-elixir-vanilla-build) is blind to.
//
// Slow (~5-8min cold; hex deps + Phoenix compile + postgres) and requires docker
// (or LOOM_OBS_PG_URL) + mix on PATH + a Playwright chromium download.  Opt-in
// via LOOM_PHOENIX_UI_E2E=1; shares the elixir-ash-obs-e2e.yml provisioning
// (postgres service + erlef/setup-beam).  Mechanics mirror the proven
// embed-react-elixir.test.ts (same boot/migrate/health dance).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const EXAMPLE = path.join(repoRoot, "web", "src", "examples", "storefront-elixir.ddd");

const ENABLED = process.env.LOOM_PHOENIX_UI_E2E === "1";

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function hasElixir(): boolean {
  try {
    execSync("mix --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
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

describe.skipIf(!ENABLED)("Phoenix LiveView UI smoke — runtime e2e (LOOM_PHOENIX_UI_E2E=1)", () => {
  it("every param-less LiveView route navigates + loads", async () => {
    if (!process.env.LOOM_OBS_PG_URL && !hasDocker()) {
      throw new Error(
        "LOOM_PHOENIX_UI_E2E=1 set but no LOOM_OBS_PG_URL was provided and the " +
          "docker daemon is unreachable. Supply LOOM_OBS_PG_URL=postgres://… or " +
          "ensure docker is available for a local sidecar.",
      );
    }
    if (!hasElixir()) {
      throw new Error(
        "LOOM_PHOENIX_UI_E2E=1 set but `mix` is not on PATH. " +
          "Add `erlef/setup-beam@v1` (otp 27.3 / elixir 1.18.4) to the workflow.",
      );
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-px-ui-"));
    const externalPgUrl = process.env.LOOM_OBS_PG_URL;
    const externalPgDb = process.env.LOOM_OBS_PG_DB ?? "phoenix_app";
    const useExternalPg = !!externalPgUrl;
    const pgPort = useExternalPg ? Number(new URL(externalPgUrl).port || "5432") : await freePort();
    const appPort = await freePort();
    const pgContainer = `loom-px-ui-pg-${Date.now()}`;
    let mixChild: ReturnType<typeof spawn> | null = null;
    try {
      // 1. Postgres sidecar (only when no external one supplied).
      if (!useExternalPg) {
        execSync(
          `docker run -d --rm --name ${pgContainer} ` +
            `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${externalPgDb} ` +
            `-p ${pgPort}:5432 postgres:18-alpine`,
          { stdio: "pipe", timeout: 60_000 },
        );
        const pgDeadline = Date.now() + 60_000;
        while (true) {
          try {
            execSync(`docker exec ${pgContainer} pg_isready -U postgres`, {
              stdio: "pipe",
              timeout: 5_000,
            });
            break;
          } catch {
            if (Date.now() > pgDeadline) throw new Error("postgres sidecar never became ready");
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }

      // 2. Generate the system + assert the emitted e2e smoke surface.
      execSync(`node ${cli} generate system ${EXAMPLE} -o ${outDir}/out`, {
        stdio: "pipe",
        cwd: repoRoot,
      });
      const projDir = path.join(outDir, "out", "phoenix_app");
      expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);
      const e2eDir = path.join(projDir, "e2e");
      expect(fs.existsSync(path.join(e2eDir, "smoke.spec.ts")), "smoke spec emitted").toBe(true);
      expect(fs.existsSync(path.join(e2eDir, "playwright.config.ts"))).toBe(true);

      // 3. Deps + DB schema (the migrate-on-boot release task also runs, but
      //    create the DB + migrate explicitly so a fresh sidecar has tables).
      const dbUrl = `ecto://postgres:postgres@127.0.0.1:${pgPort}/${externalPgDb}`;
      execSync(`mix local.hex --force && mix local.rebar --force && mix deps.get`, {
        cwd: projDir,
        stdio: "pipe",
        timeout: 600_000,
        shell: "/bin/bash",
      });
      execSync(`mix ecto.create && mix ecto.migrate`, {
        cwd: projDir,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
        timeout: 300_000,
        shell: "/bin/bash",
      });

      // 4. Boot the server.
      mixChild = spawn("mix", ["phx.server"], {
        cwd: projDir,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          PHX_SERVER: "true",
          PORT: String(appPort),
          MIX_ENV: "dev",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let stdout = "";
      mixChild.stdout!.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });
      mixChild.stderr!.on("data", (c: Buffer) => {
        stdout += c.toString("utf8");
      });

      // 5. Wait until the endpoint answers /health.
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 120_000;
        const tick = setInterval(async () => {
          try {
            const r = await fetch(`http://127.0.0.1:${appPort}/health`, {
              signal: AbortSignal.timeout(2_000),
            });
            if (r.ok) {
              clearInterval(tick);
              resolve();
            }
          } catch {
            /* not up yet */
          }
          if (Date.now() > deadline) {
            clearInterval(tick);
            reject(new Error(`server never answered /health; stdout:\n${stdout.slice(0, 8192)}`));
          }
        }, 500);
      });

      // 6. Run the emitted Playwright smoke against the live server.
      execSync("npm install --no-audit --no-fund", {
        cwd: e2eDir,
        stdio: "pipe",
        timeout: 300_000,
      });
      execSync("npx playwright install --with-deps chromium", {
        cwd: e2eDir,
        stdio: "pipe",
        timeout: 300_000,
      });
      execSync(`E2E_BASE_URL=http://127.0.0.1:${appPort} npx playwright test smoke.spec.ts`, {
        cwd: e2eDir,
        stdio: "pipe",
        timeout: 300_000,
      });
    } finally {
      if (mixChild && mixChild.exitCode == null) {
        try {
          process.kill(-mixChild.pid!, "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      if (!useExternalPg) {
        try {
          execSync(`docker rm -f ${pgContainer}`, { stdio: "pipe", timeout: 30_000 });
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 900_000);
});
