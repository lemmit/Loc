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
  it("discovers node@v5 (default) with a real co-located manifest", () => {
    // The node family ships two co-located packages — v5 (default,
    // zod 4 / TS 6) and v4 (zod 3 / TS 5).  v5 is listed first.
    const node = discoverBackends().find((b) => b.manifest.family === "node");
    expect(node?.manifest).toMatchObject({
      kind: "backend",
      family: "node",
      loomVersion: "v5",
    });
    expect(node?.manifest.core).toMatch(/^\^?\d/);
  });

  it("discovers exactly the registered backend versions", () => {
    expect(
      discoverBackends()
        .map((b) => `${b.manifest.family}@${b.manifest.loomVersion}`)
        .sort(),
    ).toEqual(["dotnet@v10", "elixir@v1", "java@v1", "node@v4", "node@v5", "python@v1"]);
  });

  it("resolution: bareword resolves to the default (v5) surface", () => {
    expect(platformFor("node")).toBe(platformFor("node@v5" as never));
    // v4 stays registered + distinct, pinnable via `platform: node@v4`.
    expect(platformFor("node@v4" as never)).not.toBe(platformFor("node"));
    expect(platformFor("node").name).toBe("node");
    expect(backendVersionsForFamily("node")).toEqual(["v4", "v5"]);
    expect(isRegisteredBackendRef("node@v4")).toBe(true);
    expect(isRegisteredBackendRef("node@v5")).toBe(true);
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
