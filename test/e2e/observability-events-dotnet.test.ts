import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Observability events on the .NET backend — end-to-end regression guard.
//
// Sister to `observability-events.test.ts` (the Hono suite).  Generates
// the .NET backend from examples/sales.ddd, brings up a throwaway
// postgres container, runs `dotnet run`, then asserts the structured
// JSON lines we expect appear in stdout with the catalog envelope.
//
// Slow (~3-5 min cold; ~30s warm with NuGet cache) and requires:
//   - docker (for the postgres sidecar)
//   - dotnet SDK 10.0+ on PATH
//
// Stays opt-in via LOOM_OBS_E2E_DOTNET=1 — keeps `npm test` fast.  The
// inner availability checks (docker daemon + dotnet binary) skip the
// suite cleanly when prerequisites are missing, so a misconfigured CI
// surfaces as a SKIP, not a noisy fail.
//
// ASP.NET's AddJsonConsole writes one JSON object per log line:
//   {"EventId":0,"LogLevel":"Information","Category":"...",
//    "Message":"request_start method=GET path=/health",
//    "State":{"Message":"...","Event":"request_start","Method":"GET","Path":"/health"}}
// The catalog event identity lives under `State.Event`; structured
// fields are individual `State.<Pascal>` keys.  See `render-dotnet.ts`
// for the placeholder convention.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_OBS_E2E_DOTNET === "1";

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function hasDotnet(): boolean {
  try {
    execSync("dotnet --version", { stdio: "pipe", timeout: 5_000 });
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

interface DotnetLogLine {
  EventId?: number;
  LogLevel?: string;
  Category?: string;
  Message?: string;
  State?: Record<string, unknown> & { Event?: string };
  [k: string]: unknown;
}

/** Filter AddJsonConsole output to lines whose State.Event is set —
 *  i.e. the catalog identity lines.  Drops framework noise (e.g. the
 *  Hosting.Lifetime "Now listening on:" line which has no Event key). */
function parseCatalogLines(raw: string): DotnetLogLine[] {
  const out: DotnetLogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as DotnetLogLine;
      if (parsed.State?.Event) out.push(parsed);
    } catch {
      /* skip non-JSON */
    }
  }
  return out;
}

/** Extract the carrier `scopeId` from a line's AddJsonConsole `Scopes` array
 *  (emitted because `IncludeScopes = true`).  The boundary RequestContext
 *  middleware opens `BeginScope({ correlationId, scopeId })`, so every line
 *  inside the request carries a scope entry with `scopeId` — the join key to
 *  the audit / provenance rows of the same frame.  Undefined when absent. */
