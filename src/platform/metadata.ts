import type { Platform } from "../ir/types/loom-ir.js";
import { type PlatformDescriptor, STATIC_BUNDLE_FRAMEWORKS } from "./surface.js";

// ---------------------------------------------------------------------------
// Platform METADATA — the client-safe half of the platform registry.
//
// This module holds the pure-data platform facts (the `PlatformDescriptor`
// table) and the pure `platform:` reference helpers.  It imports NO surface
// objects and therefore NO backend generators, so the front half of the
// toolchain (language validators + IR lowering / enrich / validate) can read
// platform facts from here WITHOUT statically pulling `dotnet`/`java`/
// `elixir`/`python` codegen into a client bundle.
//
// The generation half — `platformFor` / `allPlatforms` / `discoverBackends`,
// which resolve actual `PlatformSurface` objects with their `emitProject`
// emitters — lives in `registry.ts` and is server-side only.  A layering
// test pins `language/` + `ir/` to import from THIS module, never `registry`.
//
// `descriptor-consistency.test.ts` asserts every value here equals the live
// surface's field, so the table can't drift from the implementations.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Backend family → default version.  A bareword `platform: <family>`
// resolves to `<family>@<this>`.  Frontend platforms (`react`, `static`,
// `svelte`, `vue`) are intentionally absent — they version via the design
// pack / stack axis, not here — so they stay single-version and resolve
// straight through the descriptor table.
// ---------------------------------------------------------------------------
export const BUILTIN_PLATFORM_LATEST = {
  node: "v5",
  dotnet: "v10",
  elixir: "v1",
  python: "v1",
  java: "v1",
} as const satisfies Partial<Record<Platform, string>>;

export type BackendFamily = keyof typeof BUILTIN_PLATFORM_LATEST;

// Older in-tree backend versions still registered (resolvable via an
// explicit `family@version` pin) but not the family default.  `node@v4`
// (zod 3 / TS 5) stays loadable alongside the v5 default.
const BUILTIN_PLATFORM_EXTRA_VERSIONS: Partial<Record<BackendFamily, string[]>> = {
  node: ["v4"],
};

/** Resolved view of a `platform:` value pointing at a backend family.
 *  `null` for frontend (`react`/`static`/…) or unknown names — callers
 *  fall through to plain descriptor / surface lookup. */
export interface ParsedBuiltinPlatformRef {
  family: BackendFamily;
  version: string;
  /** `${family}@${version}` — the value lowering qualifies a bareword to. */
  qualified: string;
}

/** Parse a `platform:` value.  Bareword backend → default version;
 *  `family@version` → that pin; frontend / unknown → `null`.  Pure;
 *  the shared resolution authority for validator + lowering.
 *
 *  No alias desugaring: every legacy platform alias (`hono` → `node`,
 *  `phoenix` / `phoenixLiveView` → `elixir`, `fastapi` → `python`) was
 *  retired, so the spelling IS the canonical family. */
export function parseBuiltinPlatformRef(s: string): ParsedBuiltinPlatformRef | null {
  const at = s.indexOf("@");
  const family = (at === -1 ? s : s.slice(0, at)) as BackendFamily;
  if (!(family in BUILTIN_PLATFORM_LATEST)) return null;
  const version = at === -1 ? BUILTIN_PLATFORM_LATEST[family] : s.slice(at + 1);
  return { family, version, qualified: `${family}@${version}` };
}

// ---------------------------------------------------------------------------
// Backend versions, as DATA (family@version pairs — no surfaces).  The
// in-tree default derives from `BUILTIN_PLATFORM_LATEST` (one version per
// family), byte-identical to what the generation registry's
// `discoverBackends()` yields for the built-in backends.
//
// The source is injectable so out-of-tree / VFS discovery still affects
// version validation: `registry.setBackendSource()` projects its discovered
// surfaces' manifests into here via `setBackendVersionSource`, keeping this
// module surface-free (it only ever sees family/version strings).
// ---------------------------------------------------------------------------

