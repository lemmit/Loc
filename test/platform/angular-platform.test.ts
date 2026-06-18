import { describe, expect, it } from "vitest";
import { platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// Angular platform surface (angular-frontend-plan.md Slice 1) — registry
// lookup + the frontend contract flags the rest of the pipeline keys on.
// ---------------------------------------------------------------------------

describe("angular platform surface", () => {
  it("registers under the `angular` keyword with the frontend contract", () => {
    const p = platformFor("angular");
    expect(p.name).toBe("angular");
    expect(p.isFrontend).toBe(true);
    expect(p.mountsUi).toBe(true);
    expect(p.needsDb).toBe(false);
    expect(p.defaultPort).toBe(3004);
  });

  it("hosts the angular framework (and the other static bundles)", () => {
    const p = platformFor("angular");
    expect(p.hostableFrameworks.has("angular")).toBe(true);
    expect(p.hostableFrameworks.has("react")).toBe(true);
  });

  it("carries no adapter menu (frontends have no realization axes)", () => {
    const p = platformFor("angular");
    expect(p.adapters).toBeUndefined();
    expect(p.adapterDefaults).toBeUndefined();
  });
});
