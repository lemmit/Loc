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
// Hierarchy / `policy {}` read-ladder isolation on the SECOND node persistence
// adapter — `platform: node { persistence: mikroorm }`.  Byte-for-byte the same
// harness as tenancy-hierarchy.test.ts (the drizzle leg); only the realization
// clause substituted into the fixture differs.
//
// Why a second node leg rather than a parameter on the first: the subtree
// predicate is the ONE filter shape whose two adapters lower through completely
// different machinery.  Drizzle builds an operator tree (`or(and(isNotNull(…),
// …))` with a `strpos(…) = 1` sql fragment); MikroORM has no prefix operator at
// all, so the predicate rides a `raw()` SQL fragment used as a FilterQuery KEY.
// A raw fragment is exactly the construct a compile tier cannot check: its SQL
// is a string, its `?` bindings are positional, and its cache key is consumed on
// use — a wrong arity, a stale fragment reused across two statements, or an
// unqualified column that turns out ambiguous are all runtime-only failures.
// `tsc --noEmit` is green on every one of them.
//
// And the assertion set is the one that matters for this rendering choice: the
// harness seeds the WILDCARD trap (`orgXa.leak`, unreachable from `org_a` only
// if the prefix test has no pattern language) and the DELIMITER trap
// (`org_ab` vs `org_a`) alongside the ordinary subtree reads, so a `LIKE`-shaped
// regression fails here even though it compiles and passes a naive subtree test.
//
// Slow (npm install + docker pg + boot), so opt-in: LOOM_TENANCY_E2E_MIKROORM=1.
// LOOM_TENANCY_PG_URL=postgres://… skips the docker sidecar (docker-less dev).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_MIKROORM === "1";

describe.skipIf(!ENABLED)(
  "hierarchy policy-ladder isolation over the generated node/mikroorm backend (LOOM_TENANCY_E2E_MIKROORM=1)",
  () => {
    it("deep/global/local reads scope to the org subtree — over the wire", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-hier-mikro-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-hierarchy.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-hierarchy-mikroorm.ddd");
        fs.writeFileSync(
          dddPath,
          fixture.replace("__PLATFORM__", "node { persistence: mikroorm }"),
        );
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        pg = await startPostgres("hier-mikro");
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
