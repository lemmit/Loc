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
// Cross-tenant isolation — PYTHON/FastAPI backend (sibling of
// tenancy-isolation.test.ts).  Same corpus fixture + same shared assertions;
// only the boot differs (uv sync + uvicorn).  Proves the tenantOwned stamp +
// filter agree at RUNTIME on FastAPI/SQLAlchemy, driving two principals via
// the dev-stub `x-loom-dev-claims` header (parity landed in #1673).
//
// Opt-in: LOOM_TENANCY_E2E_PYTHON=1.  Needs `uv` on PATH + docker (postgres
// sidecar) or LOOM_TENANCY_PG_URL.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_PYTHON === "1";

function hasUv(): boolean {
  try {
    execSync("uv --version", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated python backend (LOOM_TENANCY_E2E_PYTHON=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      if (!hasUv()) throw new Error("LOOM_TENANCY_E2E_PYTHON=1 set but `uv` is not on PATH.");
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-py-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-python.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "python"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        execSync("uv sync", { cwd: appDir, stdio: "pipe", timeout: 300_000 });

        pg = await startPostgres("py");
        const pgUrl = `postgresql+asyncpg://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;

        const port = await freePort();
        child = spawn(
          path.join(appDir, ".venv", "bin", "python"),
          ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(port)],
          {
            cwd: appDir,
            env: { ...process.env, DATABASE_URL: pgUrl, PORT: String(port) },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          },
        );
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
