import { describe, expect, it } from "vitest";
import {
  formatUnsupportedDeployables,
  type UnsupportedPlatform,
  unsupportedPlatformLabel,
} from "../../web/src/layout/ctx.js";

// ---------------------------------------------------------------------------
// Playground "preview unsupported" surfacing.
//
// The in-browser preview engine bundles only the React SPA shape, so
// dotnet / phoenix backends — and now the svelte / vue frontends, whose
// SvelteKit `$app/*` client + Vue SFC pipeline aren't reproduced
// in-browser — are listed in the UI instead of showing a silent blank
// Preview.  These pin the labels + the comma-joined formatter so each
// platform reads cleanly (`analyzeDeployables` in App.tsx maps the
// generated project markers to these; that detection rides web-tsc).
// ---------------------------------------------------------------------------

describe("unsupported-platform labels", () => {
  it("labels every UnsupportedPlatform with a human name", () => {
    const labels: Record<UnsupportedPlatform, string> = {
      dotnet: ".NET",
      phoenixLiveView: "Phoenix LiveView",
      svelte: "SvelteKit",
      vue: "Vue",
    };
    for (const [platform, label] of Object.entries(labels)) {
      expect(unsupportedPlatformLabel(platform as UnsupportedPlatform)).toBe(label);
    }
  });

  it("formats a mixed deployable list as 'slug (Label)' joined by commas", () => {
    expect(
      formatUnsupportedDeployables([
        { slug: "web", platform: "svelte" },
        { slug: "admin", platform: "vue" },
        { slug: "api", platform: "dotnet" },
      ]),
    ).toBe("web (SvelteKit), admin (Vue), api (.NET)");
  });
});
