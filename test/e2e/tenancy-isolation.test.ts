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
// Cross-tenant isolation — the runtime leak test for first-class multi-tenancy
// (docs/tenancy.md), NODE/Hono backend.  Generates the corpus fixture
// `tenancy-owned.ddd` (`tenancy by user.tenantId of Organization` + a
// `with tenantOwned` aggregate), boots it against a throwaway postgres
// (migrations apply at boot), then runs the shared isolation + registry
// bootstrap assertions driving two principals via `x-loom-dev-claims`.
//
// The assertion sequence lives in support/tenancy-isolation-harness.ts and is
// backend-agnostic; the sibling files (…-dotnet / -python / -java / -elixir)
// reuse it, differing only in boot mechanics.  This is the assertion the
// structural tiers can't make: the filter is pinned per backend by generator
// tests and the stamp by the 1a.0 pins, but only a boot proves the two agree
// end-to-end (the pre-1a.0 bug — stamp writes the actor id, filter reads the
// claim — made every created row invisible and NO structural test saw it).
//
// Slow (npm install + docker pg + boot), so opt-in: LOOM_TENANCY_E2E=1.
// LOOM_TENANCY_PG_URL=postgres://… skips the docker sidecar (docker-less dev).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E === "1";

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated node backend (LOOM_TENANCY_E2E=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-node-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-node.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "node"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        pg = await startPostgres("node");
        const pgUrl = `postgres://${pg.user}:${pg.password}@${pg.host}:${pg.port}/${pg.db}`;

        execSync("npm install --silent --no-audit --no-fund", {
          cwd: appDir,
          stdio: "pipe",
          timeout: 180_000,
        });
        const port = await freePort();
        child = spawn("npx", ["tsx", "index.ts"], {
          cwd: appDir,
          env: { ...process.env, DATABASE_URL: pgUrl, PORT: String(port) },
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
        await waitForReady(base, () => bootLog);

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
    }, 360_000);
  },
);
