import { describe, expect, it } from "vitest";
import type { StyleAdapter } from "../../src/generator/_adapters/index.js";
import type { Platform } from "../../src/ir/types/loom-ir.js";
import * as data from "../../src/platform/adapter-metadata.js";
import * as live from "../../src/platform/resolve-adapters.js";

// ---------------------------------------------------------------------------
// The client-safe adapter METADATA mirror (`src/platform/adapter-metadata.ts`)
// is pure data — it exists so the front half (the `platform-rules.ts`
// validator + `lower-deployment.ts`) can read adapter facts WITHOUT importing
// `resolve-adapters.ts` → `registry.ts` → every backend generator (the leak
// `metadata-boundary.test.ts` now catches transitively).
//
// This test pins that mirror to the LIVE surfaces (via `resolve-adapters.ts`,
// which IS allowed to import the registry — it's server-side), exactly as
// `descriptor-consistency.test.ts` pins the `PlatformDescriptor` table.  A
// surface that grows / renames an adapter, flips a stub to real, or changes a
// default or a style's `supportedLayouts` fails here until the mirror follows.
// ---------------------------------------------------------------------------

const AXES = ["persistence", "style", "layout"] as const;

// Every `platform:` spelling the front half may see — backends (with menus),
// python (backend, no menu yet), frontends (no menu), and the `node@v4` pin.
const PLATFORMS: Platform[] = [
  "node",
  "node@v4" as Platform,
  "dotnet",
  "elixir",
  "java",
  "python",
  "react",
  "static",
  "svelte",
  "vue",
  "angular",
];

describe("adapter-metadata mirror agrees with the live surfaces", () => {
  it.each(PLATFORMS)("hasAdapters(%s) matches", (p) => {
    expect(data.hasAdapters(p)).toBe(live.hasAdapters(p));
  });

  for (const axis of AXES) {
    it.each(PLATFORMS)(`availableAdapterNames(%s, ${axis}) matches`, (p) => {
      expect(data.availableAdapterNames(p, axis)).toEqual(live.availableAdapterNames(p, axis));
    });
    it.each(PLATFORMS)(`allAdapterNames(%s, ${axis}) matches`, (p) => {
      expect(data.allAdapterNames(p, axis)).toEqual(live.allAdapterNames(p, axis));
    });
  }

  it.each(PLATFORMS)("defaultsFor(%s) matches", (p) => {
    expect(data.defaultsFor(p)).toEqual(live.defaultsFor(p));
  });

  it.each(PLATFORMS)("styleSupportedLayouts(%s, …) matches every style", (p) => {
    const menu = live.adaptersFor(p);
    if (!menu) {
      // No live menu → the mirror must report `undefined` for any style key.
      expect(data.styleSupportedLayouts(p, "layered")).toBeUndefined();
      return;
    }
    for (const [name, adapter] of Object.entries(menu.styles)) {
      const liveLayouts = (adapter as StyleAdapter).supportedLayouts as readonly string[];
      expect(data.styleSupportedLayouts(p, name)).toEqual(liveLayouts);
    }
  });
});
