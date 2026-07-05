import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  assertCrossTenantIsolation,
  freePort,
  startPostgres,
  waitForReady,
} from "./support/tenancy-isolation-harness.js";

// ---------------------------------------------------------------------------
// Cross-tenant isolation — ELIXIR / Phoenix (plain Ecto) backend (sibling of
// tenancy-isolation.test.ts).  Same corpus fixture + shared assertions; boots
// via `mix phx.server` (deps.get → ecto.create → ecto.migrate → server).
// Proves the tenantOwned stamp + filter agree at RUNTIME on Ecto — the dev
// stub merges `x-loom-dev-claims` string claims onto the built principal's
// snake_case key (dev-stub only, never in OIDC mode; parity landed in #1673).
//
// Opt-in: LOOM_TENANCY_E2E_ELIXIR=1.  Needs elixir + mix on PATH, hex.pm
// reachable, and docker (postgres sidecar) or LOOM_TENANCY_PG_URL.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_ELIXIR === "1";

function hasMix(): boolean {
  try {
    execSync("mix --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated elixir backend (LOOM_TENANCY_E2E_ELIXIR=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      if (!hasMix()) throw new Error("LOOM_TENANCY_E2E_ELIXIR=1 set but `mix` is not on PATH.");
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-elixir-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-elixir.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "elixir"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        execSync("mix local.hex --force && mix local.rebar --force && mix deps.get", {
          cwd: appDir,
          stdio: "pipe",
          timeout: 300_000,
          shell: "/bin/bash",
        });

        pg = await startPostgres("elixir");
        const dbUrl = `ecto://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;
        const mixEnv = { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" };
        // Vanilla emits Ecto migrations (tenant_id columns et al.), so the
        // tables must be created before boot — create + migrate, not just create.
        execSync("mix ecto.create && mix ecto.migrate", {
          cwd: appDir,
          stdio: "pipe",
          env: mixEnv,
          timeout: 300_000,
          shell: "/bin/bash",
        });

        const port = await freePort();
        child = spawn("mix", ["phx.server"], {
          cwd: appDir,
          env: { ...mixEnv, PHX_SERVER: "true", PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        let bootLog = "";
        child.stdout?.on("data", (c: Buffer) => {
          bootLog += c.toString("utf8");
        });
        child.stderr?.on("data", (c: Buffer) => {
          bootLog += c.toString("utf8");
        });
        const base = `http://127.0.0.1:${port}`;
        await waitForReady(base, () => bootLog, 120_000);

        await assertCrossTenantIsolation(base);
      } finally {
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            child.kill("SIGTERM");
          }
        }
        pg?.stop();
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 900_000);
  },
);
