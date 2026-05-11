import type { Platform } from "../ir/loom-ir.js";
import type { PlatformSurface } from "./surface.js";
import dotnetPlatform from "./dotnet.js";
import honoPlatform from "./hono.js";
import reactPlatform from "./react.js";
import phoenixLiveViewPlatform from "./phoenix-live-view.js";

// ---------------------------------------------------------------------------
// Single source of truth for which platforms exist + how the system
// orchestrator dispatches over them.  Adding a new platform: write
// the surface implementation, register it here, extend the
// `Platform` type in `ir/loom-ir.ts` + grammar.
// ---------------------------------------------------------------------------

const platforms: Record<Platform, PlatformSurface> = {
  dotnet: dotnetPlatform,
  hono: honoPlatform,
  react: reactPlatform,
  // `static` is the page-metamodel's UI-only deployable kind (Slice 1
  // grammar / Slice 2 IR).  In v0 it shares the React surface — the
  // page-emitter (Slice 5) hasn't landed yet, so any deployable
  // declared as `platform: static` lowers through the same code path
  // a `platform: react` deployable does.  Slice 8 finishes the swap.
  static: reactPlatform,
  // Fullstack Elixir/Ash + Phoenix LiveView platform.  Owns its own
  // database, mounts a `ui:`, and (when populated) `serves:` an
  // Ash-derived API.  Stub implementation in v0 — emits a minimal
  // mix project shell; Phase 3 of the plan adds Ash domain
  // emission, Phase 6 ships the `ashPhoenix` HEEx pack, Phase 7
  // emits the LiveView modules per page.
  phoenixLiveView: phoenixLiveViewPlatform,
};

export function platformFor(name: Platform): PlatformSurface {
  return platforms[name];
}

export function allPlatforms(): PlatformSurface[] {
  return Object.values(platforms);
}
