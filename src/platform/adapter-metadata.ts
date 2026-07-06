// ---------------------------------------------------------------------------
// Adapter METADATA — the client-safe half of adapter resolution.
//
// The front half of the toolchain (the `platform-rules.ts` validator + IR
// `lower-deployment.ts`) needs only pure adapter FACTS: which adapter names
// each backend offers per realization axis (real vs. reserved-stub), the
// per-platform defaults, and each real style's `supportedLayouts`.  It does
// NOT need the live adapter OBJECTS (with their `emit*` methods) that live in
// `src/generator/<platform>/adapters/`.
//
// Reading those facts off the live surfaces (`resolve-adapters.ts` →
// `registry.platformFor` → every backend generator) dragged all five
// generators into any client bundle that touched the validator — one hop past
// `metadata-boundary.test.ts`, and a runtime `language → platform → generator`
// cycle.  So the facts are mirrored here as pure DATA, with NO surface /
// generator / registry import — exactly like the `PlatformDescriptor` table
// in `metadata.ts`.  `adapter-metadata-consistency.test.ts` pins every value
// against the live surface, so the mirror cannot drift.
//
// The SERVER half — `resolvePersistence` / `resolveStyle` / … returning the
// live adapter objects, and `adaptersFor` / `defaultsFor` reading the live
// menu — stays in `resolve-adapters.ts` (which imports `registry.ts`) and is
// used only by the generators / system composition.
// ---------------------------------------------------------------------------

import type { PlatformAdapterDefaults } from "../generator/_adapters/index.js";
import type { Platform } from "../ir/types/loom-ir.js";
import { parseBuiltinPlatformRef } from "./metadata.js";

/** The adapter-backed realization axes (each maps 1:1 to a `PlatformAdapters`
 *  record on the live surface). */
export type AdapterAxisKind = "persistence" | "style" | "layout";

/** One axis's menu on a backend: the REAL (implemented) adapter names and the
 *  reserved STUB names (registered, but every `emit*` throws). */
interface AxisMenu {
  readonly real: readonly string[];
  readonly stub: readonly string[];
}

interface BackendAdapterMeta {
  readonly persistence: AxisMenu;
  readonly style: AxisMenu;
  readonly layout: AxisMenu;
  /** `supportedLayouts` per style adapter name (real + stub) — read by the
   *  validator's R3 style↔layout compatibility check. */
  readonly styleSupportedLayouts: Readonly<Record<string, readonly string[]>>;
  readonly defaults: PlatformAdapterDefaults;
}

// ---------------------------------------------------------------------------
// The mirror.  Keyed by the canonical backend FAMILY (`node`/`dotnet`/… — a
// `family@version` pin or bareword resolves to the family via
// `parseBuiltinPlatformRef`).  `python` and every frontend platform carry no
// adapter menu (their surfaces omit `adapters()`), so they are absent — the
// lookups below return `undefined` / `[]` for them, matching the live
// surface.  hono@v4 and hono@v5 share one adapter menu (v5 reuses v4's
// `makeHonoPlatform`), so the single `node` entry covers both.
// ---------------------------------------------------------------------------
const BACKEND_ADAPTER_METADATA: Partial<Record<Platform, BackendAdapterMeta>> = {
  node: {
    persistence: { real: ["drizzle", "mikroorm"], stub: [] },
    style: { real: ["layered"], stub: [] },
    layout: { real: ["byLayer", "byFeature"], stub: [] },
    styleSupportedLayouts: {
      layered: ["byLayer", "byFeature"],
    },
    defaults: {
      persistence: { state: "drizzle", eventLog: "drizzle" },
      style: "layered",
      layout: "byLayer",
    },
  },
  dotnet: {
    persistence: { real: ["efcore", "dapper"], stub: [] },
    style: { real: ["cqrs"], stub: [] },
    layout: { real: ["byLayer", "byFeature"], stub: [] },
    styleSupportedLayouts: {
      cqrs: ["byLayer", "byFeature"],
    },
    defaults: {
      persistence: { state: "efcore", eventLog: "efcore" },
      style: "cqrs",
      layout: "byLayer",
    },
  },
  elixir: {
    persistence: { real: ["ecto"], stub: [] },
    style: { real: ["layered"], stub: [] },
    layout: { real: ["byFeature"], stub: [] },
    styleSupportedLayouts: {
      layered: ["byFeature"],
    },
    defaults: {
      persistence: { state: "ecto", eventLog: "ecto" },
      style: "layered",
      layout: "byFeature",
    },
  },
  java: {
    persistence: { real: ["jpa"], stub: [] },
    style: { real: ["layered"], stub: [] },
    layout: { real: ["byLayer", "byFeature"], stub: [] },
    styleSupportedLayouts: {
      layered: ["byLayer", "byFeature"],
    },
    defaults: {
      persistence: { state: "jpa", eventLog: "jpa" },
      style: "layered",
      layout: "byFeature",
    },
  },
};

/** The canonical backend metadata for a `platform:` value, or `undefined` for
 *  a frontend / python / unknown platform (no adapter menu).  Canonicalises a
 *  `family@version` pin or bareword to the family, exactly as
 *  `registry.platformFor` does. */
function metaFor(platform: Platform): BackendAdapterMeta | undefined {
  const parsed = parseBuiltinPlatformRef(platform);
  const key = (parsed ? parsed.family : platform) as Platform;
  return BACKEND_ADAPTER_METADATA[key];
}

/** True when `platform` exposes an adapter menu (i.e. a backend with adapters).
 *  Client-safe mirror of `resolve-adapters.hasAdapters`. */
export function hasAdapters(platform: Platform): boolean {
  return metaFor(platform) !== undefined;
}

/** The DSL-selectable adapter names for one axis — the REAL (implemented)
 *  adapters only, stubs excluded, sorted.  `[]` for frontend / python /
 *  unknown platforms. */
export function availableAdapterNames(platform: Platform, kind: AdapterAxisKind): string[] {
  const meta = metaFor(platform);
  if (!meta) return [];
  return [...meta[kind].real].sort();
}

/** Every adapter name for one axis — REAL and STUB — sorted.  Used to
 *  distinguish "reserved but unimplemented" from "unknown" in diagnostics.
 *  `[]` for frontend / python / unknown platforms. */
export function allAdapterNames(platform: Platform, kind: AdapterAxisKind): string[] {
  const meta = metaFor(platform);
  if (!meta) return [];
  return [...meta[kind].real, ...meta[kind].stub].sort();
}

/** Defaults a platform falls back to when the source doesn't pin one, or
 *  `undefined` for frontend / python / unknown platforms. */
export function defaultsFor(platform: Platform): PlatformAdapterDefaults | undefined {
  return metaFor(platform)?.defaults;
}

/** `supportedLayouts` declared by a style adapter, or `undefined` when the
 *  platform has no adapter menu or the style name isn't registered.  Powers
 *  the validator's R3 style↔layout compatibility check without dereferencing
 *  the live `StyleAdapter` object. */
export function styleSupportedLayouts(
  platform: Platform,
  styleKey: string,
): readonly string[] | undefined {
  return metaFor(platform)?.styleSupportedLayouts[styleKey];
}
