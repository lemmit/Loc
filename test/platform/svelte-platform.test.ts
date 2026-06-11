import { describe, expect, it } from "vitest";
import { platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// Svelte platform surface (svelte-frontend-plan.md Slice 1) — registry
// lookup + the frontend contract flags the rest of the pipeline keys on.
// ---------------------------------------------------------------------------

describe("svelte platform surface", () => {
  it("registers under the `svelte` keyword with the frontend contract", () => {
    const p = platformFor("svelte");
    expect(p.name).toBe("svelte");
    expect(p.isFrontend).toBe(true);
    expect(p.mountsUi).toBe(true);
    expect(p.needsDb).toBe(false);
    expect(p.defaultPort).toBe(3002);
  });

  it("hosts the svelte framework (static-bundle unification is a later slice)", () => {
    const p = platformFor("svelte");
    expect(p.hostableFrameworks.has("svelte")).toBe(true);
  });

  it("carries no adapter menu (frontends have no realization axes)", () => {
    const p = platformFor("svelte");
    expect(p.adapters).toBeUndefined();
    expect(p.adapterDefaults).toBeUndefined();
  });
});
