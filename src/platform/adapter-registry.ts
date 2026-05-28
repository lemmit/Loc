// ---------------------------------------------------------------------------
// Adapter registry — the per-platform menu of `persistence` / `style` /
// `layout` adapters.  Sits alongside (not inside) `registry.ts` because
// the adapter contracts live in `src/generator/_adapters/`, and the
// system orchestrator / validator look them up by (platform, kind, name).
//
// Every platform's `defaults.<kind>` answers what `persistence: <missing>`
// / `style: <missing>` / `layout: <missing>` resolves to when source
// doesn't pin a specific name — so the existing bareword `platform: hono`
// / `platform: dotnet` keeps working out of the box.
//
// Today F3 lands ONLY the stub menus.  F5 / F6 / F7 then move each
// backend's existing emitter into the right `persistence/<name>/`,
// `styles/<name>/`, `layouts/<name>/` subdirectory and registers them
// here as REAL adapters in place of the stubs.  Existing emit goes
// byte-identical until those refactors land.
// ---------------------------------------------------------------------------

import {
  AdapterNotImplementedError,
  type LayoutAdapter,
  type PersistenceAdapter,
  type StyleAdapter,
  stubAdapter,
} from "../generator/_adapters/index.js";
import { efcorePersistenceAdapter } from "../generator/dotnet/adapters/efcore-persistence.js";
import type { Platform } from "../ir/types/loom-ir.js";

/** Per-platform adapter menu — every supported adapter, keyed by its
 *  registry name.  Stub entries throw `AdapterNotImplementedError` on
 *  any `emit*` call. */
export interface PlatformAdapters {
  persistence: Record<string, PersistenceAdapter>;
  styles: Record<string, StyleAdapter>;
  layouts: Record<string, LayoutAdapter>;
}

/** Defaults a platform falls back to when the source doesn't pin one
 *  via `persistence:` / `style:` / `layout:`. */
export interface PlatformAdapterDefaults {
  persistence: { stateBased: string; eventSourced: string };
  style: string;
  layout: string;
}

interface PlatformAdapterEntry {
  adapters: PlatformAdapters;
  defaults: PlatformAdapterDefaults;
}

// ---------------------------------------------------------------------------
// Stub menus — every platform claims its slots upfront so the
// registry-lookup test can verify `persistence: dapper` resolves to a
// throwing-but-typed adapter today.  Real adapters replace these
// entries in F5 / F6 / F7.
// ---------------------------------------------------------------------------

function persistenceNames(entry: PlatformAdapterEntry | undefined): string[] {
  return entry ? Object.keys(entry.adapters.persistence) : [];
}
function styleNames(entry: PlatformAdapterEntry | undefined): string[] {
  return entry ? Object.keys(entry.adapters.styles) : [];
}
function layoutNames(entry: PlatformAdapterEntry | undefined): string[] {
  return entry ? Object.keys(entry.adapters.layouts) : [];
}

const adapterMenus: Partial<Record<Platform, PlatformAdapterEntry>> = {};

