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
// Cross-tenant isolation — vanilla Phoenix (plain Ecto/Phoenix) backend, the
// fifth leg of the isolation matrix (sibling of tenancy-isolation{,-python,
// -java,-dotnet}.test.ts).  Same corpus fixture + shared assertions; boots via
// host `mix phx.server` (like observability-events-elixir-vanilla.test.ts).
//
// This leg was blocked until the vanilla router create-route parity fix: the
// tenancy fixture's aggregates are BARE (`with tenantOwned` / `crossTenant` /
// bare registry — no `with crudish`), so before the fix the router wired no
// `POST /<plural>` for them (it gated on explicit `creates`) and the shared
// harness 404'd on its first `POST /api/invoices`.  The fix routes create by
// constructibility (`emitsRestCreate`), matching the other four backends, so
// Phoenix now drives the identical create→read isolation sequence.
//
// Opt-in: LOOM_TENANCY_E2E_ELIXIR=1.  Needs elixir/mix on PATH (setup-beam in
// CI) + docker (postgres sidecar) or LOOM_TENANCY_PG_URL.  Slow (~5-8 min cold;
// ~60s warm with the hex cache + _build).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_ELIXIR === "1";

function hasElixir(): boolean {
  try {
    execSync("mix --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated vanilla Phoenix backend (LOOM_TENANCY_E2E_ELIXIR=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      if (!hasElixir())
        throw new Error(
          "LOOM_TENANCY_E2E_ELIXIR=1 set but `mix` is not on PATH. " +
            "Add `erlef/setup-beam@v1` (otp-version 27.x, elixir-version 1.18.x) to the workflow.",
        );
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
        const appDir = path.join(outDir, "d"); // deployable `d` → project root

        // Deps + DB schema.  Unlike the CRUD-only obs fixture, the tenancy
        // fixture emits real migrations (invoices / organizations / plans), so
        // ecto.migrate is required in addition to ecto.create.
        execSync("mix local.hex --force && mix local.rebar --force && mix deps.get", {
          cwd: appDir,
          stdio: "pipe",
          timeout: 600_000,
          shell: "/bin/bash",
        });

        pg = await startPostgres("elixir");
        const dbUrl = `ecto://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;
        execSync("mix ecto.create && mix ecto.migrate", {
          cwd: appDir,
          stdio: "pipe",
          env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
          timeout: 300_000,
          shell: "/bin/bash",
        });

        const port = await freePort();
        child = spawn("mix", ["phx.server"], {
          cwd: appDir,
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            PHX_SERVER: "true",
            PORT: String(port),
            MIX_ENV: "dev",
          },
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
        await waitForReady(base, () => bootLog, 180_000);

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
