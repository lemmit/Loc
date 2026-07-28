import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
  type BackendDriver,
  handleFor,
  type PgConn,
  runMigrationEvolutionGate,
} from "./support/migration-evolution-harness.js";

// ---------------------------------------------------------------------------
// Migration-evolution gate (M-T2.13) — JAVA/Spring Boot + JPA backend.
// Sibling of migration-evolution.test.ts; same fixtures + shared checks, boots
// via `gradle bootJar` → `java -jar`.  The jar bundles the Flyway migration
// resources, so the regenerated v2 migration needs a `rebuild` (a second
// bootJar) before the reboot; Flyway then applies it at boot
// (`flyway_schema_history`).
//
// Opt-in: LOOM_MIGRATION_E2E_JAVA=1.  Needs `gradle` + JDK 25 + docker
// (postgres sidecar) or LOOM_MIGRATION_PG_URL, plus host `psql`.
// ---------------------------------------------------------------------------

const ENABLED = process.env.LOOM_MIGRATION_E2E_JAVA === "1";

function bootJar(appDir: string): void {
  execSync("gradle --no-daemon -q bootJar", { cwd: appDir, stdio: "pipe", timeout: 600_000 });
}

const javaDriver: BackendDriver = {
  platform: "java",
  toolchain: {
    name: "gradle",
    check: () => {
      try {
        execSync("gradle --version", { stdio: "pipe", timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },
  },
  install: bootJar,
  // The v2 migration resource must be repackaged into the jar before rebooting.
  rebuild: bootJar,
  boot(appDir, pg: PgConn, port) {
    const jar = fs
      .readdirSync(path.join(appDir, "build", "libs"))
      .find((f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"));
    if (!jar) throw new Error("bootJar produced no runnable jar");
    const jdbc = `jdbc:postgresql://${pg.host}:${pg.port}/${pg.db}`;
    // Boot with the toolchain JDK (Java 25 → class-file v69); a stale PATH
    // `java` on the runner throws UnsupportedClassVersionError.
    const javaBin = process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", "java")
      : "java";
    const child = spawn(javaBin, ["-jar", path.join("build", "libs", jar)], {
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
    return handleFor(child, `http://127.0.0.1:${port}`).handle;
  },
  readyTimeoutMs: 120_000,
};

describe.skipIf(!ENABLED)(
  "migration-evolution gate over the generated java backend (LOOM_MIGRATION_E2E_JAVA=1)",
  () => {
    it("migrate-chain ≡ fresh-create, and seeded rows survive forward-migrate", async () => {
      await runMigrationEvolutionGate(javaDriver);
    }, 1_200_000);
  },
);
