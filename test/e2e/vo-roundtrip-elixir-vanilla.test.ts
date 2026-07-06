import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Value-object wire round-trip on the vanilla Phoenix backend — the runtime
// regression gate for issue #1660 (fixed in #1664).
//
// A value object persists as an untyped jsonb `:map`.  When Ecto loads that
// row back the map is STRING-keyed (`%{"amount" => 5}`), but the emitted wire
// serializer (`serialize_<vo>/1`) used to read subfields via struct-dot
// (`record.amount`), which `KeyError`s on a string-keyed map.  So serialising
// ANY DB-loaded VO-bearing aggregate to the wire crashed at runtime
// (`GET /<agg>/:id` → 500).  The fix reads subfields key-type-agnostically:
//   Map.get(record, :amount, Map.get(record, "amount"))
//
// This was CI-invisible because NO other elixir boot fixture uses a value
// object — `mix compile` is blind to it (the code compiles; it only crashes
// when a VO row is loaded and serialised).  This test closes that gap: it
// boots the generated backend against a real postgres, POSTs a VO-bearing
// aggregate, then GETs it back and asserts the VO subfields survive
// serialisation (no 500).  Reverting the #1664 fallback turns this red.
//
// Sibling of `observability-events-elixir-vanilla.test.ts`; same boot
// harness, plus `ecto.migrate` (the VO row needs its table) and the HTTP
// round-trip instead of the /health obs assertion.
//
// Slow (~5-8 min cold; ~60s warm with hex cache + _build) and requires:
//   - docker (postgres sidecar) OR an externally-supplied LOOM_OBS_PG_URL
//   - elixir + mix on PATH (host Elixir; mix deps.get caches into the temp dir)
//   - network access to hex.pm + repo.hex.pm (mix deps.get)
//
// Opt-in via LOOM_VO_E2E_PHOENIX_VANILLA=1 — keeps `npm test` fast.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_VO_E2E_PHOENIX_VANILLA === "1";

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

/** True once any JSON-per-line stdout line carries `event: "server_listening"`. */
function isListening(raw: string): boolean {
  for (const line of raw.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { event?: string };
      if (parsed.event === "server_listening") return true;
    } catch {
      /* skip */
    }
  }
  return false;
}

// A vanilla Phoenix fixture whose aggregate embeds a value object (`Money`)
// as a SINGLE field — the exact #1660 shape: a single VO field persists as a
// jsonb `:map` column and reloads STRING-keyed, which is what crashed the
// struct-dot serializer.  (A VO *collection* takes a different path on
// vanilla — a relational child table, atom-keyed structs, preload-dependent —
// so it belongs in its own gate, not entangled with this jsonb regression.)
// `crudish` gives the create/show routes the round-trip drives.
const FIXTURE_DDD = `system VoRoundTrip {
  subdomain Sales {
    context Sales {
      valueobject Money { amount: int  currency: string }
      aggregate Invoice with crudish {
        ref: string
        total: Money
      }
      repository Invoices for Invoice { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 4000
  }
}
`;

