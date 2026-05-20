// ---------------------------------------------------------------------------
// @loom/core — the Loom toolchain's public API surface.
//
// packaging-split P3 slice 4 (docs/packaging-split.md + plan file).
// Today this is a thin re-export of the in-tree `src/` toolchain so
// the `@loom/core` package identity exists on disk: backend packages
// peer-depend on it (`@loom/backend-hono-v4` flips its peer to
// `@loom/core: workspace:*` in this slice) and `@loom/cli` will
// depend on it.  Slice 5 physically relocates source into the
// packages and this stops being a re-export.
//
// SCOPE: only the framework-neutral, browser-safe public surface is
// re-exported here — `generateSystems`, the platform registry seam,
// the `PlatformSurface` contract + manifest types.  The Node-only
// fs-backed discovery (`src/platform/fs-discovery.ts`, which pulls
// `node:fs`) is deliberately NOT re-exported from the root entry so
// `@loom/core` stays importable in the browser playground.  A
// `@loom/core/node` subpath export will surface the Node-only bits
// when a consumer needs them (CLI uses `src/platform/fs-discovery`
// directly today).
//
// NOTE: `packages/` is outside the root tsconfig's `include`, so
// this file is not type-checked by `npm run build` in slice 4.  The
// re-export names are kept correct-by-construction against
// `src/platform/registry.ts` / `surface.ts` / `manifest.ts` /
// `system/index.ts`; slice 5's relocation brings it into a compiled
// build.
// ---------------------------------------------------------------------------

export { generateSystems } from "../../src/system/index.js";

export {
  platformFor,
  allPlatforms,
  setBackendSource,
  resetBackendSource,
  discoverBackends,
  defaultBuiltInBackends,
  parseBuiltinPlatformRef,
  backendVersionsForFamily,
  isRegisteredBackendRef,
  BUILTIN_PLATFORM_LATEST,
} from "../../src/platform/registry.js";
export type {
  DiscoveredBackend,
  BackendFamily,
  ParsedBuiltinPlatformRef,
} from "../../src/platform/registry.js";

export type {
  PlatformSurface,
  ComposeServiceShape,
} from "../../src/platform/surface.js";

export {
  PLATFORM_SURFACE_CONTRACT,
} from "../../src/platform/manifest.js";
export type { LoomBackendManifest } from "../../src/platform/manifest.js";
