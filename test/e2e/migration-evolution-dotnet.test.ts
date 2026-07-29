import { execSync, spawn } from "node:child_process";
import { describe, it } from "vitest";
import {
  type BackendDriver,
  handleFor,
  type PgConn,
  runMigrationEvolutionGate,
} from "./support/migration-evolution-harness.js";

// ---------------------------------------------------------------------------
// Migration-evolution gate (M-T2.13) — .NET/ASP.NET Core + EF Core backend.
// Sibling of migration-evolution.test.ts; same fixtures + shared checks, boots
// via `dotnet run` (which recompiles the regenerated migration on reboot).
// Migrations apply at boot via `Database.Migrate()` (`__EFMigrationsHistory`).
//
// Opt-in: LOOM_MIGRATION_E2E_DOTNET=1.  Needs the .NET SDK + docker (postgres
// sidecar) or LOOM_MIGRATION_PG_URL, plus host `psql`.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_MIGRATION_E2E_DOTNET === "1";

const dotnetDriver: BackendDriver = {
  platform: "dotnet",
  toolchain: {
    name: "dotnet",
    check: () => {
      try {
        execSync("dotnet --version", { stdio: "pipe", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },
  },
  install(appDir) {
    execSync("dotnet restore", { cwd: appDir, stdio: "pipe", timeout: 300_000 });
  },
  boot(appDir, pg: PgConn, port) {
    const conn = `Host=${pg.host};Port=${pg.port};Database=${pg.db};Username=${pg.user};Password=${pg.password}`;
    // `dotnet run` (no --no-build) recompiles, so the regenerated migration is
    // picked up on the v2 reboot without a separate rebuild step.
    const child = spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
      cwd: appDir,
      env: {
        ...process.env,
        ConnectionStrings__Default: conn,
        ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    return handleFor(child, `http://127.0.0.1:${port}`).handle;
  },
  readyTimeoutMs: 240_000,
};

describe.skipIf(!ENABLED)(
  "migration-evolution gate over the generated .NET backend (LOOM_MIGRATION_E2E_DOTNET=1)",
  () => {
    it("migrate-chain ≡ fresh-create, and seeded rows survive forward-migrate", async () => {
      await runMigrationEvolutionGate(dotnetDriver);
    }, 900_000);
  },
);
