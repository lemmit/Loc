import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Phoenix-embeds-React — runtime end-to-end guard (D-PHOENIX-SURFACE).
//
// The mix-compile gate (test/e2e/generated-phoenix-build.test.ts +
// phoenix-build.yml) proves the embedded-react Elixir side *compiles*.
// This guard proves it *runs*: boot the generated Phoenix backend, build
// the embedded SPA into priv/static/app, then assert the two halves the
// embed wiring is supposed to serve from one origin —
//   - GET /app           → the SPA's index.html (Plug.Static + SpaController)
//   - GET /api/<agg>      → the Ash JSON API (same origin, no CORS)
//
// Without this, an endpoint/router/Plug.Static misconfiguration (e.g. the
// /app static mount pointing at the wrong priv path, or the SpaController
// fallback shadowing /api) compiles cleanly and only fails at runtime.
//
// Slow (~5-8 min cold; ~60s warm) and requires docker (postgres sidecar)
// + elixir/mix on PATH + node (vite build) + network to hex.pm.  Opt-in
// via LOOM_EMBED_E2E_PHOENIX=1; reuses the phoenix-obs-e2e.yml workflow's
// postgres service + BEAM setup (LOOM_OBS_PG_URL / LOOM_OBS_PG_DB).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");
const fixture = path.join(here, "fixtures", "phoenix-build", "phoenix-embed-react.ddd");

const ENABLED = process.env.LOOM_EMBED_E2E_PHOENIX === "1";

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
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