// `.NET` — EF Core + Dapper + Marten persistence; CQRS + layered style;
// byLayer + byFeature layout.  `efcore` is the REAL adapter (F5a)
// wrapping the existing dotnet emit fns; `cqrs` + `byLayer` are the
// next slices (F5b / F5c).  Today's pipeline still calls the emit fns
// directly; the future orchestrator rewire dispatches through these.
adapterMenus.dotnet = {
  adapters: {
    persistence: {
      efcore: efcorePersistenceAdapter,
      dapper: stubAdapter<PersistenceAdapter>(
        "persistence",
        "dapper",
        "dotnet",
        () => persistenceNames(adapterMenus.dotnet),
        {
          name: "dapper",
          supportedStrategies: ["stateBased"],
          supports: (type, kind, strategy) =>
            strategy === "stateBased" &&
            ["postgres", "mysql", "sqlite"].includes(type) &&
            ["state", "snapshot", "replica"].includes(kind),
        },
      ),
      marten: stubAdapter<PersistenceAdapter>(
        "persistence",
        "marten",
        "dotnet",
        () => persistenceNames(adapterMenus.dotnet),
        {
          name: "marten",
          supportedStrategies: ["stateBased", "eventSourced"],
          supports: (type) => type === "postgres",
        },
      ),
    },
    styles: {
      cqrs: stubAdapter<StyleAdapter>(
        "style",
        "cqrs",
        "dotnet",
        () => styleNames(adapterMenus.dotnet),
        {
          name: "cqrs",
          supportedStrategies: ["stateBased", "eventSourced"],
          supportedLayouts: ["byLayer", "byFeature"],
        },
      ),
      layered: stubAdapter<StyleAdapter>(
        "style",
        "layered",
        "dotnet",
        () => styleNames(adapterMenus.dotnet),
        {
          name: "layered",
          supportedStrategies: ["stateBased"],
          supportedLayouts: ["byLayer"],
        },
      ),
    },
    layouts: {
      byLayer: stubAdapter<LayoutAdapter>(
        "layout",
        "byLayer",
        "dotnet",
        () => layoutNames(adapterMenus.dotnet),
        { name: "byLayer" },
      ),
      byFeature: stubAdapter<LayoutAdapter>(
        "layout",
        "byFeature",
        "dotnet",
        () => layoutNames(adapterMenus.dotnet),
        { name: "byFeature" },
      ),
    },
  },
  defaults: {
    persistence: { stateBased: "efcore", eventSourced: "marten" },
    style: "cqrs",
    layout: "byLayer",
  },
};

// `hono` — the Node backend.  Existing emitter is a hand-rolled
// drizzle + postgres + per-aggregate routes setup; the F6 seam
// refactor + `platform: hono` → `platform: node { framework: hono }`
// rename lands the real adapter wiring.
adapterMenus.hono = {
  adapters: {
    persistence: {
      drizzle: stubAdapter<PersistenceAdapter>(
        "persistence",
        "drizzle",
        "hono",
        () => persistenceNames(adapterMenus.hono),
        {
          name: "drizzle",
          supportedStrategies: ["stateBased"],
          supports: (type, kind, strategy) =>
            strategy === "stateBased" &&
            ["postgres", "mysql", "sqlite"].includes(type) &&
            ["state", "snapshot", "replica"].includes(kind),
        },
      ),
      prisma: stubAdapter<PersistenceAdapter>(
        "persistence",
        "prisma",
        "hono",
        () => persistenceNames(adapterMenus.hono),
        {
          name: "prisma",
          supportedStrategies: ["stateBased"],
          supports: (type, kind, strategy) =>
            strategy === "stateBased" &&
            ["postgres", "mysql", "sqlite"].includes(type) &&
            ["state", "snapshot", "replica"].includes(kind),
        },
      ),
    },
    styles: {
      layered: stubAdapter<StyleAdapter>(
        "style",
        "layered",
        "hono",
        () => styleNames(adapterMenus.hono),
        {
          name: "layered",
          supportedStrategies: ["stateBased"],
          supportedLayouts: ["byLayer"],
        },
      ),
      cqrs: stubAdapter<StyleAdapter>(
        "style",
        "cqrs",
        "hono",
        () => styleNames(adapterMenus.hono),
        {
          name: "cqrs",
          supportedStrategies: ["stateBased"],
          supportedLayouts: ["byLayer", "byFeature"],
        },
      ),
    },
    layouts: {
      byLayer: stubAdapter<LayoutAdapter>(
        "layout",
        "byLayer",
        "hono",
        () => layoutNames(adapterMenus.hono),
        { name: "byLayer" },
      ),
      byFeature: stubAdapter<LayoutAdapter>(
        "layout",
        "byFeature",
        "hono",
        () => layoutNames(adapterMenus.hono),
        { name: "byFeature" },
      ),
    },
  },
  defaults: {
    persistence: { stateBased: "drizzle", eventSourced: "drizzle" },
    style: "layered",
    layout: "byLayer",
  },
};