/** A backend's `family@version` identity — the manifest projection the
 *  version helpers reason over, with no surface attached. */
export interface BackendVersionEntry {
  family: string;
  version: string;
}

const inTreeBackendVersions: BackendVersionEntry[] = [
  ...(Object.entries(BUILTIN_PLATFORM_LATEST) as [BackendFamily, string][]).map(
    ([family, version]) => ({ family, version }),
  ),
  ...(Object.entries(BUILTIN_PLATFORM_EXTRA_VERSIONS) as [BackendFamily, string[]][]).flatMap(
    ([family, versions]) => versions.map((version) => ({ family, version })),
  ),
];

let backendVersionSource: () => BackendVersionEntry[] = () => inTreeBackendVersions;

/** Swap the version-discovery source.  Called by `registry.setBackendSource`
 *  with the manifest projection of its discovered surfaces, so out-of-tree /
 *  VFS backends affect version validation without this module importing any
 *  surface. */
export function setBackendVersionSource(src: () => BackendVersionEntry[]): void {
  backendVersionSource = src;
}

/** Restore the default in-tree version source. */
export function resetBackendVersionSource(): void {
  backendVersionSource = () => inTreeBackendVersions;
}

/** Versions registered for a backend family (e.g. `["v4"]` for `node`).
 *  Used by the validator's "no such version" error to list available pins. */
export function backendVersionsForFamily(family: BackendFamily): string[] {
  return backendVersionSource()
    .filter((b) => b.family === family)
    .map((b) => b.version)
    .sort();
}

/** True when `qualified` (a `family@version` string) is a registered
 *  backend.  The validator uses this to reject a pinned platform whose
 *  version doesn't exist. */
export function isRegisteredBackendRef(qualified: string): boolean {
  const at = qualified.indexOf("@");
  if (at === -1) return false;
  const family = qualified.slice(0, at);
  const version = qualified.slice(at + 1);
  return backendVersionSource().some((b) => b.family === family && b.version === version);
}

// ---------------------------------------------------------------------------
// The descriptor table — client-safe platform facts.  Source of truth for
// the front half; pinned to the live surfaces by descriptor-consistency.test.ts.
// `static` shares React's descriptor (the registry maps both to the React
// surface); `node` is the Hono backend.
// ---------------------------------------------------------------------------

const reactDescriptor: PlatformDescriptor = {
  name: "react",
  defaultPort: 3001,
  needsDb: false,
  mountsUi: true,
  isFrontend: true,
  hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
  reservedRepositoryFindNames: new Set(),
};

const PLATFORM_DESCRIPTORS: Record<Platform, PlatformDescriptor> = {
  dotnet: {
    name: "dotnet",
    defaultPort: 8080,
    needsDb: true,
    mountsUi: true,
    isFrontend: false,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(["saveAsync", "getByIdAsync"]),
  },
  node: {
    name: "node",
    defaultPort: 3000,
    needsDb: true,
    mountsUi: false,
    isFrontend: false,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete"]),
  },
  react: reactDescriptor,
  // `static` is React's UI-only alias — same surface, same descriptor.
  static: reactDescriptor,
  svelte: {
    name: "svelte",
    defaultPort: 3002,
    needsDb: false,
    mountsUi: true,
    isFrontend: true,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(),
  },
  vue: {
    name: "vue",
    defaultPort: 3003,
    needsDb: false,
    mountsUi: true,
    isFrontend: true,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(),
  },
  angular: {
    name: "angular",
    defaultPort: 3004,
    needsDb: false,
    mountsUi: true,
    isFrontend: true,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(),
  },
  // Feliz (Fable/F#/Elmish MVU) — a frontend whose bundle is built via
  // `dotnet fable` + `vite`, NOT the vite-only static pipeline, so it hosts
  // only its own framework (other static hosts can't run the Fable build).
  feliz: {
    name: "feliz",
    defaultPort: 3005,
    needsDb: false,
    mountsUi: true,
    isFrontend: true,
    hostableFrameworks: new Set(["feliz"]),
    reservedRepositoryFindNames: new Set(),
  },
  elixir: {
    name: "elixir",
    defaultPort: 4000,
    needsDb: true,
    mountsUi: true,
    isFrontend: false,
    hostableFrameworks: new Set(["phoenixLiveView", "react", "static", "vue", "svelte"]),
    reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  },
  python: {
    name: "python",
    defaultPort: 8000,
    needsDb: true,
    mountsUi: true,
    isFrontend: false,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete"]),
  },
  java: {
    name: "java",
    defaultPort: 8081,
    needsDb: true,
    mountsUi: true,
    isFrontend: false,
    hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS,
    reservedRepositoryFindNames: new Set(["save", "findById", "getById", "delete", "findAll"]),
  },
};

