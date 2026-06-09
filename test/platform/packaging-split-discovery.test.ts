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
// Backend discovery (docs/packaging-split.md) — backends resolve
// through an injectable *discovery* seam keyed by their manifest,
// not a hardcoded map.  In-tree it is byte-identical (same surface
// instances); the seam is what the playground backs with a
// VFS impl instead of fs/node_modules.
// ---------------------------------------------------------------------------

afterEach(() => resetBackendSource());

describe("manifest contract", () => {
  it("publishes a PlatformSurface contract version", () => {
    expect(PLATFORM_SURFACE_CONTRACT).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("in-tree discovery (default source)", () => {
  it("discovers node@v4 with a real co-located manifest", () => {
    const node = discoverBackends().find((b) => b.manifest.family === "node");
    expect(node?.manifest).toMatchObject({
      kind: "backend",
      family: "node",
      loomVersion: "v4",
    });
    expect(node?.manifest.core).toMatch(/^\^?\d/);
  });

  it("discovers exactly the three backend families", () => {
    expect(
      discoverBackends()
        .map((b) => `${b.manifest.family}@${b.manifest.loomVersion}`)
        .sort(),
    ).toEqual(["dotnet@v8", "elixir@v1", "node@v4"]);
  });

  it("resolution is byte-identical: bareword/pin yield the SAME surface", () => {
    expect(platformFor("node")).toBe(platformFor("node@v4" as never));
    expect(platformFor("node").name).toBe("node");
    expect(backendVersionsForFamily("node")).toEqual(["v4"]);
    expect(isRegisteredBackendRef("node@v4")).toBe(true);
    expect(isRegisteredBackendRef("node@v9")).toBe(false);
  });
});

describe("injectable source — resolver is discovery-agnostic", () => {
  it("setBackendSource swaps what the resolver sees", () => {
    const real = discoverBackends().find((b) => b.manifest.family === "node")!;
    // A stub source exposing only node, but pinned at a different
    // loomVersion — proves resolution keys off the manifest, not a
    // hardcoded map.
    const stub: DiscoveredBackend = {
      manifest: { kind: "backend", family: "node", loomVersion: "v9", core: "^1.0.0" },
      surface: real.surface,
    };
    setBackendSource(() => [stub]);
    expect(isRegisteredBackendRef("node@v9")).toBe(true);
    expect(isRegisteredBackendRef("node@v4")).toBe(false);
    expect(backendVersionsForFamily("node")).toEqual(["v9"]);
    expect(platformFor("node@v9" as never)).toBe(real.surface);
  });

  it("resetBackendSource restores the in-tree set", () => {
    setBackendSource(() => []);
    resetBackendSource();
    expect(isRegisteredBackendRef("node@v4")).toBe(true);
  });

  it("not-discovered ref errors with the discovered list", () => {
    setBackendSource(() => []);
    expect(() => platformFor("node@v4" as never)).toThrow(
      /Unknown backend platform version "node@v4"\. Discovered: \./,
    );
  });
});
