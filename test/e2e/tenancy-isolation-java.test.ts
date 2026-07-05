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
// Cross-tenant isolation — JAVA/Spring Boot backend (sibling of
// tenancy-isolation.test.ts).  Same corpus fixture + shared assertions; boots
// via `gradle bootJar` → `java -jar`.  Proves the tenantOwned stamp + filter
// agree at RUNTIME on Spring Boot / JPA, driving two principals via the
// dev-stub `x-loom-dev-claims` header (parity landed in #1673).
//
// Opt-in: LOOM_TENANCY_E2E_JAVA=1.  Needs `gradle` + JDK 21 on PATH + docker
// (postgres sidecar) or LOOM_TENANCY_PG_URL.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_TENANCY_E2E_JAVA === "1";

function hasGradle(): boolean {
  try {
    execSync("gradle --version", { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!ENABLED)(
  "cross-tenant isolation over the generated java backend (LOOM_TENANCY_E2E_JAVA=1)",
  () => {
    it("tenant A's rows are invisible to tenant B — 404 on get, absent from list", async () => {
      if (!hasGradle()) throw new Error("LOOM_TENANCY_E2E_JAVA=1 set but `gradle` is not on PATH.");
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tenancy-java-"));
      let child: ReturnType<typeof spawn> | undefined;
      let pg: Awaited<ReturnType<typeof startPostgres>> | undefined;
      try {
        const fixture = fs.readFileSync(
          path.join(repoRoot, "test", "fixtures", "corpus", "tenancy-owned.ddd"),
          "utf8",
        );
        const dddPath = path.join(outDir, "tenancy-owned-java.ddd");
        fs.writeFileSync(dddPath, fixture.replace("__PLATFORM__", "java"));
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const appDir = path.join(outDir, "d"); // deployable `d`

        execSync("gradle --no-daemon -q bootJar", {
          cwd: appDir,
          stdio: "pipe",
          timeout: 600_000,
        });
        const jar = fs
          .readdirSync(path.join(appDir, "build", "libs"))
          .find((f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"));
        if (!jar) throw new Error("bootJar produced no runnable jar");

        pg = await startPostgres("java");
        const jdbc = `jdbc:postgresql://${pg.host}:${pg.port}/${pg.db}`;

        const port = await freePort();
        child = spawn("java", ["-jar", path.join("build", "libs", jar)], {
          cwd: appDir,
          env: {
            ...process.env,
            SPRING_DATASOURCE_URL: jdbc,
            SPRING_DATASOURCE_USERNAME: pg.user,
            SPRING_DATASOURCE_PASSWORD: pg.password,
            SERVER_PORT: String(port),
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
    }, 900_000);
  },
);
