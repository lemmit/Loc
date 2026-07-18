import type { Platform } from "../ir/types/loom-ir.js";
import angularPlatform from "./angular.js";
import dotnetPlatform from "./dotnet.js";
import elixirPlatform from "./elixir.js";
import felizPlatform from "./feliz.js";
import flutterPlatform from "./flutter.js";
import honoPlatform, { loomManifest as honoV4Manifest } from "./hono/v4/index.js";
import honoV5Platform, { loomManifest as honoV5Manifest } from "./hono/v5/index.js";
import javaPlatform from "./java.js";
import type { LoomBackendManifest } from "./manifest.js";
// The pure, client-safe metadata half (descriptor table + `platform:` ref
// parsing + version helpers) lives in `metadata.ts` — imported here and
// RE-EXPORTED so existing server-side importers (`system/`, the CLI) keep
// resolving these symbols from `registry.ts`.  The front half (`language/`
// + `ir/`) imports them straight from `metadata.ts`, so it never pulls these
// surface objects (and therefore no backend generators) into a client bundle.
import {
  type BackendFamily,
  BUILTIN_PLATFORM_LATEST,
  backendVersionsForFamily,
  isRegisteredBackendRef,
  type ParsedBuiltinPlatformRef,
  parseBuiltinPlatformRef,
  resetBackendVersionSource,
  setBackendVersionSource,
} from "./metadata.js";
import pythonPlatform from "./python.js";
import reactPlatform from "./react.js";
import type { PlatformSurface } from "./surface.js";
import sveltePlatform from "./svelte.js";
import vuePlatform from "./vue.js";

export {
  type BackendFamily,
  BUILTIN_PLATFORM_LATEST,
  backendVersionsForFamily,
  isRegisteredBackendRef,
  type ParsedBuiltinPlatformRef,
  parseBuiltinPlatformRef,
};

// ---------------------------------------------------------------------------
// Single source of truth for which platforms exist + how the system
// orchestrator dispatches over them.
//
// Backend packages (see docs/backend-packages.md): the registry
// resolves a backend by `family@version`, with a defaults map
// so a bareword `platform: node` keeps resolving to a concrete
// version.  Every backend family currently has exactly ONE registered
// version, aliased to the same surface object the bareword returns
// — so the resolution paths yield identical `PlatformSurface` instances
// regardless of whether the source pins a version.  The grammar/lowering
// wires `platform: "node@v4"` pins, so additional per-family versions
// slot in by registering them in `versionedPlatforms`.
//
// Adding a new platform: write the surface implementation, register
// it in `platforms` (+ `versionedPlatforms` if it's a backend
// family), extend the `Platform` type in `ir/loom-ir.ts` + grammar.
// ---------------------------------------------------------------------------

const platforms: Record<Platform, PlatformSurface> = {
  dotnet: dotnetPlatform,
  // Bareword `platform: node` → the default version (v5, zod 4 / TS 6).
  // v4 stays resolvable via the pinned `platform: node@v4` (registered in
  // `inTreeBackends` below).  Backend barewords actually resolve through
  // `parseBuiltinPlatformRef` → `qualifiedBackendSurfaces()`, so this
  // entry feeds `allPlatforms()` / the descriptor-consistency check.
  node: honoV5Platform,
  react: reactPlatform,
  // Second frontend-only platform — Svelte 5 / SvelteKit static SPA.
  // Same deployable contract as `react` (targets a backend, no DB).
  svelte: sveltePlatform,
  // Third frontend-only platform — Vue 3 Vite SPA (vue-router).
  // Same deployable contract as `react` (targets a backend, no DB).
  vue: vuePlatform,
  // Fourth frontend-only platform — Angular standalone-component app
  // (signals, provideRouter, ng build → static bundle).
  // Same deployable contract as `react` (targets a backend, no DB).
  angular: angularPlatform,
  // Fifth frontend-only platform — Feliz (Fable/F#/Elmish MVU) SPA.
  // Built via `dotnet fable` + `vite` (not the vite-only static pipeline),
  // so it hosts only its own framework.  Same deployable contract as
  // `react` (targets a backend, no DB).
  feliz: felizPlatform,
  // Sixth frontend-only platform — Flutter (Dart/Material) mobile+web app.
  // Self-hosting (built by the Flutter SDK, not the vite-only static
  // pipeline), so it hosts only its own framework.  Same deployable
  // contract as `react` (targets a backend, no DB).
  flutter: flutterPlatform,
  // `static` is the page-metamodel's UI-only deployable kind.  It
  // shares the React surface — a deployable declared as
  // `platform: static` lowers through the same code path a
  // `platform: react` deployable does.
  static: reactPlatform,
  // Fullstack Elixir / Phoenix LiveView platform.  Owns its own
  // database, mounts a `ui:`, and (when populated) `serves:` a
  // Phoenix API.  `elixir` is the only spelling — the legacy
  // `platform: phoenix` / `phoenixLiveView` aliases were retired
  // (D-ELIXIR-PLATFORM), mirroring the retired `hono` → `node` alias.
  elixir: elixirPlatform,
  // FastAPI + SQLAlchemy 2 backend.  `python` is the only spelling —
  // the `fastapi` platform alias was retired (mirrors the retired
  // `hono` → `node` alias).
  python: pythonPlatform,
  // Spring Boot / Spring Data JPA backend (backend-only; embeds a React
  // SPA when the deployable declares `ui:`, like dotnet).
  java: javaPlatform,
};

