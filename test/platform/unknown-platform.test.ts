import { describe, expect, it } from "vitest";

import type { Platform } from "../../src/ir/types/loom-ir.js";
import { descriptorFor } from "../../src/platform/metadata.js";
import { platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// B20 — a typo'd / unknown `platform:` ref throws a descriptive error.
//
// The backend-version path already threw "Unknown backend platform version …";
// the frontend/bareword path returned `undefined` typed as a non-optional
// `PlatformSurface` / `PlatformDescriptor`, so a typo crashed later with a bare
// `TypeError` at the first surface access.  Both lookups now throw the same
// shape of descriptive error at the resolution site.
// ---------------------------------------------------------------------------

describe("B20 — unknown platform resolution", () => {
  it("platformFor throws a descriptive error for a typo'd bareword", () => {
    expect(() => platformFor("reactt" as Platform)).toThrow(/Unknown platform "reactt"/);
    // The message enumerates the known platforms so the user can spot the typo.
    expect(() => platformFor("reactt" as Platform)).toThrow(/Known platforms:/);
  });

  it("descriptorFor throws a descriptive error for a typo'd bareword", () => {
    expect(() => descriptorFor("vuex" as Platform)).toThrow(/Unknown platform "vuex"/);
    expect(() => descriptorFor("vuex" as Platform)).toThrow(/Known platforms:/);
  });

  it("still resolves every real platform (no regression on the happy path)", () => {
    for (const p of [
      "node",
      "dotnet",
      "java",
      "python",
      "elixir",
      "react",
      "vue",
      "svelte",
      "angular",
    ] as Platform[]) {
      expect(platformFor(p).name).toBeTypeOf("string");
      expect(descriptorFor(p).isFrontend).toBeTypeOf("boolean");
    }
  });
});
