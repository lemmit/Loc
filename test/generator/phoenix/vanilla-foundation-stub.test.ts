import { describe, expect, it } from "vitest";
import { generateElixirProject } from "../../../src/generator/elixir/index.js";
import type { DeployableIR, SystemIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// P2 of proposals/vanilla-phoenix-foundation.md — the orchestrator routes a
// `foundation: vanilla` elixir deployable to the `vanilla/` emit subtree
// (plain Ecto/Phoenix, no Ash), slice by slice (vanilla-foundation-tdd-plan.md).
//
// The user-facing validator gate (R5,
// `loom.foundation-vanilla-phoenix-not-yet-implemented`) is still up, so in
// normal use the orchestrator only reaches this path via tests / direct
// programmatic callers. This test pins that the vanilla branch emits the
// vanilla project (the shared `<App>.Types` module + per-aggregate Ecto
// schemas) and never the Ash project.
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
    name: "S",
    subdomains: [],
    deployables: [vanillaDeployable()],
    storages: [],
    resources: [],
  } as SystemIR;
}

describe("elixir orchestrator — foundation: vanilla emit", () => {
  it("emits the vanilla project (shared Types module), never the Ash project", () => {
    const out = generateElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    // With no contexts the only file is the shared `<App>.Types` module.
    expect(out.has("lib/api/types.ex")).toBe(true);
    expect(out.get("lib/api/types.ex")).toContain("defmodule Api.Types do");
    // No Ash anywhere in the vanilla emit.
    for (const content of out.values()) {
      expect(content).not.toContain("use Ash.Resource");
      expect(content).not.toContain("use Ash.Domain");
    }
  });

  it("does NOT crash with empty contexts when foundation: vanilla is set", () => {
    const out = generateElixirProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    expect(out).toBeInstanceOf(Map);
  });
});
