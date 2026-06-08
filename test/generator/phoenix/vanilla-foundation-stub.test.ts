import { describe, expect, it } from "vitest";
import { generatePhoenixLiveViewProject } from "../../../src/generator/phoenix-live-view/index.js";
import type { DeployableIR, SystemIR } from "../../../src/ir/types/loom-ir.js";

// ---------------------------------------------------------------------------
// P1 of proposals/vanilla-phoenix-foundation.md — defence-in-depth.
//
// The validator's R5 (`loom.foundation-vanilla-phoenix-not-yet-implemented`)
// rejects `foundation: vanilla` on `platform: phoenix` before lowering, so
// in normal use the orchestrator never sees a vanilla deployable. But the
// orchestrator may also be invoked by snapshot-driven regenerate paths and
// by direct programmatic callers that bypass validation; in those cases
// silently emitting the Ash project would lose the user's foundation
// choice. The orchestrator branches on `deployable.foundation` and returns
// an empty Map for `vanilla`, until the vanilla emit subtree lands in P2.
//
// This test pins that contract: foundation: vanilla → no files emitted.
// When P2 lands, replace the empty-Map expectation with the real vanilla
// emit set.
// ---------------------------------------------------------------------------

function vanillaDeployable(): DeployableIR {
  return {
    name: "api",
    platform: "phoenix",
    platformRef: "phoenix@v1",
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

describe("phoenix orchestrator — foundation: vanilla stub", () => {
  it("emits zero files for a phoenix deployable with foundation: vanilla", () => {
    const out = generatePhoenixLiveViewProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    expect(out.size).toBe(0);
  });

  it("does NOT crash with empty contexts when foundation: vanilla is set (defence in depth)", () => {
    // The early-return on foundation: vanilla means none of the per-context
    // emitters fire, so empty contexts (which would otherwise be a no-op
    // anyway) don't blow up.
    const out = generatePhoenixLiveViewProject({
      contexts: [],
      deployable: vanillaDeployable(),
      sys: emptySystem(),
    });
    expect(out).toBeInstanceOf(Map);
  });
});
