import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Observability events — end-to-end regression guard.  Generates the
// emitted Hono backend from examples/sales.ddd, installs deps, boots
// the server against a no-op DATABASE_URL (the pool is lazy so /health
// never touches the DB), then asserts the structured pino lines we
// expect appear in stdout with the catalog envelope.  Sister suite to
// generated-build.test.ts — same shape, same heavy install cost, same
// opt-in gate.  See docs/old/proposals/observability.md.
//
// Slow (~60–90s with cached node_modules) and requires a free local
// port + outbound npm registry, so it stays opt-in via
// LOOM_OBS_E2E=1 — keeps `npm test` fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_OBS_E2E === "1";

/** Pick a port the OS just confirmed is free.  Race-window remains
 *  (port could be claimed between our close and the server's listen)
 *  but is small enough for this opt-in suite. */
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
  level: string;
  ts: string;
  event: string;
  request_id?: string;
  [k: string]: unknown;
}

/** Parse pino's JSON-per-line stdout into structured catalog entries.
 *  Drops non-JSON lines (e.g. tsx warm-up / Node deprecation notices). */
function parseLines(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as LogLine;
      if (parsed.event && parsed.level) out.push(parsed);
    } catch {
      /* skip — not a catalog line */
    }
  }
  return out;
}

describe.skipIf(!ENABLED)(
  "generated Hono backend emits the observability catalog on stdout (LOOM_OBS_E2E=1)",
  () => {
    it("boot + /health round-trip emits the expected catalog stream with correlated request_id", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-"));
      try {
        execSync(`node ${cli} generate ts examples/sales.ddd -o ${outDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        execSync(`npm install --silent --no-audit --no-fund`, {
          cwd: outDir,
          stdio: "pipe",
          timeout: 180_000,
        });

        const port = await freePort();
        // DATABASE_URL just has to pass the boot script's presence check;
        // pg.Pool is lazy so /health (no DB) never connects.  /ready
        // WOULD touch the DB and 503; we don't hit it here.
        // `detached: true` puts the child + any descendants tsx may
        // spawn into their own process group, so a single
        // `process.kill(-pid, "SIGTERM")` reaches the whole tree.  npx /
        // tsx are wrappers that don't reliably forward SIGTERM to the
        // wrapped node process otherwise — without this the catalog's
        // server_shutdown / server_drained lines never get a chance to
        // fire because only the wrapper dies.
        const child = spawn("npx", ["tsx", "index.ts"], {
          cwd: outDir,
          env: {
            ...process.env,
            DATABASE_URL: "postgres://nope:nope@127.0.0.1:1/nope",
            PORT: String(port),
            LOG_LEVEL: "debug", // pull in the /health probe's debug line
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        let stdout = "";
        child.stdout.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        child.stderr.on("data", (c: Buffer) => {
          stdout += c.toString("utf8"); // capture errors too
        });

        // Wait until the server announces it's listening (the catalog
        // event we know fires before any request can land), then curl.
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 30_000;
          const tick = setInterval(() => {
            if (parseLines(stdout).some((l) => l.event === "server_listening")) {
              clearInterval(tick);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(tick);
              reject(new Error(`server didn't announce server_listening; stdout:\n${stdout}`));
            }
          }, 100);
        });

        const r = await fetch(`http://127.0.0.1:${port}/health`);
        expect(r.status).toBe(200);

        // Give the request_end emission a moment to flush.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // Clean shutdown — signal the whole process group (negative PID)
        // so SIGTERM reaches the wrapped node process, not just the npx
        // wrapper.  Then wait briefly for the shutdown handler to flush
        // its server_shutdown / server_drained lines before reading stdout.
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          if (child.exitCode != null) resolve();
          else child.on("exit", () => resolve());
        });
        // One more tick to let the pipe drain any post-exit buffer.
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        const lines = parseLines(stdout);
        // Provide a usable failure dump when the catalog stream isn't
        // what we expect — without this every assertion mismatch becomes
        // a guessing game (the suite is opt-in + slow, so re-running
        // with `--reporter=verbose` isn't free).
        const eventList = lines.map((l) => l.event).join(", ");
        const ctx = `events: [${eventList}] | stdout (first 4kB): ${stdout.slice(0, 4096)}`;
        const eventsByName = new Map<string, LogLine[]>();
        for (const l of lines) {
          const list = eventsByName.get(l.event) ?? [];
          list.push(l);
          eventsByName.set(l.event, list);
        }

        // Envelope check — every catalog line carries ts/level/event +
        // a request_id when emitted inside a request scope.
        for (const l of lines) {
          expect(l.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(["trace", "debug", "info", "warn", "error"]).toContain(l.level);
        }

        // Lifecycle: server_starting → server_listening (info), then
        // server_shutdown → server_drained on SIGTERM (info).
        expect(eventsByName.get("server_starting")?.[0]?.level, ctx).toBe("info");
        expect(eventsByName.get("server_listening")?.[0]?.level, ctx).toBe("info");
        expect(eventsByName.get("server_shutdown")?.[0]?.signal, ctx).toBe("SIGTERM");
        expect(eventsByName.has("server_drained"), ctx).toBe(true);

        // Request bracket + the health probe's debug line, all sharing a
        // request_id (the design's central correlation invariant).
        const start = eventsByName.get("request_start")?.[0];
        const ok = eventsByName.get("health_ok")?.[0];
        const end = eventsByName.get("request_end")?.[0];
        expect(start).toBeDefined();
        expect(ok).toBeDefined();
        expect(end).toBeDefined();
        expect(start!.request_id).toBeTruthy();
        expect(ok!.request_id).toBe(start!.request_id);
        expect(end!.request_id).toBe(start!.request_id);
        // scope_id rides every request-scoped line (the audit/provenance join
        // key) and is shared across the bracket — one root frame per request.
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
          fs.rmSync(outDir, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }, 240_000);
  },
);
