import { describe, expect, it } from "vitest";

import type { Platform } from "../../src/ir/types/loom-ir.js";
import { platformFor } from "../../src/platform/registry.js";
import { EMBEDDABLE_FRAMEWORKS, STATIC_BUNDLE_FRAMEWORKS } from "../../src/platform/surface.js";

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
  it("frontend static hosts (+ node) serve exactly the static-bundle frameworks", () => {
    // The standalone frontend hosts serve any vite/adapter-static bundle but
    // NOT feliz — a static-asset host can't run feliz's `dotnet fable` build.
    // `node` (no `ui:` embed dispatch) stays on the static set too.
    for (const p of ["react", "svelte", "static", "vue", "node"] as Platform[]) {
      expect(sorted(platformFor(p).hostableFrameworks)).toEqual(sorted(STATIC_BUNDLE_FRAMEWORKS));
    }
  });

  it("embedding backend hosts also serve feliz (EMBEDDABLE = static + feliz)", () => {
    // A backend host owns its Dockerfile, so it can run a `dotnet fable`
    // SPA-build stage and embed a Feliz bundle alongside the vite frameworks.
    for (const p of ["dotnet", "java", "python"] as Platform[]) {
      expect(sorted(platformFor(p).hostableFrameworks)).toEqual(sorted(EMBEDDABLE_FRAMEWORKS));
    }
    expect(EMBEDDABLE_FRAMEWORKS.has("feliz")).toBe(true);
    expect(STATIC_BUNDLE_FRAMEWORKS.has("feliz")).toBe(false);
  });

  it("Phoenix hosts LiveView + every static bundle (all served under /app)", () => {
    const phoenix = platformFor("elixir").hostableFrameworks;
    // Hosts its own runtime-coupled LiveView…
    expect(phoenix.has("phoenixLiveView")).toBe(true);
    // …and every static bundle, all served from /app: react / static /
    // vue build with vite `base: "/app/"`, svelte with SvelteKit
    // `paths.base = "/app"` — so asset URLs + client-side links resolve
    // under the prefix instead of 404-ing at root.
    expect(phoenix.has("react")).toBe(true);
    expect(phoenix.has("static")).toBe(true);
    expect(phoenix.has("vue")).toBe(true);
    expect(phoenix.has("svelte")).toBe(true);
    // …plus feliz (its own dotnet-fable SPA-build stage under /app).
    expect(phoenix.has("feliz")).toBe(true);
  });

  it("LiveView is hostable ONLY by Phoenix (runtime-coupled, not a static bundle)", () => {
    expect(STATIC_BUNDLE_FRAMEWORKS.has("phoenixLiveView")).toBe(false);
    for (const p of ["react", "svelte", "static", "vue", "dotnet", "node"] as Platform[]) {
      expect(platformFor(p).hostableFrameworks.has("phoenixLiveView")).toBe(false);
    }
  });
});