describe.skipIf(!ENABLED)(
  "generated vanilla Phoenix backend round-trips a value object through the wire (LOOM_VO_E2E_PHOENIX_VANILLA=1)",
  () => {
    it("POST a VO-bearing aggregate then GET it back — VO subfields survive serialisation (#1660)", async () => {
      // Prerequisite checks INSIDE the test (not in skipIf) so an enabled
      // run with missing docker / mix fails loudly rather than passing
      // silently.  Docker is only required when no external postgres URL
      // is supplied.
      if (!process.env.LOOM_OBS_PG_URL && !hasDocker()) {
        throw new Error(
          "LOOM_VO_E2E_PHOENIX_VANILLA=1 set but no LOOM_OBS_PG_URL was provided and " +
            "the docker daemon is unreachable. " +
            "Either supply LOOM_OBS_PG_URL=postgres://… (CI service container) " +
            "or ensure docker is available for the local postgres sidecar.",
        );
      }
      if (!hasElixir()) {
        throw new Error(
          "LOOM_VO_E2E_PHOENIX_VANILLA=1 set but `mix` is not on PATH. " +
            "The suite needs Erlang/OTP + Elixir. " +
            "Add `erlef/setup-beam@v1` with `otp-version: '27.3'` and `elixir-version: '1.18.4'` to the workflow.",
        );
      }

      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-vo-pxv-"));
      const dddPath = path.join(outDir, "phx-vanilla-vo.ddd");
      fs.writeFileSync(dddPath, FIXTURE_DDD);

      // Postgres source: either a workflow-supplied service container
      // (set LOOM_OBS_PG_URL and LOOM_OBS_PG_DB) or a throwaway docker
      // container spun up here.
      const externalPgUrl = process.env.LOOM_OBS_PG_URL;
      const externalPgDb = process.env.LOOM_OBS_PG_DB ?? "api";
      const useExternalPg = !!externalPgUrl;
      const pgPort = useExternalPg
        ? Number(new URL(externalPgUrl).port || "5432")
        : await freePort();
      const appPort = await freePort();
      const pgContainer = `loom-vo-pxv-pg-${Date.now()}`;
      let mixChild: ReturnType<typeof spawn> | null = null;
      try {
        // 1. Postgres sidecar (only when no external one supplied).
        if (!useExternalPg) {
          execSync(
            `docker run -d --rm --name ${pgContainer} ` +
              `-e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=${externalPgDb} ` +
              `-p ${pgPort}:5432 postgres:18-alpine`,
            { stdio: "pipe", timeout: 60_000 },
          );
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
        }

        // 2. Generate the vanilla Phoenix project.  Vanilla projects
        //    emit to `<deployable>/`, not `phoenix_app/`.
        execSync(`node ${cli} generate system ${dddPath} -o ${outDir}/out`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
        const projDir = path.join(outDir, "out", "api");
        expect(fs.existsSync(path.join(projDir, "mix.exs"))).toBe(true);

        // 3. Fetch deps + compile.
        execSync("mix local.hex --force && mix local.rebar --force && mix deps.get", {
          cwd: projDir,
          stdio: "pipe",
          timeout: 300_000,
          shell: "/bin/bash",
        });

        // 4. Create the DB and run migrations — the VO row needs its table
        //    (unlike the obs test, which only hits /health and can skip
        //    migrate).  The migration adds `total :map` (jsonb), the column
        //    that reloads STRING-keyed and used to crash the serializer.
        const dbUrl = `ecto://postgres:postgres@127.0.0.1:${pgPort}/${externalPgDb}`;
        execSync("mix ecto.create && mix ecto.migrate", {
          cwd: projDir,
          stdio: "pipe",
          env: { ...process.env, DATABASE_URL: dbUrl, MIX_ENV: "dev" },
          timeout: 300_000,
          shell: "/bin/bash",
        });

        // 5. Boot the server.
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
            if (isListening(stdout)) {
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

        const base = `http://127.0.0.1:${appPort}/api`;

        // 7. POST a VO-bearing aggregate.  `total` is a single VO, stored as
        //    a jsonb `:map` and reloaded string-keyed on the GET below.
        const createBody = {
          ref: "INV-1",
          total: { amount: 4200, currency: "USD" },
        };
        const createRes = await fetch(`${base}/invoices`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(createBody),
        });
        const createText = await createRes.text();
        expect(
          createRes.status,
          `create should 201; got ${createRes.status}: ${createText.slice(0, 1024)}`,
        ).toBe(201);
        const created = JSON.parse(createText) as {
          id: string;
          total: { amount: number; currency: string } | null;
        };
        expect(created.id, `create response missing id: ${createText}`).toBeTruthy();

        // 8. GET it back — this is the reload-from-jsonb path that used to
        //    500.  The row's `total` is now a STRING-keyed map; the wire
        //    serializer must still produce the VO subfields.
        const showRes = await fetch(`${base}/invoices/${created.id}`);
        const showText = await showRes.text();
        expect(
          showRes.status,
          `show should 200 (a 500 here is the #1660 KeyError regression); got ${showRes.status}: ${showText.slice(0, 1024)}`,
        ).toBe(200);
        const shown = JSON.parse(showText) as {
          ref: string;
          total: { amount: number; currency: string } | null;
        };

        // 9. The VO subfields survived serialisation of a DB-loaded row.
        expect(shown.ref).toBe("INV-1");
        expect(shown.total, `total dropped on reload: ${showText}`).toBeTruthy();
        expect(shown.total!.amount).toBe(4200);
        expect(shown.total!.currency).toBe("USD");

        // 10. SIGTERM the whole process group.
        try {
          process.kill(-mixChild.pid!, "SIGTERM");
        } catch {
          mixChild.kill("SIGTERM");
        }
        await new Promise<void>((resolve) => {
          if (mixChild!.exitCode != null) resolve();
          else mixChild!.on("exit", () => resolve());
        });
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
          if (!useExternalPg) {
            execSync(`docker rm -f ${pgContainer}`, { stdio: "pipe", timeout: 30_000 });
          }
        } catch {
          /* ignore */
        }
      }
    }, 900_000);
  },
);
