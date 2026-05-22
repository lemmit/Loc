import { afterEach, describe, expect, it } from "vitest";
import { PLATFORM_SURFACE_CONTRACT } from "../../src/platform/manifest.js";
import {
  backendVersionsForFamily,
  type DiscoveredBackend,
  discoverBackends,
  isRegisteredBackendRef,
  platformFor,
  resetBackendSource,
  setBackendSource,
} from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// packaging-split P0 (docs/packaging-split.md) — backends resolve
// through an injectable *discovery* seam keyed by their manifest,
// not a hardcoded map.  In-tree it is byte-identical (same surface
// instances); the seam is what the playground (P1) backs with a
// VFS impl instead of fs/node_modules.
// ---------------------------------------------------------------------------

afterEach(() => resetBackendSource());

describe("manifest contract", () => {
  it("publishes a PlatformSurface contract version", () => {
    expect(PLATFORM_SURFACE_CONTRACT).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("in-tree discovery (default source)", () => {
  it("discovers hono@v4 with a real co-located manifest", () => {
    const hono = discoverBackends().find((b) => b.manifest.family === "hono");
    expect(hono?.manifest).toMatchObject({
      kind: "backend",
      family: "hono",
      loomVersion: "v4",
    });
    expect(hono?.manifest.core).toMatch(/^\^?\d/);
  });

  it("discovers exactly the three backend families", () => {
    expect(
      discoverBackends()
        .map((b) => `${b.manifest.family}@${b.manifest.loomVersion}`)
        .sort(),
    ).toEqual(["dotnet@v8", "hono@v4", "phoenixLiveView@v1"]);
  });

  it("resolution is byte-identical: bareword/pin yield the SAME surface", () => {
    expect(platformFor("hono")).toBe(platformFor("hono@v4" as never));
    expect(platformFor("hono").name).toBe("hono");
    expect(backendVersionsForFamily("hono")).toEqual(["v4"]);
    expect(isRegisteredBackendRef("hono@v4")).toBe(true);
    expect(isRegisteredBackendRef("hono@v9")).toBe(false);
  });
});

describe("injectable source — resolver is discovery-agnostic", () => {
  it("setBackendSource swaps what the resolver sees", () => {
    const real = discoverBackends().find((b) => b.manifest.family === "hono")!;
    // A stub source exposing only hono, but pinned at a different
    // loomVersion — proves resolution keys off the manifest, not a
    // hardcoded map.
    const stub: DiscoveredBackend = {
      manifest: { kind: "backend", family: "hono", loomVersion: "v9", core: "^1.0.0" },
      surface: real.surface,
    };
    setBackendSource(() => [stub]);
    expect(isRegisteredBackendRef("hono@v9")).toBe(true);
    expect(isRegisteredBackendRef("hono@v4")).toBe(false);
    expect(backendVersionsForFamily("hono")).toEqual(["v9"]);
    expect(platformFor("hono@v9" as never)).toBe(real.surface);
  });

  it("resetBackendSource restores the in-tree set", () => {
    setBackendSource(() => []);
    resetBackendSource();
    expect(isRegisteredBackendRef("hono@v4")).toBe(true);
  });

  it("not-discovered ref errors with the discovered list", () => {
    setBackendSource(() => []);
    expect(() => platformFor("hono@v4" as never)).toThrow(
      /Unknown backend platform version "hono@v4"\. Discovered: \./,
    );
  });
});