function scopeIdOf(l: DotnetLogLine): string | undefined {
  const scopes = (l.Scopes as Array<Record<string, unknown>> | undefined) ?? [];
  for (const s of scopes) {
    const v = s.scopeId;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

describe.skipIf(!ENABLED)(
  "generated .NET backend emits the observability catalog on stdout (LOOM_OBS_E2E_DOTNET=1)",
  () => {
    it("boot + /health round-trip emits the catalog lifecycle + request bracket", async () => {
      // Prerequisite check INSIDE the test (not in skipIf) so that
      // LOOM_OBS_E2E_DOTNET=1 with missing docker / dotnet fails
      // loudly rather than passing silently — silent-skip would hide
      // CI environment drift.
      if (!hasDocker()) {
        throw new Error(
          "LOOM_OBS_E2E_DOTNET=1 set but docker daemon is unreachable. " +
            "The suite needs docker for the postgres sidecar. " +
            "Check the runner has docker enabled (GitHub-hosted ubuntu runners do by default).",
        );
      }
      if (!hasDotnet()) {
        throw new Error(
          "LOOM_OBS_E2E_DOTNET=1 set but `dotnet` is not on PATH. " +
            "The suite needs the .NET SDK 8+. " +
            "Add `actions/setup-dotnet@v4` with `dotnet-version: '10.0.x'` to the workflow.",
        );
      }
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-dn-"));
      const pgPort = await freePort();
      const appPort = await freePort();
      const pgContainer = `loom-obs-pg-${Date.now()}`;
      let dotnetChild: ReturnType<typeof spawn> | null = null;
      try {
        // 1. Postgres sidecar — throwaway container with a known port.
        //    The `--rm` keeps cleanup tidy; we still explicitly `docker
        //    rm` in the finally as belt-and-braces.
        execSync(
          `docker run -d --rm --name ${pgContainer} ` +
            `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app ` +
            `-p ${pgPort}:5432 postgres:18-alpine`,
          { stdio: "pipe", timeout: 60_000 },
        );

        // 2. Wait for postgres ready.  pg_isready exits non-zero until
        //    the socket accepts; loop with a short sleep.
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

        // 3. Generate the .NET project.
        execSync(`node ${cli} generate dotnet examples/sales.ddd -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });

        // 4. dotnet restore + build is implicit on `run`, but doing it
        //    explicitly upfront keeps the run-step output limited to
        //    catalog lines.
        execSync(`dotnet restore`, {
          cwd: outDir,
          stdio: "pipe",
          timeout: 300_000,
        });

        // 5. Boot the server.
        dotnetChild = spawn("dotnet", ["run", "--no-restore", "--no-launch-profile"], {
          cwd: outDir,
          env: {
            ...process.env,
            PORT: String(appPort),
            ASPNETCORE_URLS: `http://127.0.0.1:${appPort}`,
            ConnectionStrings__Default: `Host=127.0.0.1;Port=${pgPort};Database=app;Username=postgres;Password=postgres`,
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        let stdout = "";
        dotnetChild.stdout!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        dotnetChild.stderr!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });

        // 6. Wait for server_listening.
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 120_000;
          const tick = setInterval(() => {
            if (parseCatalogLines(stdout).some((l) => l.State?.Event === "server_listening")) {
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

        // 7. Hit /health to produce a request bracket.
        const r = await fetch(`http://127.0.0.1:${appPort}/health`);
        expect(r.status).toBe(200);

        // 7b. Prometheus scrape (M-T7.1): /metrics (prometheus-net MapMetrics)
        // exposes the default .NET/process metrics + the HTTP counter/histogram
        // recorded for the /health request, labelled by the matched route
        // TEMPLATE.
        const m = await fetch(`http://127.0.0.1:${appPort}/metrics`);
        expect(m.status).toBe(200);
        const metricsBody = await m.text();
        expect(metricsBody).toMatch(/process_cpu_seconds_total/);
        expect(metricsBody).toMatch(
          /http_requests_total\{method="GET",route="\/health",status="200"\}/,
        );
        expect(metricsBody).toMatch(/http_request_duration_seconds_bucket\{/);
        expect(metricsBody).toMatch(/http_request_duration_seconds_count\{/);

        // Flush window.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        // 8. SIGTERM the whole process group so dotnet's host gets the
        //    signal (not just the wrapper), then wait for shutdown.
        try {
          process.kill(-dotnetChild.pid!, "SIGTERM");
        } catch {
          dotnetChild.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          if (dotnetChild!.exitCode != null) resolve();
          else dotnetChild!.on("exit", () => resolve());
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // 9. Assertions.
        const lines = parseCatalogLines(stdout);
        const eventList = lines.map((l) => l.State?.Event).join(", ");
        const ctx = `events: [${eventList}] | stdout (first 4kB): ${stdout.slice(0, 4096)}`;
        const eventsByName = new Map<string, DotnetLogLine[]>();
        for (const l of lines) {
          const ev = l.State?.Event;
          if (!ev) continue;
          const list = eventsByName.get(ev) ?? [];
          list.push(l);
          eventsByName.set(ev, list);
        }

        // Lifecycle bracket — all four catalog events fire.
        expect(eventsByName.has("server_starting"), ctx).toBe(true);
        expect(eventsByName.has("server_listening"), ctx).toBe(true);
        expect(eventsByName.has("server_shutdown"), ctx).toBe(true);
        expect(eventsByName.has("server_drained"), ctx).toBe(true);

        // Request bracket carries the structured fields.
        const start = eventsByName.get("request_start")?.[0];
        const end = eventsByName.get("request_end")?.[0];
        expect(start, ctx).toBeDefined();
        expect(end, ctx).toBeDefined();
        expect(start!.State?.Method).toBe("GET");
        expect(start!.State?.Path).toBe("/health");
        expect(end!.State?.Status).toBe(200);
        // Duration_ms is rendered as DurationMs by snakeToPascal.
        expect(typeof end!.State?.DurationMs).toBe("number");
        // scope_id rides the `Scopes` array (IncludeScopes) on every
        // request-bracket line — the audit/provenance join key, shared across
        // the bracket (one root frame per request). The .NET analogue of the
        // flat-envelope backends' top-level scope_id.
        const startScope = scopeIdOf(start!);
        expect(startScope, ctx).toBeTruthy();
        expect(scopeIdOf(end!), ctx).toBe(startScope);
      } finally {
        // Best-effort teardown.
        try {
          if (dotnetChild?.pid) {
            try {
              process.kill(-dotnetChild.pid, "SIGKILL");
            } catch {
              dotnetChild.kill("SIGKILL");
            }
          }
        } catch {
          /* ignore */
        }
        try {
          execSync(`docker rm -f ${pgContainer}`, { stdio: "pipe", timeout: 30_000 });
        } catch {
          /* ignore */
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
