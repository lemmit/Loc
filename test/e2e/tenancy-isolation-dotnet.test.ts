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
// Cross-tenant isolation — .NET/ASP.NET Core + EF Core backend (sibling of
// tenancy-isolation.test.ts).  Same corpus fixture + shared assertions; boots
// via `dotnet run`.  Proves the tenantOwned stamp + filter agree at RUNTIME on
// EF Core — notable because the tenant filter is a STATIC `HasQueryFilter`
// global filter that resolves `currentUser` via the ambient accessor, so the
// dev-claims injection has to reach it per request.  Two principals driven via
// the dev-stub `x-loom-dev-claims` header (parity landed in #1673).
//
// Opt-in: LOOM_TENANCY_E2E_DOTNET=1.  Needs the .NET SDK on PATH + docker
// (postgres sidecar) or LOOM_TENANCY_PG_URL.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_DOTNET === "1";

function hasDotnet(): boolean {
  try {
    execSync("dotnet --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated .NET backend (LOOM_TENANCY_E2E_DOTNET=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      if (!hasDotnet())
        throw new Error("LOOM_TENANCY_E2E_DOTNET=1 set but `dotnet` is not on PATH.");
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-dotnet-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-dotnet.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "dotnet"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        execSync("dotnet restore", { cwd: appDir, stdio: "pipe", timeout: 300_000 });

        pg = await startPostgres("dotnet");
        const conn = `Host=${pg.host};Port=${pg.port};Database=${pg.db};Username=${pg.user};Password=${pg.password}`;

        const port = await freePort();
        child = spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
          cwd: appDir,
          env: {
            ...process.env,
            ConnectionStrings__Default: conn,
            ASPNETCORE_URLS: `http://127.0.0.1:${port}`,
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
    }, 600_000);
  },
);
