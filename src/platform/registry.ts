import type { Platform } from "../ir/types/loom-ir.js";
import dotnetPlatform from "./dotnet.js";
import honoPlatform, { loomManifest as honoV4Manifest } from "./hono/v4/index.js";
import type { LoomBackendManifest } from "./manifest.js";
import phoenixPlatform from "./phoenix-live-view.js";
import reactPlatform from "./react.js";
import type { PlatformSurface } from "./surface.js";

// ---------------------------------------------------------------------------
// Single source of truth for which platforms exist + how the system
// orchestrator dispatches over them.
//
// Backend packages (see docs/backend-packages.md): the registry
// resolves a backend by `family@version`, with a defaults map
// so a bareword `platform: hono` keeps resolving to a concrete
// version.  Every backend family currently has exactly ONE registered
// version, aliased to the same surface object the bareword returns
// — so the resolution paths yield identical `PlatformSurface` instances
// regardless of whether the source pins a version.  The grammar/lowering
// wires `platform: "hono@v4"` pins, so additional per-family versions
// slot in by registering them in `versionedPlatforms`.
//
// Adding a new platform: write the surface implementation, register
// it in `platforms` (+ `versionedPlatforms` if it's a backend
// family), extend the `Platform` type in `ir/loom-ir.ts` + grammar.
// ---------------------------------------------------------------------------

const platforms: Record<Platform, PlatformSurface> = {
  dotnet: dotnetPlatform,
  hono: honoPlatform,
  react: reactPlatform,
  // `static` is the page-metamodel's UI-only deployable kind.  It
  // shares the React surface — a deployable declared as
  // `platform: static` lowers through the same code path a
  // `platform: react` deployable does.
  static: reactPlatform,
  // Fullstack Elixir/Ash + Phoenix LiveView platform.  Owns its own
  // database, mounts a `ui:`, and (when populated) `serves:` an
  // Ash-derived API.
  phoenix: phoenixPlatform,
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
  phoenix: "v1",
} as const satisfies Partial<Record<Platform, string>>;

export type BackendFamily = keyof typeof BUILTIN_PLATFORM_LATEST;

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
// already restructured into a versioned package dir).  dotnet@v8 /
// phoenixLiveView@v1 are still flat `src/platform/<name>.ts`; their
// manifests are synthesised here until they are packaged, so
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
      family: "phoenix",
      loomVersion: "v1",
      core: "^1.0.0",
    },
    surface: phoenixPlatform,
  },
];

let backendSource: () => DiscoveredBackend[] = () => inTreeBackends;

/** Swap the backend discovery source.  The playground injects a
 *  VFS-backed implementation here; tests use it to assert the
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

/** Resolved view of a `platform:` value pointing at a backend
 *  family.  `null` for frontend (`react`/`static`) or unknown
 *  names — callers fall through to plain `platforms[name]`. */
export interface ParsedBuiltinPlatformRef {
  family: BackendFamily;
  version: string;
  /** `${family}@${version}` — the key into `versionedPlatforms`
   *  and the value lowering qualifies a bareword to. */
  qualified: string;
}

/** D-PHOENIX-SURFACE platform aliases → canonical family name.
 *  `phoenix` is the canonical host-platform name (decoupled from the
 *  LiveView *framework*, which keeps the `phoenixLiveView` spelling).
 *  The legacy `phoenixLiveView` *platform* name is admitted as a
 *  back-compat alias that desugars to `phoenix`; a `@version` pin is
 *  preserved (`phoenixLiveView@v1` → `phoenix@v1`). */
function aliasPlatform(s: string): string {
  const at = s.indexOf("@");
  const family = at === -1 ? s : s.slice(0, at);
  if (family !== "phoenixLiveView") return s;
  return at === -1 ? "phoenix" : `phoenix${s.slice(at)}`;
}

/** Parse a `platform:` value.  Mirrors `parseBuiltinDesignRef`
 *  (builtin-formats.ts): bareword backend → default version;
 *  `family@version` → that pin; frontend / unknown → `null`.
 *  Pure; exported so the validator + lowering share one
 *  resolution authority. */
export function parseBuiltinPlatformRef(s: string): ParsedBuiltinPlatformRef | null {
  // D-PHOENIX-SURFACE: `phoenix` is the host-platform alias for the
  // `phoenix` canonical family.  Canonicalise the legacy alias here, the
  // shared resolution authority, so validator + lowering + `platformFor`
  // all accept the new spelling identically.  The literal-rename cleanup
  // phase flips which name is canonical.
  const canonical = aliasPlatform(s);
  const at = canonical.indexOf("@");
  const family = (at === -1 ? canonical : canonical.slice(0, at)) as BackendFamily;
  if (!(family in BUILTIN_PLATFORM_LATEST)) return null;
  // Slice the version off `canonical`, not the original `s` — the alias may
  // change the family's length (`phoenixLiveView@v1` → `phoenix@v1`), so the
  // `@` index from `canonical` only lines up with `canonical`.
  const version = at === -1 ? BUILTIN_PLATFORM_LATEST[family] : canonical.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
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
