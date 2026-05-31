import { describe, expect, it } from "vitest";

import type { Platform } from "../../src/ir/types/loom-ir.js";
import { platformFor } from "../../src/platform/registry.js";
import { STATIC_BUNDLE_FRAMEWORKS } from "../../src/platform/surface.js";

// ---------------------------------------------------------------------------
// D-PHOENIX-SURFACE phase 1 — the `hostableFrameworks` capability.
//
// Encodes the principled rule: a host can serve a `ui { framework: … }`
// iff it provides the runtime that framework requires.  Static-bundle
// frameworks (`react`/`static`) are hostable by any static-asset host;
// the runtime-coupled `phoenixLiveView` (LiveView) only by Phoenix.
//
// The field is DORMANT this phase (no validator/grammar consumes it
// yet), so these tests pin the capability shape only — they assert no
// generated output.
// ---------------------------------------------------------------------------

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("hostableFrameworks — the host-capability rule", () => {
  it("every static-asset host serves exactly the static-bundle frameworks", () => {
    // The standalone frontend host plus every backend that serves a
    // static root (dotnet → wwwroot, hono → static middleware).
    for (const p of ["react", "static", "dotnet", "hono"] as Platform[]) {
      expect(sorted(platformFor(p).hostableFrameworks)).toEqual(sorted(STATIC_BUNDLE_FRAMEWORKS));
    }
  });

  it("Phoenix is the keystone — its runtime framework UNIONED with the static bundles", () => {
    const phoenix = platformFor("phoenixLiveView").hostableFrameworks;
    // Hosts its own runtime-coupled LiveView…
    expect(phoenix.has("phoenixLiveView")).toBe(true);
    // …AND every static-bundle framework (priv/static).
    for (const f of STATIC_BUNDLE_FRAMEWORKS) {
      expect(phoenix.has(f)).toBe(true);
    }
  });

  it("Phoenix has the strictly richest set (the only render-runtime + static-host platform)", () => {
    const phoenix = platformFor("phoenixLiveView").hostableFrameworks;
    for (const p of ["react", "static", "dotnet", "hono"] as Platform[]) {
      const other = platformFor(p).hostableFrameworks;
      // Phoenix is a proper superset of every other platform's set.
      expect(other.size).toBeLessThan(phoenix.size);
      for (const f of other) expect(phoenix.has(f)).toBe(true);
    }
  });

  it("LiveView is hostable ONLY by Phoenix (runtime-coupled, not a static bundle)", () => {
    expect(STATIC_BUNDLE_FRAMEWORKS.has("phoenixLiveView")).toBe(false);
    for (const p of ["react", "static", "dotnet", "hono"] as Platform[]) {
      expect(platformFor(p).hostableFrameworks.has("phoenixLiveView")).toBe(false);
    }
  });
});
