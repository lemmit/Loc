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
// Hierarchy / `policy {}` read-ladder isolation — the runtime proof of
// multi-tenancy Phase 2 (docs/tenancy.md → "Hierarchy" + "The policy {} read
// ladder"), NODE/Hono backend.  Sibling of tenancy-isolation.test.ts (which
// proves the FLAT tenant floor); this boots the `tenancy-hierarchy.ddd` corpus
// fixture (a registry `implements tenantRegistry` + deep/global/local `policy`
// aggregates) against a throwaway postgres and asserts SUBTREE isolation over
// the wire via the shared `assertHierarchyIsolation` sequence.
//
// The structural tiers pin the emitted deep/global filters per backend
// (policy-deep-scope.test.ts) and the orgPath resolver seam; only a boot proves
// the whole chain AGREES end-to-end: setPath writes the materialized path, the
// orgPath resolver reads it back per request, the stamp copies it onto rows,
// and the descendant-or-self predicate then scopes reads to exactly the subtree.
//
// Slow (npm install + docker pg + boot), so opt-in: LOOM_TENANCY_E2E=1.
// LOOM_TENANCY_PG_URL=postgres://… skips the docker sidecar (docker-less dev).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E === "1";

describe.skipIf(!ENABLED)(
  "hierarchy policy-ladder isolation over the generated node backend (LOOM_TENANCY_E2E=1)",
  () => {
    it("deep/global/local reads scope to the org subtree — over the wire", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-hier-node-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-hierarchy.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-hierarchy-node.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "node"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        pg = await startPostgres("hier-node");
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
    }, 360_000);
  },
);