describe.skipIf(!ENABLED)("Phoenix embeds React — runtime e2e (LOOM_EMBED_E2E_PHOENIX=1)", () => {
  it("serves the SPA at /app and the Ash JSON API at /api from one origin", async () => {
    // Prereqs checked in-test (not skipIf) so a misconfigured CI fails
    // loudly rather than silently passing.
    if (!process.env.LOOM_OBS_PG_URL && !hasDocker()) {
      throw new Error(
        "LOOM_EMBED_E2E_PHOENIX=1 set but no LOOM_OBS_PG_URL was provided and " +
          "the docker daemon is unreachable. Supply LOOM_OBS_PG_URL=postgres://… " +
          "(CI service container) or ensure docker is available for a local sidecar.",
      );
    }
    if (!hasElixir()) {
      throw new Error(
        "LOOM_EMBED_E2E_PHOENIX=1 set but `mix` is not on PATH. " +
          "Add `erlef/setup-beam@v1` (otp 27.0 / elixir 1.17.2) to the workflow.",
      );
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-embed-px-"));
    const externalPgUrl = process.env.LOOM_OBS_PG_URL;
    const externalPgDb = process.env.LOOM_OBS_PG_DB ?? "phoenix_app";
    const useExternalPg = !!externalPgUrl;
    const pgPort = useExternalPg ? Number(new URL(externalPgUrl).port || "5432") : await freePort();
    const appPort = await freePort();
    const pgContainer = `loom-embed-px-pg-${Date.now()}`;
    let mixChild: ReturnType<typeof spawn> | null = null;
    try {
      // 1. Postgres sidecar (only when no external one supplied).
      if (!useExternalPg) {
        execSync(
          `docker run -d --rm --name ${pgContainer} ` +
            `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${externalPgDb} ` +
            `-p ${pgPort}:5432 postgres:16-alpine`,
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

      // 2. Generate the project from the embed-react fixture.
      execSync(`node ${cli} generate system ${fixture} -o ${outDir}/out`, {
        stdio: "pipe",
        cwd: repoRoot,
      });
      const projDir = path.join(outDir, "out", "phoenix_app");
      expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);
      // The embed wiring must have emitted the SPA project + serve files.
      expect(fs.existsSync(path.join(projDir, "assets", "package.json"))).toBe(true);
      expect(
        fs.existsSync(
          path.join(projDir, "lib", "phoenix_app_web", "controllers", "spa_controller.ex"),
        ),
      ).toBe(true);

      // 3. Build the embedded SPA into priv/static/app — the step the
      //    Dockerfile's spa-build stage does in prod.  vite build reads
      //    assets/ and emits dist/; copy it where Plug.Static (/app) +
      //    the SpaController index path expect it.
      const assetsDir = path.join(projDir, "assets");
      execSync(`npm install --no-audit --no-fund`, {
        cwd: assetsDir,
        stdio: "pipe",
        timeout: 300_000,
      });
      execSync(`npm run build`, { cwd: assetsDir, stdio: "pipe", timeout: 300_000 });
      const spaDest = path.join(projDir, "priv", "static", "app");
      fs.mkdirSync(spaDest, { recursive: true });
      fs.cpSync(path.join(assetsDir, "dist"), spaDest, { recursive: true });
      expect(fs.existsSync(path.join(spaDest, "index.html"))).toBe(true);

      // 4. Deps + DB schema.
      const dbUrl = `ecto://postgres:postgres@127.0.0.1:${pgPort}/${externalPgDb}`;
      execSync(`mix local.hex --force && mix local.rebar --force && mix deps.get`, {
        cwd: projDir,
        stdio: "pipe",
        timeout: 300_000,
        shell: "/bin/bash",
      });
      execSync(`mix ecto.create && mix ecto.migrate`, {
        cwd: projDir,
        stdio: "pipe",
        env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
        timeout: 300_000,
        shell: "/bin/bash",
      });

      // 5. Boot the server.
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

      // 6. Wait until the endpoint answers /api/health (cheaper than
      //    parsing the structured log; the obs test owns that surface).
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

      const ctx = `stdout (first 4kB): ${stdout.slice(0, 4096)}`;

      // 7a. GET /app → the embedded SPA's index.html (Plug.Static at
      //     /app + the SpaController fallback for client-side routes).
      const appRes = await fetch(`http://127.0.0.1:${appPort}/app`);
      expect(appRes.status, ctx).toBe(200);
      expect(appRes.headers.get("content-type") ?? "", ctx).toContain("text/html");
      const appBody = await appRes.text();
      // Vite-built index.html references the bundled module script.
      expect(appBody, ctx).toContain('<div id="root">');

      // 7a′. The bundle's assets must be referenced under /app (vite
      //      `base: "/app/"`) and actually load — a root-based
      //      `/assets/...` href would 404 here, which is the bug the
      //      basePath thread fixes.  Pull the module script's src out of
      //      index.html and fetch it.
      const scriptSrc = appBody.match(/<script[^>]+src="([^"]+)"/)?.[1] ?? "";
      expect(scriptSrc, `${ctx} index.html script src`).toMatch(/^\/app\/assets\//);
      const assetRes = await fetch(`http://127.0.0.1:${appPort}${scriptSrc}`);
      expect(assetRes.status, `${ctx} GET ${scriptSrc}`).toBe(200);
      expect(assetRes.headers.get("content-type") ?? "", ctx).toMatch(/javascript/);

      // 7b. A client-side deep link under /app → still the SPA shell
      //     (the SpaController catch-all, the MapFallbackToFile analogue).
      const deepRes = await fetch(`http://127.0.0.1:${appPort}/app/products`);
      expect(deepRes.status, ctx).toBe(200);
      expect((await deepRes.text()).includes('<div id="root">'), ctx).toBe(true);

      // 7c. GET /api/products → the Ash JSON API, same origin, no CORS.
      const apiRes = await fetch(`http://127.0.0.1:${appPort}/api/products`);
      expect(apiRes.status, ctx).toBe(200);
      expect(apiRes.headers.get("content-type") ?? "", ctx).toContain("application/json");
      // Empty DB → an empty list (the response is the list envelope).
      const apiBody = (await apiRes.json()) as unknown;
      expect(Array.isArray(apiBody) || typeof apiBody === "object", ctx).toBe(true);

      // 8. Tear down the process group.
      try {
        process.kill(-mixChild.pid!, "SIGTERM");
      } catch {
        mixChild.kill("SIGTERM");
      }
      await new Promise<void>((resolve) => {
        if (mixChild!.exitCode != null) resolve();
        else mixChild!.on("exit", () => resolve());
      });
    } finally {
      if (mixChild && mixChild.exitCode == null) {
        try {
          process.kill(-mixChild.pid!, "SIGKILL");
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
  }, 700_000);
});
