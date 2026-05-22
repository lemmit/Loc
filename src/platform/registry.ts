import type { Platform } from "../ir/loom-ir.js";
import dotnetPlatform from "./dotnet.js";
import honoPlatform, { loomManifest as honoV4Manifest } from "./hono/v4/index.js";
import type { LoomBackendManifest } from "./manifest.js";
import phoenixLiveViewPlatform from "./phoenix-live-view.js";
import reactPlatform from "./react.js";
import type { PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Single source of truth for which platforms exist + how the system
// orchestrator dispatches over them.
//
// Backend-packages B0 (see docs/backend-packages.md): the registry
// now resolves a backend by `family@version`, with a defaults map
// so a bareword `platform: hono` keeps resolving to a concrete
// version.  Today every backend family has exactly ONE registered
// version, aliased to the same surface object that the bareword
// returned before — so this is byte-identical: every resolution
// path yields the identical `PlatformSurface` instance it did
// pre-B0.  B1 wires the grammar/lowering so `platform: "hono@v4"`
// can be pinned; B3+ introduce a second version per family.
//
// Adding a new platform: write the surface implementation, register
// it in `platforms` (+ `versionedPlatforms` if it's a backend
// family), extend the `Platform` type in `ir/loom-ir.ts` + grammar.
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
  // Ash-derived API.
  phoenixLiveView: phoenixLiveViewPlatform,
};

// ---------------------------------------------------------------------------
// Backend family → default version.  A bareword `platform: <family>`
// resolves to `<family>@<this>`.  Frontend platforms (`react`,
// `static`) are intentionally absent — they version via the design
// pack / stack axis, not here (backend-packages.md open question #2),
// so they stay single-version and resolve straight through
// `platforms`.
// ---------------------------------------------------------------------------
export const BUILTIN_PLATFORM_LATEST = {
  hono: "v4",
  dotnet: "v8",
  phoenixLiveView: "v1",
} as const satisfies Partial<Record<Platform, string>>;

export type BackendFamily = keyof typeof BUILTIN_PLATFORM_LATEST;

// ---------------------------------------------------------------------------
// packaging-split P0 (docs/packaging-split.md) — backends are
// resolved through a *discovery* seam keyed by their manifest, not a
// hardcoded map.  P0 keeps everything in-tree and returns the exact
// same surfaces, so `versionedPlatforms` is now *derived* from the
// discovered set: byte-identical.  The source is injectable so the
// playground (P1) can back it with a VFS impl instead of fs /
// node_modules, exactly as it swaps `loader-fs`→`loader-vfs`.
// ---------------------------------------------------------------------------

export interface DiscoveredBackend {
  manifest: LoomBackendManifest;
  surface: PlatformSurface;
}

// hono@v4 ships a real co-located manifest (it is the only backend
// already restructured into a versioned package dir).  dotnet@v8 /
// phoenixLiveView@v1 are still flat `src/platform/<name>.ts`; their
// manifests are synthesised here until they are packaged (P2), so
// the discovered set — and thus every resolution — is unchanged.
const inTreeBackends: DiscoveredBackend[] = [
  { manifest: honoV4Manifest, surface: honoPlatform },
  {
    manifest: {
      kind: "backend",
      family: "dotnet",
      loomVersion: "v8",
      core: "^1.0.0",
    },
    surface: dotnetPlatform,
  },
  {
    manifest: {
      kind: "backend",
      family: "phoenixLiveView",
      loomVersion: "v1",
      core: "^1.0.0",
    },
    surface: phoenixLiveViewPlatform,
  },
];

let backendSource: () => DiscoveredBackend[] = () => inTreeBackends;

/** Swap the backend discovery source.  The playground injects a
 *  VFS-backed implementation here (P1); tests use it to assert the
 *  resolver is source-agnostic. */
export function setBackendSource(src: () => DiscoveredBackend[]): void {
  backendSource = src;
}

/** Restore the default in-tree discovery source. */
export function resetBackendSource(): void {
  backendSource = () => inTreeBackends;
}

/** The in-tree backend set the registry was bootstrapped with —
 *  i.e. the entries `versionedPlatforms` originally aliased.  fs-
 *  backed discovery (P3, see `fs-discovery.ts`) composes against
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

/** Resolved view of a `platform:` value pointing at a backend
 *  family.  `null` for frontend (`react`/`static`) or unknown
 *  names — callers fall through to plain `platforms[name]`. */
export interface ParsedBuiltinPlatformRef {
  family: BackendFamily;
  version: string;
  /** `${family}@${version}` — the key into `versionedPlatforms`
   *  and the value lowering qualifies a bareword to in B1. */
  qualified: string;
}

/** Parse a `platform:` value.  Mirrors `parseBuiltinDesignRef`
 *  (builtin-formats.ts): bareword backend → default version;
 *  `family@version` → that pin; frontend / unknown → `null`.
 *  Pure; exported so B1's validator + lowering share one
 *  resolution authority. */
export function parseBuiltinPlatformRef(s: string): ParsedBuiltinPlatformRef | null {
  const at = s.indexOf("@");
  const family = (at === -1 ? s : s.slice(0, at)) as BackendFamily;
  if (!(family in BUILTIN_PLATFORM_LATEST)) return null;
  const version = at === -1 ? BUILTIN_PLATFORM_LATEST[family] : s.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
}

/** Resolve any `platform:` ref — bareword (`hono`, `react`) or
 *  pinned (`hono@v4`) — to its surface.  Backend barewords route
 *  through `BUILTIN_PLATFORM_LATEST`; everything else (frontend,
 *  unknown) reads `platforms` directly.  Every path returns the
 *  same surface instance pre-B0 callers got. */
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
  return platforms[ref as Platform];
}

/** Versions registered for a backend family (e.g. `["v4"]` for
 *  `hono`).  Used by the validator's "no such version" error to
 *  list the available pins — mirrors `builtinVersionsForFamily`
 *  for design packs. */
export function backendVersionsForFamily(family: BackendFamily): string[] {
  const prefix = `${family}@`;
  return Object.keys(qualifiedBackendSurfaces())
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

/** True when `qualified` (a `family@version` string) is a
 *  registered backend surface.  The validator uses this to reject
 *  a pinned platform whose version doesn't exist. */
export function isRegisteredBackendRef(qualified: string): boolean {
  return qualified in qualifiedBackendSurfaces();
}

export function platformFor(name: Platform): PlatformSurface {
  return resolvePlatformRef(name);
}

export function allPlatforms(): PlatformSurface[] {
  return Object.values(platforms);
}
