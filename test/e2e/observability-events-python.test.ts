import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Observability events on the Python backend — end-to-end regression
// guard.  Sister to `observability-events.test.ts` (Hono) and the
// .NET / Phoenix / Java suites.  Generates the FastAPI backend from the
// python-build shell fixture, brings up postgres, boots uvicorn, then
// asserts the structured JSON lines appear on stdout with the catalog
// envelope (`ts` / `level` / `event` / `request_id` + per-event fields
// as flat snake_case keys — the same shape the Hono pino stream
// produces).
//
// Postgres comes from docker (postgres:18-alpine) by default; set
// LOOM_OBS_PG_URL=postgresql+asyncpg://user:pass@host:port/db to use a
// running instance instead (the local-dev path on docker-less
// machines).
//
// Opt-in via LOOM_OBS_E2E_PYTHON=1 — keeps `npm test` fast.  Requires
// `uv` on PATH (it provisions Python 3.13 itself).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_OBS_E2E_PYTHON === "1";
const PG_URL_OVERRIDE = process.env.LOOM_OBS_PG_URL;

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function hasUv(): boolean {
  try {
    execSync("uv --version", { stdio: "pipe", timeout: 5_000 });
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

interface LogLine {
  ts: string;
  level: string;
  event: string;
  request_id?: string;
  [k: string]: unknown;
}

/** Catalog lines only — every generated line is one flat JSON object;
 *  uvicorn's own plain-text lines parse-fail and drop out. */
function parseLines(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as LogLine;
      if (parsed.event && parsed.level) out.push(parsed);
    } catch {
      /* skip non-JSON */
    }
  }
  return out;
}

