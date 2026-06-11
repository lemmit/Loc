import { describe, expect, it } from "vitest";
import { platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// Vue platform surface (vue-frontend-plan.md Slice 1) — registry
// lookup + the frontend contract flags the rest of the pipeline keys on.
// ---------------------------------------------------------------------------

describe("vue platform surface", () => {
  it("registers under the `vue` keyword with the frontend contract", () => {
    const p = platformFor("vue");
    expect(p.name).toBe("vue");
    expect(p.isFrontend).toBe(true);
    expect(p.mountsUi).toBe(true);
    expect(p.needsDb).toBe(false);
    expect(p.defaultPort).toBe(3003);
  });

  it("hosts the vue framework (static-bundle unification is a later slice)", () => {
    const p = platformFor("vue");
    expect(p.hostableFrameworks.has("vue")).toBe(true);
  });

  it("carries no adapter menu (frontends have no realization axes)", () => {
    const p = platformFor("vue");
    expect(p.adapters).toBeUndefined();
    expect(p.adapterDefaults).toBeUndefined();
  });
});