// `phoenixLiveView` — fullstack Elixir + Ash + LiveView.  Ash owns
// both persistence + style (the Ash action surface), so the menu has
// a single ash-postgres persistence + an `ash` style + a default
// `byFeature` layout (Phoenix's stock layout is feature-shaped).
adapterMenus.phoenixLiveView = {
  adapters: {
    persistence: {
      ashPostgres: stubAdapter<PersistenceAdapter>(
        "persistence",
        "ashPostgres",
        "phoenixLiveView",
        () => persistenceNames(adapterMenus.phoenixLiveView),
        {
          name: "ashPostgres",
          supportedStrategies: ["stateBased"],
          supports: (type, kind, strategy) =>
            strategy === "stateBased" &&
            type === "postgres" &&
            ["state", "snapshot", "replica"].includes(kind),
        },
      ),
    },
    styles: {
      ash: stubAdapter<StyleAdapter>(
        "style",
        "ash",
        "phoenixLiveView",
        () => styleNames(adapterMenus.phoenixLiveView),
        {
          name: "ash",
          supportedStrategies: ["stateBased"],
          supportedLayouts: ["byFeature"],
        },
      ),
    },
    layouts: {
      byFeature: stubAdapter<LayoutAdapter>(
        "layout",
        "byFeature",
        "phoenixLiveView",
        () => layoutNames(adapterMenus.phoenixLiveView),
        { name: "byFeature" },
      ),
    },
  },
  defaults: {
    persistence: { stateBased: "ashPostgres", eventSourced: "ashPostgres" },
    style: "ash",
    layout: "byFeature",
  },
};

// Frontend platforms (`react`, `static`) carry no domain code and
// therefore no persistence / style / layout adapters — they version
// via the design-pack axis instead.  The lookup helpers below treat
// `undefined` entries as "frontend / unknown" and surface a clean
// error to callers that try to resolve adapters against them.

// ---------------------------------------------------------------------------
// Public lookup
// ---------------------------------------------------------------------------

/** True when `platform` has an adapter menu registered (i.e. backend). */
export function hasAdapters(platform: Platform): boolean {
  return platform in adapterMenus;
}

/** Adapter menu for a platform, or undefined for frontend / unknown. */
export function adaptersFor(platform: Platform): PlatformAdapters | undefined {
  return adapterMenus[platform]?.adapters;
}

/** Defaults for a platform, or undefined for frontend / unknown. */
export function defaultsFor(platform: Platform): PlatformAdapterDefaults | undefined {
  return adapterMenus[platform]?.defaults;
}

/** Resolve a persistence adapter by platform + name.  Falls back to
 *  the platform's default (per persistence strategy) when `name` is
 *  null / undefined / empty.  Throws AdapterNotImplementedError if
 *  the named adapter isn't in the menu.
 *
 *  Pure lookup — does not invoke any `emit*` method, so stubs return
 *  cleanly (their capability fields answer; only emit throws). */
export function resolvePersistence(
  platform: Platform,
  name: string | null | undefined,
  strategy: "stateBased" | "eventSourced" = "stateBased",
): PersistenceAdapter {
  const entry = adapterMenus[platform];
  if (!entry) {
    throw new AdapterNotImplementedError("persistence", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : entry.defaults.persistence[strategy];
  const adapter = entry.adapters.persistence[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError(
      "persistence",
      resolved,
      platform,
      Object.keys(entry.adapters.persistence),
    );
  }
  return adapter;
}

export function resolveStyle(platform: Platform, name: string | null | undefined): StyleAdapter {
  const entry = adapterMenus[platform];
  if (!entry) {
    throw new AdapterNotImplementedError("style", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : entry.defaults.style;
  const adapter = entry.adapters.styles[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError(
      "style",
      resolved,
      platform,
      Object.keys(entry.adapters.styles),
    );
  }
  return adapter;
}

export function resolveLayout(platform: Platform, name: string | null | undefined): LayoutAdapter {
  const entry = adapterMenus[platform];
  if (!entry) {
    throw new AdapterNotImplementedError("layout", name ?? "<default>", platform, []);
  }
  const resolved = name && name.length > 0 ? name : entry.defaults.layout;
  const adapter = entry.adapters.layouts[resolved];
  if (!adapter) {
    throw new AdapterNotImplementedError(
      "layout",
      resolved,
      platform,
      Object.keys(entry.adapters.layouts),
    );
  }
  return adapter;
}