describe.skipIf(!ENABLED)(
  "generated Python backend emits the observability catalog on stdout (LOOM_OBS_E2E_PYTHON=1)",
  () => {
    it("boot + /health round-trip emits the catalog lifecycle + request bracket", async () => {
      // Loud prerequisite failures (not silent skips) so CI drift surfaces.
      if (!PG_URL_OVERRIDE && !hasDocker()) {
        throw new Error(
          "LOOM_OBS_E2E_PYTHON=1 set but docker is unreachable and no LOOM_OBS_PG_URL " +
            "override was given.  The suite needs postgres from one of the two.",
        );
      }
      if (!hasUv()) {
        throw new Error("LOOM_OBS_E2E_PYTHON=1 set but `uv` is not on PATH.");
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-py-"));
      const appPort = await freePort();
      const pgContainer = `loom-obs-pg-${Date.now()}`;
      let child: ReturnType<typeof spawn> | null = null;
      let startedContainer = false;
      try {
        // 1. Postgres — docker sidecar unless an URL override is given.
        let pgUrl = PG_URL_OVERRIDE;
        if (!pgUrl) {
          const pgPort = await freePort();
          execSync(
            `docker run -d --rm --name ${pgContainer} ` +
              `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app ` +
              `-p ${pgPort}:5432 postgres:18-alpine`,
            { stdio: "pipe", timeout: 60_000 },
          );
          startedContainer = true;
          const pgDeadline = Date.now() + 60_000;
          while (Date.now() < pgDeadline) {
            try {
              execSync(`docker exec ${pgContainer} pg_isready -U postgres`, {
                stdio: "pipe",
                timeout: 5_000,
              });
              break;
            } catch {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          pgUrl = `postgresql+asyncpg://postgres:postgres@127.0.0.1:${pgPort}/app`;
        }

        // 2. Generate + install the Python project.
        execSync(
          `node ${cli} generate system test/e2e/fixtures/python-build/shell.ddd -o ${outDir}`,
          { stdio: "pipe", cwd: repoRoot },
        );
        const proj = path.join(outDir, "api");
        execSync("uv sync", { cwd: proj, stdio: "pipe", timeout: 300_000 });

        // 3. Boot uvicorn DIRECTLY from the project venv — the `uv run`
        //    wrapper swallows SIGTERM, which would lose the graceful
        //    shutdown bracket.
        const python = path.join(proj, ".venv", "bin", "python");
        child = spawn(
          python,
          ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(appPort)],
          {
            cwd: proj,
            // LOG_LEVEL=debug surfaces the /health probe's debug-level
            // `health_ok` line (the backend defaults to `info`, which filters
            // it — same knob the node obs test sets); without it the
            // `health_ok` assertion below can never see the event.
            env: { ...process.env, DATABASE_URL: pgUrl, PORT: String(appPort), LOG_LEVEL: "debug" },
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
          },
        );

        let stdout = "";
        child.stdout!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        child.stderr!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });

        // 4. Wait for server_listening.
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 120_000;
          const tick = setInterval(() => {
            if (parseLines(stdout).some((l) => l.event === "server_listening")) {
              clearInterval(tick);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(tick);
              reject(
                new Error(
                  `server didn't reach server_listening; stdout:\n${stdout.slice(0, 8192)}`,
                ),
              );
            }
          }, 200);
        });

        // 5. Hit /health to produce a request bracket.
        const r = await fetch(`http://127.0.0.1:${appPort}/health`);
        expect(r.status).toBe(200);
        // x-request-id echoes on the response (correlation invariant).
        expect(r.headers.get("x-request-id")).toBeTruthy();

        // 5b. Prometheus scrape (M-T7.1): /metrics exposes the default
        // process/GC collectors + the HTTP counter/histogram recorded for
        // the /health request, labelled by the matched route TEMPLATE.
        const m = await fetch(`http://127.0.0.1:${appPort}/metrics`);
        expect(m.status).toBe(200);
        const metricsBody = await m.text();
        expect(metricsBody).toMatch(/process_cpu_seconds_total/);
        expect(metricsBody).toMatch(
          /http_requests_total\{method="GET",route="\/health",status="200"\}/,
        );
        expect(metricsBody).toMatch(/http_request_duration_seconds_bucket\{/);
        expect(metricsBody).toMatch(/http_request_duration_seconds_count\{/);

        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        // 6. SIGTERM uvicorn itself for the graceful-shutdown bracket.
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          if (child!.exitCode != null) resolve();
          else child!.on("exit", () => resolve());
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // 7. Assertions.
        const lines = parseLines(stdout);
        const eventList = lines.map((l) => l.event).join(", ");
        const ctx = `events: [${eventList}] | stdout (first 4kB): ${stdout.slice(0, 4096)}`;
        const eventsByName = new Map<string, LogLine[]>();
        for (const l of lines) {
          const list = eventsByName.get(l.event) ?? [];
          list.push(l);
          eventsByName.set(l.event, list);
        }

        // Envelope check — every catalog line carries ts/level/event.
        for (const l of lines) {
          expect(l.ts, ctx).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
          expect(["trace", "debug", "info", "warn", "error"], ctx).toContain(l.level);
        }

        // Lifecycle bracket — all four catalog events fire.
        expect(eventsByName.get("server_starting")?.[0]?.level, ctx).toBe("info");
        expect(eventsByName.get("server_listening")?.[0]?.level, ctx).toBe("info");
        expect(eventsByName.has("server_shutdown"), ctx).toBe(true);
        expect(eventsByName.has("server_drained"), ctx).toBe(true);

        // Request bracket + the health probe's debug line, all sharing
        // a request_id (the design's central correlation invariant).
        const start = eventsByName.get("request_start")?.[0];
        const ok = eventsByName.get("health_ok")?.[0];
        const end = eventsByName.get("request_end")?.[0];
        expect(start, ctx).toBeDefined();
        expect(ok, ctx).toBeDefined();
        expect(end, ctx).toBeDefined();
        expect(start!.request_id).toBeTruthy();
        expect(ok!.request_id).toBe(start!.request_id);
        expect(end!.request_id).toBe(start!.request_id);
        // scope_id rides every request-scoped line (the audit/provenance join
        // key), shared across the bracket — one root frame per request.
        expect(start!.scope_id).toBeTruthy();
        expect(ok!.scope_id).toBe(start!.scope_id);
        expect(end!.scope_id).toBe(start!.scope_id);
        expect(start!.method).toBe("GET");
        expect(start!.path).toBe("/health");
        expect(end!.status).toBe(200);
        expect(typeof end!.duration_ms).toBe("number");
        expect(ok!.level).toBe("debug"); // health_ok is the prod-quiet level
      } finally {
        try {
          if (child?.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        } catch {
          /* ignore */
        }
        if (startedContainer) {
          try {
            execSync(`docker rm -f ${pgContainer}`, { stdio: "pipe", timeout: 30_000 });
          } catch {
            /* ignore */
          }
        }
        try {
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }, 600_000);
  },
);
