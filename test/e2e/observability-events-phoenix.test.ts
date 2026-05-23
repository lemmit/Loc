import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Observability events on the Phoenix backend — end-to-end regression
// guard.  Sister to `observability-events.test.ts` (Hono) and
// `observability-events-dotnet.test.ts`.  Generates the Phoenix project
// from a minimal fixture, brings up a throwaway postgres container,
// `mix deps.get && mix phx.server`, hits /health, SIGTERMs, then asserts
// the JSON-per-line stream from the custom <App>.LogFormatter carries the
// catalog envelope.
//
// Slow (~5-8 min cold; ~60s warm with hex cache + _build) and requires:
//   - docker (postgres sidecar)
//   - elixir + mix on PATH (uses host Elixir, not the docker image, so
//     that mix deps.get caches into the temp dir across runs)
//   - network access to hex.pm + repo.hex.pm (mix deps.get)
//
// Stays opt-in via LOOM_OBS_E2E_PHOENIX=1 — keeps `npm test` fast.
// Skips when docker / elixir aren't available so a misconfigured CI
// surfaces as SKIP, not a noisy fail.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_OBS_E2E_PHOENIX === "1";

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function hasElixir(): boolean {
  try {
    execSync("mix --version", { stdio: "pipe", timeout: 5_000 });
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

interface PhoenixLogLine {
  ts?: string;
  level?: string;
  event?: string;
  message?: string;
  [k: string]: unknown;
}

/** Parse the JSON-per-line output emitted by the rendered
 *  `<App>.LogFormatter`.  Drops any non-JSON noise (mix progress
 *  spinners, deprecation notices, Erlang VM banner). */
function parseLines(raw: string): PhoenixLogLine[] {
  const out: PhoenixLogLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as PhoenixLogLine;
      if (parsed.event) out.push(parsed);
    } catch {
      /* skip */
    }
  }
  return out;
}

// Minimal Phoenix fixture — just enough to compile and boot.
const FIXTURE_DDD = `system PhxObs {
  module Sales {
    context Sales {
      aggregate Customer {
        name: string display
        email: string
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin { scaffold modules: Sales }
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: Sales
    serves: SalesApi
    ui: SalesAdmin
    port: 4000
  }
}
`;

describe.skipIf(!ENABLED || !hasDocker() || !hasElixir())(
  "generated Phoenix backend emits the observability catalog on stdout (LOOM_OBS_E2E_PHOENIX=1)",
  () => {
    it("boot + /health round-trip emits the catalog lifecycle + request bracket", async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-obs-px-"));
      const dddPath = path.join(outDir, "phx-obs.ddd");
      fs.writeFileSync(dddPath, FIXTURE_DDD);
      const pgPort = await freePort();
      const appPort = await freePort();
      const pgContainer = `loom-obs-px-pg-${Date.now()}`;
      let mixChild: ReturnType<typeof spawn> | null = null;
      try {
        // 1. Postgres sidecar.
        execSync(
          `docker run -d --rm --name ${pgContainer} ` +
            `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=phoenix_app ` +
            `-p ${pgPort}:5432 postgres:16-alpine`,
          { stdio: "pipe", timeout: 60_000 },
        );
        // Wait pg ready.
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

        // 2. Generate the Phoenix project.
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}/out`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const projDir = path.join(outDir, "out", "phoenix_app");
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // 3. Fetch deps + compile.  --warnings-as-errors here would
        //    catch generator drift, but a single test shouldn't fight
        //    both surfaces; let mix compile defaults apply.
        execSync(`mix local.hex --force && mix local.rebar --force && mix deps.get`, {
          cwd: projDir,
          stdio: "pipe",
          timeout: 300_000,
          shell: "/bin/bash",
        });

        // 4. Set up the DB schema (Ash codegen + migrate against the
        //    postgres sidecar).
        const dbUrl = `ecto://postgres:postgres@127.0.0.1:${pgPort}/phoenix_app`;
        execSync(`mix ash.setup --quiet`, {
          cwd: projDir,
          stdio: "pipe",
          env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
          timeout: 300_000,
          shell: "/bin/bash",
        });

        // 5. Boot the server.  `mix phx.server` in dev mode honors
        //    PHX_SERVER + PORT.  `detached: true` puts mix + the BEAM
        //    into their own process group so SIGTERM reaches the
        //    Erlang VM, not just the mix wrapper.
        mixChild = spawn("mix", ["phx.server"], {
          cwd: projDir,
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            PHX_SERVER: "true",
            PORT: String(appPort),
            MIX_ENV: "dev",
          },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

        let stdout = "";
        mixChild.stdout!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        mixChild.stderr!.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });

        // 6. Wait for server_listening.
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

        // 7. /health round-trip.
        const r = await fetch(`http://127.0.0.1:${appPort}/health`);
        expect(r.status).toBe(200);
        await new Promise<void>((resolve) => setTimeout(resolve, 300));

        // 8. SIGTERM the whole process group.
        try {
          process.kill(-mixChild.pid!, "SIGTERM");
        } catch {
          mixChild.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          if (mixChild!.exitCode != null) resolve();
          else mixChild!.on("exit", () => resolve());
        });
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        // 9. Assertions.
        const lines = parseLines(stdout);
        const eventList = lines.map((l) => l.event).join(", ");
        const ctx = `events: [${eventList}] | stdout (first 4kB): ${stdout.slice(0, 4096)}`;
        const eventsByName = new Map<string, PhoenixLogLine[]>();
        for (const l of lines) {
          if (!l.event) continue;
          const list = eventsByName.get(l.event) ?? [];
          list.push(l);
          eventsByName.set(l.event, list);
        }

        // Envelope — every JSON line has ts / level / event.
        for (const l of lines) {
          expect(l.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          expect(["debug", "info", "warning", "error", "notice"]).toContain(l.level);
        }

        // Lifecycle bracket — all four catalog events.
        expect(eventsByName.has("server_starting"), ctx).toBe(true);
        expect(eventsByName.has("server_listening"), ctx).toBe(true);
        expect(eventsByName.has("server_shutdown"), ctx).toBe(true);
        expect(eventsByName.has("server_drained"), ctx).toBe(true);

        // Request bracket — :telemetry handlers from
        // <App>.Telemetry (Bite 1) translate phoenix endpoint events
        // to request_start / request_end.
        const start = eventsByName.get("request_start")?.[0];
        const end = eventsByName.get("request_end")?.[0];
        expect(start, ctx).toBeDefined();
        expect(end, ctx).toBeDefined();
        expect(start!.method).toBe("GET");
        expect(start!.path).toBe("/health");
        expect(end!.status).toBe(200);
        expect(typeof end!.duration_ms).toBe("number");
      } finally {
        try {
          if (mixChild?.pid) {
            try {
              process.kill(-mixChild.pid, "SIGKILL");
            } catch {
              mixChild.kill("SIGKILL");
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
    }, 900_000);
  },
);