/** The client-safe descriptor (data fields only) for a `platform:` value.
 *  Replaces `platformFor(name).<field>` reads in the front half.
 *
 *  Canonicalises legacy spellings and version pins exactly as registry's
 *  `resolvePlatformRef` does, so callers can pass a raw source value
 *  (`"node@v4"`, `"node"`) or a canonical `Platform` and get
 *  the same descriptor — `platformFor(x).<field>` and `descriptorFor(x).<field>`
 *  agree for every input. */
export function descriptorFor(name: Platform): PlatformDescriptor {
  // Backend bareword / `family@version` pin → canonical family key;
  // frontend / unknown → the value itself (already a descriptor key).
  const parsed = parseBuiltinPlatformRef(name);
  const key = (parsed ? parsed.family : name) as Platform;
  const descriptor = PLATFORM_DESCRIPTORS[key];
  if (!descriptor) {
    // A typo'd / unknown `platform:` value — throw a descriptive error
    // instead of returning `undefined` typed as a non-optional
    // `PlatformDescriptor` (which crashes later with a bare `TypeError`),
    // mirroring `resolvePlatformRef`'s unknown-platform guard.
    throw new Error(
      `Unknown platform "${name}". ` +
        `Known platforms: ${Object.keys(PLATFORM_DESCRIPTORS).join(", ")}.`,
    );
  }
  return descriptor;
}

/** Every platform's descriptor — replaces `allPlatforms()` for the
 *  reserved-find-name union and any other descriptor-only iteration. */
export function allPlatformDescriptors(): PlatformDescriptor[] {
  // De-dupe the shared React/`static` descriptor so callers iterating
  // for a union don't double-count (set semantics make it harmless, but
  // keep the list one-per-distinct-surface to mirror `allPlatforms()`).
  const seen = new Set<PlatformDescriptor>();
  const out: PlatformDescriptor[] = [];
  for (const d of Object.values(PLATFORM_DESCRIPTORS)) {
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

/** Every platform keyword (as the grammar spells it) that owns a BACKEND —
 *  `isFrontend: false` in the descriptor table.  Derived, not hand-listed, so
 *  validator messages that enumerate backends can't drift (C15). Includes the
 *  `static` alias iteration is skipped (frontend), so this yields the distinct
 *  backend keywords: dotnet, node, elixir, python, java. */
export function backendPlatformNames(): string[] {
  return Object.entries(PLATFORM_DESCRIPTORS)
    .filter(([, d]) => !d.isFrontend)
    .map(([name]) => name)
    .sort();
}

/** Every platform keyword that is a FRONTEND (`isFrontend: true`): react,
 *  static, svelte, vue, angular.  Derived from the descriptor table (C15). */
export function frontendPlatformNames(): string[] {
  return Object.entries(PLATFORM_DESCRIPTORS)
    .filter(([, d]) => d.isFrontend)
    .map(([name]) => name)
    .sort();
}
