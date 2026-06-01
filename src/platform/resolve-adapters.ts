// ---------------------------------------------------------------------------
// Adapter resolution — reads each backend's persistence / style / layout
// adapter menu off its discovered `PlatformSurface` (`adapters()` /
// `adapterDefaults()`), rather than a central static registry.  Replaces
// the former `src/platform/adapter-registry.ts` per D-ADAPTER-HOME
// (`docs/decisions.md`): no central cross-backend fan-in, so a backend
// can relocate into `packages/` without a `core → package` edge.
//
// Frontend platforms (`react` / `static`) carry no adapters — their
// surfaces omit both methods, and the lookups below surface a clean
// `AdapterNotImplementedError` for callers that try to resolve against
// them.
//
// Lives in `src/platform/` (consumed by the validator + the adapter
// tests) — never imported by `src/generator/`, so the `package → shared`
// layering invariant (`test/platform/backend-packages-layering.test.ts`)
// holds.
// ---------------------------------------------------------------------------

import {
  ADAPTER_IS_STUB,
  AdapterNotImplementedError,
  type LayoutAdapter,
  type PersistenceAdapter,
  type PlatformAdapterDefaults,
  type PlatformAdapters,
  type StyleAdapter,
} from "../generator/_adapters/index.js";
import type { Platform } from "../ir/types/loom-ir.js";
import { platformFor } from "./registry.js";

/** True when `platform` exposes an adapter menu (i.e. a backend). */
export function hasAdapters(platform: Platform): boolean {
  return platformFor(platform).adapters !== undefined;
}

/** Adapter menu for a platform, or undefined for frontend / unknown. */
export function adaptersFor(platform: Platform): PlatformAdapters | undefined {
  return platformFor(platform).adapters?.();
}

/** Defaults for a platform, or undefined for frontend / unknown. */
export function defaultsFor(platform: Platform): PlatformAdapterDefaults | undefined {
  return platformFor(platform).adapterDefaults?.();
}

/** The DSL-selectable adapter names for one axis on a platform — i.e. the
 *  REAL (implemented) adapters only, stubs excluded.  Pure lookup: reads
 *  capability fields off the menu, never invokes an `emit*` method (so no
 *  stub throws).  Powers the validator's realization-axis menu
 *  (D-REALIZATION-AXES R1): a stub key parses but must be rejected with
 *  "reserved but not yet implemented", not silently accepted.  Returns
 *  `[]` for frontend / unknown platforms (no adapter menu). */
export function availableAdapterNames(
  platform: Platform,
  kind: "persistence" | "style" | "layout",
): string[] {
  const adapters = adaptersFor(platform);
  if (!adapters) return [];
  const bag: Record<string, object> =
    kind === "persistence"
      ? adapters.persistence
      : kind === "style"
        ? adapters.styles
        : adapters.layouts;
  return Object.entries(bag)
    .filter(([, adapter]) => (adapter as Record<symbol, unknown>)[ADAPTER_IS_STUB] !== true)
    .map(([name]) => name)
    .sort();
}

/** Every adapter name in a platform's menu for one axis — REAL and STUB.
 *  Used to distinguish "reserved but unimplemented" (a registered stub)
 *  from "unknown" in validator diagnostics.  `[]` for frontends. */
export function allAdapterNames(
  platform: Platform,
  kind: "persistence" | "style" | "layout",
): string[] {
  const adapters = adaptersFor(platform);
  if (!adapters) return [];
  const bag =
    kind === "persistence"
      ? adapters.persistence
      : kind === "style"
        ? adapters.styles
        : adapters.layouts;
  return Object.keys(bag).sort();
}

/** Resolve a persistence adapter by platform + name.  Falls back to the
 *  platform's default (per persistence strategy) when `name` is null /
 *  undefined / empty.  Throws AdapterNotImplementedError if the named
 *  adapter isn't in the menu.
 *
 *  Pure lookup — does not invoke any `emit*` method, so stubs return
 *  cleanly (their capability fields answer; only emit throws). */
export function resolvePersistence(
  platform: Platform,
  name: string | null | undefined,
  strategy: "state" | "eventLog" = "state",
): PersistenceAdapter {
  const surface = platformFor(platform);
  const adapters = surface.adapters?.();
  const defaults = surface.adapterDefaults?.();
  if (!adapters || !defaults) {
    throw new AdapterNotImplementedError("persistence", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : defaults.persistence[strategy];
  const adapter = adapters.persistence[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError(
      "persistence",
      resolved,
      platform,
      Object.keys(adapters.persistence),
    );
  }
  return adapter;
}

export function resolveStyle(platform: Platform, name: string | null | undefined): StyleAdapter {
  const surface = platformFor(platform);
  const adapters = surface.adapters?.();
  const defaults = surface.adapterDefaults?.();
  if (!adapters || !defaults) {
    throw new AdapterNotImplementedError("style", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : defaults.style;
  const adapter = adapters.styles[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError("style", resolved, platform, Object.keys(adapters.styles));
  }
  return adapter;
}

export function resolveLayout(platform: Platform, name: string | null | undefined): LayoutAdapter {
  const surface = platformFor(platform);
  const adapters = surface.adapters?.();
  const defaults = surface.adapterDefaults?.();
  if (!adapters || !defaults) {
    throw new AdapterNotImplementedError("layout", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : defaults.layout;
  const adapter = adapters.layouts[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError(
      "layout",
      resolved,
      platform,
      Object.keys(adapters.layouts),
    );
  }
  return adapter;
}
