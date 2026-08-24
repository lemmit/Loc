import { execSync, spawn } from "node:child_process";
import { describe, it } from "vitest";
import {
  type BackendDriver,
  handleFor,
  type PgConn,
  runMigrationEvolutionGate,
} from "./support/migration-evolution-harness.js";
import { mixDepsGet } from "./support/mix-retry.js";

// ---------------------------------------------------------------------------
// Migration-evolution gate (M-T2.13) — vanilla Phoenix (plain Ecto/Phoenix)
// backend.  Sibling of migration-evolution.test.ts; same fixtures + shared
// checks, boots via host `mix phx.server`.  Unlike the other four backends,
// vanilla Phoenix does NOT migrate at boot, so the driver's `migrate` hook runs
// `mix ecto.create && mix ecto.migrate` before each boot — for the v2 boot this
// applies the derived delta migration (Ecto's `schema_migrations` tracks it).
//
// Opt-in: LOOM_MIGRATION_E2E_ELIXIR=1.  Needs elixir/mix + docker (postgres
// sidecar) or LOOM_MIGRATION_PG_URL, plus host `psql`.  LOOM_HEX_MIRROR=1
// routes hex.pm through the loopback mirror behind a fingerprint-allowlisting
// proxy (see CLAUDE.md → egress proxy wrinkle).
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_MIGRATION_E2E_ELIXIR === "1";

function ectoUrl(pg: PgConn): string {
  return `ecto://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;
}

const elixirDriver: BackendDriver = {
  platform: "elixir",
  toolchain: {
    name: "mix",
    check: () => {
      try {
        execSync("mix --version", { stdio: "pipe", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },
  },
  install(appDir) {
    execSync(`mix local.hex --force && mix local.rebar --force && ${mixDepsGet()}`, {
      cwd: appDir,
      stdio: "pipe",
      timeout: 600_000,
      shell: "/bin/bash",
    });
  },
  // Vanilla Phoenix migrates out of band, not at boot.  `ecto.create` is
  // idempotent (a no-op on the existing chain DB); `ecto.migrate` applies only
  // the pending migration — Initial on the first call, the delta on the second.
  migrate(appDir, pg: PgConn) {
    execSync("mix ecto.create && mix ecto.migrate", {
      cwd: appDir,
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: ectoUrl(pg), MIX_ENV: "dev" },
      timeout: 300_000,
      shell: "/bin/bash",
    });
  },
  boot(appDir, pg: PgConn, port) {
    const child = spawn("mix", ["phx.server"], {
      cwd: appDir,
      env: {
        ...process.env,
        DATABASE_URL: ectoUrl(pg),
        PHX_SERVER: "true",
        PORT: String(port),
        MIX_ENV: "dev",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return handleFor(child, `http://127.0.0.1:${port}`).handle;
  },
  readyTimeoutMs: 180_000,
};

describe.skipIf(!ENABLED)(
  "migration-evolution gate over the generated vanilla Phoenix backend (LOOM_MIGRATION_E2E_ELIXIR=1)",
  () => {
    it("migrate-chain ≡ fresh-create, and seeded rows survive forward-migrate", async () => {
      await runMigrationEvolutionGate(elixirDriver);
    }, 1_200_000);
  },
);