// ---------------------------------------------------------------------------
// Backend discovery (docs/packaging-split.md) — backends are
// resolved through a *discovery* seam keyed by their manifest, not a
// hardcoded map.  Everything currently stays in-tree and returns the
// exact same surfaces, so `versionedPlatforms` is *derived* from the
// discovered set: byte-identical.  The source is injectable so the
// playground can back it with a VFS impl instead of fs /
// node_modules, exactly as it swaps `loader-fs`→`loader-vfs`.
// ---------------------------------------------------------------------------

export interface DiscoveredBackend {
  manifest: LoomBackendManifest;
  surface: PlatformSurface;
}

// hono@v4 ships a real co-located manifest (it is the only backend
// already restructured into a versioned package dir).  dotnet@v10 /
// elixir@v1 are still flat `src/platform/<name>.ts`; their
// manifests are synthesised here until they are packaged, so
// the discovered set — and thus every resolution — is unchanged.
const inTreeBackends: DiscoveredBackend[] = [
  // Both Hono package versions are registered: v5 (default, zod 4 / TS 6)
  // and v4 (zod 3 / TS 5, pinnable via `platform: node@v4`).
  { manifest: honoV5Manifest, surface: honoV5Platform },
  { manifest: honoV4Manifest, surface: honoPlatform },
  {
    manifest: {
      kind: "backend",
      family: "dotnet",
      loomVersion: "v10",
      core: "^1.0.0",
    },
    surface: dotnetPlatform,
  },
  {
    manifest: {
      kind: "backend",
      family: "elixir",
      loomVersion: "v1",
      core: "^1.0.0",
    },
    surface: elixirPlatform,
  },
  {
    manifest: {
      kind: "backend",
      family: "python",
      loomVersion: "v1",
      core: "^1.0.0",
    },
    surface: pythonPlatform,
  },
  {
    manifest: {
      kind: "backend",
      family: "java",
      loomVersion: "v1",
      core: "^1.0.0",
    },
    surface: javaPlatform,
  },
];

let backendSource: () => DiscoveredBackend[] = () => inTreeBackends;

/** Swap the backend discovery source.  The playground injects a
 *  VFS-backed implementation here; tests use it to assert the
 *  resolver is source-agnostic.  Also projects the discovered manifests'
 *  `family@version` identities into the client-safe metadata version
 *  source, so out-of-tree backends affect version validation (which the
 *  front half reads from `metadata.ts`, never from here). */
export function setBackendSource(src: () => DiscoveredBackend[]): void {
  backendSource = src;
  setBackendVersionSource(() =>
    src().map((b) => ({ family: b.manifest.family, version: b.manifest.loomVersion })),
  );
}

/** Restore the default in-tree discovery source (surfaces + metadata versions). */
export function resetBackendSource(): void {
  backendSource = () => inTreeBackends;
  resetBackendVersionSource();
}

/** The in-tree backend set the registry was bootstrapped with —
 *  i.e. the entries `versionedPlatforms` originally aliased.  fs-
 *  backed discovery (see `fs-discovery.ts`) composes against
 *  this so families/versions not yet packaged as npm workspace
 *  modules still resolve from in-tree code.  Returned as
 *  `readonly` so callers can't mutate the source-of-truth array. */
export function defaultBuiltInBackends(): readonly DiscoveredBackend[] {
  return inTreeBackends;
}

/** Every backend the active source discovers. */
export function discoverBackends(): DiscoveredBackend[] {
  return backendSource();
}

/** `family@loomVersion` → surface, derived from the discovered set.
 *  Replaces the former hardcoded `versionedPlatforms` literal;
 *  with the in-tree source it yields the identical three entries. */
function qualifiedBackendSurfaces(): Record<string, PlatformSurface> {
  const out: Record<string, PlatformSurface> = {};
  for (const b of discoverBackends()) {
    out[`${b.manifest.family}@${b.manifest.loomVersion}`] = b.surface;
  }
  return out;
}

/** Resolve any `platform:` ref — bareword (`hono`, `react`) or
 *  pinned (`hono@v4`) — to its surface.  Backend barewords route
 *  through `BUILTIN_PLATFORM_LATEST`; everything else (frontend,
 *  unknown) reads `platforms` directly.  Every path returns the
 *  same surface instance callers have always got. */
function resolvePlatformRef(ref: string): PlatformSurface {
  const parsed = parseBuiltinPlatformRef(ref);
  if (parsed) {
    const map = qualifiedBackendSurfaces();
    const surface = map[parsed.qualified];
    if (!surface) {
      throw new Error(
        `Unknown backend platform version "${parsed.qualified}". ` +
          `Discovered: ${Object.keys(map).join(", ")}.`,
      );
    }
    return surface;
  }
  const surface = platforms[ref as Platform];
  if (!surface) {
    // A bareword that's neither a known frontend/backend platform nor a
    // pinned backend version — a typo'd `platform:` ref.  Throw the same
    // descriptive error the pinned-backend path gives instead of returning
    // `undefined` typed as a non-optional `PlatformSurface` (which crashes
    // later with a bare `TypeError` at the first surface access).
    throw new Error(
      `Unknown platform "${ref}". ` + `Known platforms: ${Object.keys(platforms).join(", ")}.`,
    );
  }
  return surface;
}

export function platformFor(name: Platform): PlatformSurface {
  return resolvePlatformRef(name);
}

export function allPlatforms(): PlatformSurface[] {
  return Object.values(platforms);
}
