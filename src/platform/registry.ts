import type { Platform } from "../ir/loom-ir.js";
import type { PlatformSurface } from "./surface.js";
import dotnetPlatform from "./dotnet.js";
import honoPlatform from "./hono.js";
import reactPlatform from "./react.js";

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
};

export function platformFor(name: Platform): PlatformSurface {
  return platforms[name];
}

export function allPlatforms(): PlatformSurface[] {
  return Object.values(platforms);
}
