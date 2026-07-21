import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Observability e2e for the Java backend (LOOM_OBS_E2E_JAVA=1): generate a
// system, `gradle bootJar` the deployable, boot the jar against Postgres,
// hit /health, shut down, and assert the catalog envelope appeared on
// stdout:
//
//   server_starting → server_listening → request_start {method,path} →
//   request_end {status,duration_ms} → server_shutdown → server_drained
//
// Catalog lines are flat JSON objects (see emit/observability.ts).
// Postgres comes from docker (postgres:18-alpine) by default; set
// LOOM_OBS_PG_URL=jdbc:postgresql://host:port/db to use a running
// instance instead (the local-dev path on docker-less machines).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_OBS_E2E_JAVA === "1";
const PG_URL_OVERRIDE = process.env.LOOM_OBS_PG_URL;

const SRC = `
system ObsShop {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable obsApi {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function hasGradle(): boolean {
  try {
    execSync("gradle --version", { stdio: "pipe", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not pick a free port"));
      }
    });
  });
}

interface CatalogLine {
  ts?: string;
  level?: string;
  event?: string;
  method?: string;
  path?: string;
  status?: number;
  duration_ms?: number;
  [k: string]: unknown;
}

function parseCatalogLines(raw: string): CatalogLine[] {
  const out: CatalogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as CatalogLine;
      if (parsed.event) out.push(parsed);
    } catch {
      /* skip non-JSON noise */
    }
  }
  return out;
}

describe.skipIf(!ENABLED)(
  "generated Java backend emits the observability catalog on stdout (LOOM_OBS_E2E_JAVA=1)",
  () => {
    it("boot + /health round-trip emits the catalog lifecycle + request bracket", async () => {
      // Prerequisite checks INSIDE the test so a misconfigured CI
      // environment fails loudly instead of skipping silently.
      if (!hasGradle()) throw new Error("LOOM_OBS_E2E_JAVA=1 requires Gradle on PATH");
      if (!PG_URL_OVERRIDE && !hasDocker()) {
        throw new Error("LOOM_OBS_E2E_JAVA=1 requires docker (or LOOM_OBS_PG_URL)");
      }

      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-java-"));
      const srcFile = path.join(outDir, "obs.ddd");
      fs.writeFileSync(srcFile, SRC);
      const httpPort = await freePort();
      let pgContainer: string | null = null;
      let app: ChildProcess | null = null;
      let stdout = "";
      try {
        // 1. Generate + build.
        execSync(`node ${cli} generate system ${srcFile} -o ${outDir}`, {
          stdio: "inherit",
          cwd: repoRoot,
        });
        const projectDir = path.join(outDir, "obs_api");
        execSync("gradle --no-daemon -q bootJar", {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 600_000,
        });

        // 2. Postgres — docker sidecar unless an URL override is given.
        let pgUrl = PG_URL_OVERRIDE;
        if (!pgUrl) {
          const pgPort = await freePort();
          pgContainer = execSync(
            `docker run -d --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=obs_api -p ${pgPort}:5432 postgres:18-alpine`,
            { encoding: "utf8" },
          ).trim();
          pgUrl = `jdbc:postgresql://127.0.0.1:${pgPort}/obs_api`;
          // Wait for postgres readiness.
          const deadline = Date.now() + 60_000;
          for (;;) {
            try {
              execSync(`docker exec ${pgContainer} pg_isready -U postgres`, {
                stdio: "pipe",
                timeout: 5_000,
              });
              break;
            } catch {
              if (Date.now() > deadline) throw new Error("postgres never became ready");
              await new Promise((r) => setTimeout(r, 1_000));
            }
          }
        }

        // 3. Boot the jar, capturing stdout.
        const jar = fs
          .readdirSync(path.join(projectDir, "build", "libs"))
          .find((f) => f.endsWith(".jar") && !f.endsWith("-plain.jar"));
        if (!jar) throw new Error("no jar produced by gradle bootJar");
        // Boot with the toolchain JDK (Java 25 → class-file v69); a stale PATH
        // `java` on the runner throws UnsupportedClassVersionError. JAVA_HOME is
        // the setup-java JDK; fall back to PATH `java` locally.
        const javaBin = process.env.JAVA_HOME
          ? path.join(process.env.JAVA_HOME, "bin", "java")
          : "java";
        app = spawn(javaBin, ["-jar", path.join("build", "libs", jar)], {
          cwd: projectDir,
          env: {
            ...process.env,
            SERVER_PORT: String(httpPort),
            SPRING_DATASOURCE_URL: pgUrl,
            SPRING_DATASOURCE_USERNAME: "postgres",
            SPRING_DATASOURCE_PASSWORD: "postgres",
          },
        });
        app.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        app.stderr?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });

        // 4. Wait for server_listening.
        {
          const deadline = Date.now() + 120_000;
          for (;;) {
            if (parseCatalogLines(stdout).some((l) => l.event === "server_listening")) break;
            if (Date.now() > deadline) {
              throw new Error(
                `server didn't reach server_listening; stdout:\n${stdout.slice(0, 8192)}`,
              );
            }
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // 5. One request → the request bracket.
        const r = await fetch(`http://127.0.0.1:${httpPort}/health`);
        expect(r.status).toBe(200);

        // 5b. Prometheus scrape (M-T7.1): /metrics (Actuator + Micrometer,
        // remapped from /actuator/prometheus) exposes the JVM/process meters
        // + the HTTP counter/histogram recorded for the /health request,
        // labelled by the matched route TEMPLATE.
        const m = await fetch(`http://127.0.0.1:${httpPort}/metrics`);
        expect(m.status).toBe(200);
        const metricsBody = await m.text();
        expect(metricsBody).toMatch(/jvm_memory_used_bytes/);
        expect(metricsBody).toMatch(
          /http_requests_total\{method="GET",route="\/health",status="200"\}/,
        );
        expect(metricsBody).toMatch(/http_request_duration_seconds_bucket\{/);
        expect(metricsBody).toMatch(/http_request_duration_seconds_count\{/);

        // 6. Graceful shutdown → server_shutdown + server_drained.
        app.kill("SIGTERM");
        {
          const deadline = Date.now() + 30_000;
          for (;;) {
            if (parseCatalogLines(stdout).some((l) => l.event === "server_drained")) break;
            if (Date.now() > deadline) break;
            await new Promise((r2) => setTimeout(r2, 500));
          }
        }

        // 7. Assert the envelope.
        const events = parseCatalogLines(stdout);
        const names = new Set(events.map((e) => e.event));
        const ctx = `events seen: ${[...names].join(", ")}`;
        expect(names.has("server_starting"), ctx).toBe(true);
        expect(names.has("server_listening"), ctx).toBe(true);
        expect(names.has("server_shutdown"), ctx).toBe(true);
        expect(names.has("server_drained"), ctx).toBe(true);
        const start = events.find((e) => e.event === "request_start" && e.path === "/health");
        const end = events.find((e) => e.event === "request_end" && e.path === "/health");
        expect(start, ctx).toBeDefined();
        expect(end, ctx).toBeDefined();
        expect(start!.method).toBe("GET");
        expect(end!.status).toBe(200);
        expect(typeof end!.duration_ms).toBe("number");
        // Cross-backend envelope: every catalog line leads with ts + level.
        // (Unification onto the single channel + LOG_LEVEL parity — these were
        // absent before, the gap this PR closes.)
        for (const e of events) {
          expect(typeof e.ts, `${e.event} missing ts`).toBe("string");
          expect(e.ts, `${e.event} ts not ISO-8601`).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect(["trace", "debug", "info", "warn", "error"], `${e.event} bad level`).toContain(
            e.level,
          );
        }
        expect(start!.level).toBe("info");
        expect(end!.level).toBe("info");
        // scope_id rides every request-scoped line (MDC, set at the filter) —
        // the audit/provenance join key, shared across the request bracket.
        expect(start!.scope_id).toBeTruthy();
        expect(end!.scope_id).toBe(start!.scope_id);
      } finally {
        if (app && !app.killed) app.kill("SIGKILL");
        if (pgContainer) {
          try {
            execSync(`docker stop ${pgContainer}`, { stdio: "pipe", timeout: 30_000 });
          } catch {
            /* already gone */
          }
        }
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 900_000);
  },
);
