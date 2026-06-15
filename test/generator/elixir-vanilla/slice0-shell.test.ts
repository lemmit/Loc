import { describe, expect, it } from "vitest";
import { generateVanillaElixirProject } from "../../../src/generator/elixir/vanilla/index.js";
import type { DeployableIR, SystemIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// Slice 0 of docs/plans/vanilla-foundation-tdd-plan.md — orchestrator
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
});
