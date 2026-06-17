import { describe, expect, it } from "vitest";
import type { Platform } from "../../src/ir/types/loom-ir.js";
import { allPlatformDescriptors, descriptorFor } from "../../src/platform/metadata.js";
import { allPlatforms, platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// The client-safe descriptor table (`platform/metadata.ts`) is a hand-written
// copy of each surface's data fields, kept separate so the front half can read
// platform facts WITHOUT importing the surface objects (and their generators).
// This test pins the copy to the live surfaces: every descriptor field must
// equal the value `platformFor(key).<field>` returns, so the two can't drift.
// ---------------------------------------------------------------------------

const PLATFORM_KEYS: Platform[] = [
  "dotnet",
  "node",
  "react",
  "svelte",
  "vue",
  "static",
  "elixir",
  "python",
  "java",
];

describe("descriptor table pinned to the live surfaces", () => {
  it.each(PLATFORM_KEYS)("descriptorFor(%s) matches the surface's data fields", (key) => {
    const surface = platformFor(key);
    const d = descriptorFor(key);
    expect(d.name).toBe(surface.name);
    expect(d.defaultPort).toBe(surface.defaultPort);
    expect(d.needsDb).toBe(surface.needsDb);
    expect(d.mountsUi).toBe(surface.mountsUi);
    expect(d.isFrontend).toBe(surface.isFrontend);
    expect([...d.hostableFrameworks].sort()).toEqual([...surface.hostableFrameworks].sort());
    expect([...d.reservedRepositoryFindNames].sort()).toEqual(
      [...surface.reservedRepositoryFindNames].sort(),
    );
  });

  it("allPlatformDescriptors yields the same reserved-find-name union as allPlatforms", () => {
    const fromSurfaces = new Set<string>();
    for (const p of allPlatforms())
      for (const n of p.reservedRepositoryFindNames) fromSurfaces.add(n);
    const fromDescriptors = new Set<string>();
    for (const d of allPlatformDescriptors())
      for (const n of d.reservedRepositoryFindNames) fromDescriptors.add(n);
    expect([...fromDescriptors].sort()).toEqual([...fromSurfaces].sort());
  });
});
