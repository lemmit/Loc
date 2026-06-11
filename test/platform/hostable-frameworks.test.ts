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
    // The standalone frontend hosts plus every backend that serves a
    // static root (dotnet → wwwroot, hono → static middleware).
    for (const p of ["react", "svelte", "static", "dotnet", "hono"] as Platform[]) {
      expect(sorted(platformFor(p).hostableFrameworks)).toEqual(sorted(STATIC_BUNDLE_FRAMEWORKS));
    }
  });

  it("Phoenix hosts LiveView + the react bundles — svelte awaits paths.base wiring", () => {
    const phoenix = platformFor("phoenixLiveView").hostableFrameworks;
    // Hosts its own runtime-coupled LiveView…
    expect(phoenix.has("phoenixLiveView")).toBe(true);
    // …and the react static bundles (priv/static under /app).
    expect(phoenix.has("react")).toBe(true);
    expect(phoenix.has("static")).toBe(true);
    // A SvelteKit bundle under the /app path prefix needs `paths.base`
    // threading (svelte-frontend-plan.md follow-up) — deliberately
    // not hostable yet, so the validator rejects it loudly instead of
    // emitting a bundle whose deep links 404.
    expect(phoenix.has("svelte")).toBe(false);
  });

  it("LiveView is hostable ONLY by Phoenix (runtime-coupled, not a static bundle)", () => {
    expect(STATIC_BUNDLE_FRAMEWORKS.has("phoenixLiveView")).toBe(false);
    for (const p of ["react", "svelte", "static", "dotnet", "hono"] as Platform[]) {
      expect(platformFor(p).hostableFrameworks.has("phoenixLiveView")).toBe(false);
    }
  });
});
