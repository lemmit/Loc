import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  assertHierarchyIsolation,
  freePort,
  startPostgres,
  waitForReady,
} from "./support/tenancy-isolation-harness.js";

// ---------------------------------------------------------------------------
// Hierarchy / `policy {}` read-ladder isolation — PYTHON/FastAPI backend
// (sibling of tenancy-hierarchy.test.ts).  Same corpus fixture + shared
// `assertHierarchyIsolation`; only the boot differs (uv sync + uvicorn).  Proves
// the deep/global/local materialized-path scopes agree at RUNTIME on
// FastAPI/SQLAlchemy — the orgPath resolver reads the registry `data_key` in
// Starlette middleware, the stamp copies it, and the SQLAlchemy startswith
// prefix scopes the reads to the subtree.
//
// Opt-in: LOOM_TENANCY_E2E_PYTHON=1.  Needs `uv` on PATH + docker (postgres
// sidecar) or LOOM_TENANCY_PG_URL.  The NULL-dataKey probe needs `psql` too.
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
  "hierarchy policy-ladder isolation over the generated python backend (LOOM_TENANCY_E2E_PYTHON=1)",
  () => {
    it("deep/global/local reads scope to the org subtree — over the wire", async () => {
      if (!hasUv()) throw new Error("LOOM_TENANCY_E2E_PYTHON=1 set but `uv` is not on PATH.");
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-hier-py-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-hierarchy.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-hierarchy-python.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "python"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        execSync("uv sync", { cwd: appDir, stdio: "pipe", timeout: 300_000 });

        pg = await startPostgres("hier-py");
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

        await assertHierarchyIsolation(base, pg);
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
