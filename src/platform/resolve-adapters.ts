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
