import { describe, expect, it } from "vitest";
import { generateVanillaElixirProject } from "../../../src/generator/elixir/vanilla/index.js";
import type { DeployableIR, SystemIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Slice 0 of docs/old/plans/vanilla-foundation-tdd-plan.md — orchestrator
// branch + minimal shell.
//
// Verifies that `foundation: vanilla` on `platform: elixir` dispatches
// to the vanilla orchestrator and emits a Phoenix + Ecto skeleton with
// NO Ash deps.  Per-emitter content checks land in later slices; this
// slice pins the shell shape only.
// ---------------------------------------------------------------------------

function vanillaDeployable(): DeployableIR {
  return {
    name: "api",
    platform: "elixir",
    platformRef: "elixir@v1",
    contextNames: [],
    foundation: "vanilla",
    port: 4000,
  } as DeployableIR;
}

function emptySystem(): SystemIR {
  return {
    name: "Tasks",
    subdomains: [],
    deployables: [vanillaDeployable()],
    storages: [],
    resources: [],
  } as SystemIR;
}

describe("vanilla orchestrator — Slice 0 shell skeleton", () => {
  it("emits a non-empty file map (lifts the empty-Map stub from P1)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    expect(out.size).toBeGreaterThan(0);
  });

  it("emits the core Phoenix + Ecto shell files", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const paths = [...out.keys()];
    expect(paths).toContain("mix.exs");
    expect(paths).toContain(".formatter.exs");
    expect(paths).toContain("lib/api/application.ex");
    expect(paths).toContain("lib/api/repo.ex");
    expect(paths).toContain("lib/api_web.ex");
    expect(paths).toContain("lib/api_web/endpoint.ex");
    expect(paths).toContain("lib/api_web/router.ex");
    expect(paths).toContain("config/config.exs");
    expect(paths).toContain("config/dev.exs");
    expect(paths).toContain("config/prod.exs");
    expect(paths).toContain("config/runtime.exs");
    expect(paths).toContain("config/test.exs");
  });

  it("dev.exs honors PORT + DATABASE_URL env (so e2e harnesses can boot on a chosen port/db)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const dev = out.get("config/dev.exs")!;
    // Endpoint port must come from PORT (not a hardcoded 4000) — the obs
    // e2e harness boots with PORT=<free port> and fetches it.
    expect(dev).toContain('System.get_env("PORT")');
    expect(dev).not.toMatch(/port:\s*4000\b/);
    // Repo must follow DATABASE_URL when provided (the harness points the
    // app at a provisioned db on a non-default port).
    expect(dev).toContain('System.get_env("DATABASE_URL")');
  });

  it("mix.exs has NO Ash deps (the vanilla contract)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const mix = out.get("mix.exs")!;
    expect(mix).not.toContain(":ash");
    expect(mix).not.toContain("ash_postgres");
    expect(mix).not.toContain("ash_phoenix");
    expect(mix).not.toContain("ash.codegen");
    expect(mix).not.toContain("ash.migrate");
    // Plain Phoenix + Ecto baseline:
    expect(mix).toContain(":phoenix,");
    expect(mix).toContain(":ecto_sql,");
    expect(mix).toContain(":postgrex,");
  });

  it("repo.ex uses plain Ecto.Repo (NOT AshPostgres.Repo)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const repo = out.get("lib/api/repo.ex")!;
    expect(repo).toContain("use Ecto.Repo");
    expect(repo).toContain("adapter: Ecto.Adapters.Postgres");
    expect(repo).not.toContain("AshPostgres.Repo");
    expect(repo).not.toContain("installed_extensions");
  });

  it("application.ex supervises Repo, PubSub, Telemetry, Endpoint", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const app = out.get("lib/api/application.ex")!;
    expect(app).toContain("Api.Repo");
    expect(app).toContain("Phoenix.PubSub");
    // Telemetry lives at lib/<app>/telemetry.ex (matching the Ash convention)
    // so the shared `renderApplication` works for both foundations.
    expect(app).toContain("Api.Telemetry");
    expect(app).toContain("ApiWeb.Endpoint");
  });

  it("router.ex has a /health endpoint + /api scope (no Ash routes yet)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const router = out.get("lib/api_web/router.ex")!;
    expect(router).toContain('scope "/health"');
    expect(router).toContain('scope "/api"');
    expect(router).not.toContain("Ash");
  });

  it("serves both /health (liveness) and a DB-aware /ready (readiness)", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    // Router wires liveness → /health and readiness → /ready (the k8s chart
    // probes /health for liveness, /ready for readiness — without /ready the
    // pod never goes Ready and `helm --wait` hangs).
    const router = out.get("lib/api_web/router.ex")!;
    expect(router).toContain('scope "/ready"');
    expect(router).toContain("HealthController, :liveness");
    expect(router).toContain("HealthController, :readiness");
    // Readiness pings the DB through Ecto and 503s when it is unreachable.
    const health = out.get("lib/api_web/controllers/health_controller.ex")!;
    expect(health).toContain("def liveness(");
    expect(health).toContain("def readiness(");
    expect(health).toContain("Ecto.Adapters.SQL.query!(Api.Repo");
    expect(health).toContain(":service_unavailable");
    // The old single-action shape is gone.
    expect(health).not.toContain("def show(");
  });

  it("emits the release + Dockerfile so the foundation is k8s-deployable", () => {
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    // Container image + release packaging (mirrors the Ash foundation).
    expect(out.has("Dockerfile")).toBe(true);
    expect(out.has(".dockerignore")).toBe(true);
    expect(out.has("certs/.gitkeep")).toBe(true);
    expect(out.has("rel/env.sh.eex")).toBe(true);
    expect(out.has("lib/api/release.ex")).toBe(true);
    // bin/server migrates before booting (fresh per-backend DB has no schema).
    const server = out.get("rel/overlays/bin/server")!;
    expect(server).toContain("Api.Release.migrate()");
    expect(server).toContain("./bin/api");
    expect(out.get("lib/api/release.ex")!).toContain("Ecto.Migrator");
    // prod.exs starts the endpoint server (a release doesn't run mix phx.server).
    expect(out.get("config/prod.exs")!).toContain("server: true");
  });

  it("release.ex emits the migration-lifecycle catalog events on boot migrate", () => {
    // Parity with Hono/.NET/Java/Python (observability.md): the Ecto release
    // migrate task was silent — a fresh vanilla-Phoenix DB boot produced no
    // migration log lines. It now emits the same catalog events at the same
    // levels + field names so a cross-backend log consumer pivots on one
    // identity. (Shared with Ash's release task — same Ecto.Migrator seam.)
    const out = generateVanillaElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    const release = out.get("lib/api/release.ex")!;
    expect(release).toContain("require Logger");
    expect(release).toContain(
      'Logger.info("migrations_starting", event: "migrations_starting", count: pending)',
    );
    expect(release).toContain(
      'Logger.info("migration_applied", event: "migration_applied", id: version, name: Map.get(names, version))',
    );
    expect(release).toContain(
      'Logger.info("migrations_complete", event: "migrations_complete", applied: length(applied))',
    );
    expect(release).toContain(
      'Logger.error("migration_failed", event: "migration_failed", error: Exception.message(error))',
    );
    // The failure path re-raises so a bad migration still aborts the boot.
    expect(release).toContain("reraise error, __STACKTRACE__");
  });
});
