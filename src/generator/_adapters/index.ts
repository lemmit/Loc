// Public surface of the adapter contracts.  Importers reach for these
// from the platform registry (`src/platform/registry.ts`) and from
// per-platform adapter implementations (`src/generator/<platform>/...`).

import type { LayoutAdapter } from "./layout-surface.js";
import type { PersistenceAdapter } from "./persistence-surface.js";
import type { StyleAdapter } from "./style-surface.js";

export type {
  LayoutAdapter,
  LayoutCapabilities,
} from "./layout-surface.js";
export {
  ADAPTER_IS_STUB,
  type AdapterKind,
  AdapterNotImplementedError,
  stubAdapter,
} from "./not-implemented.js";
export type {
  PersistenceAdapter,
  PersistenceCapabilities,
  SavingShape,
} from "./persistence-surface.js";
export type {
  ResourceAdapter,
  ResourceCapabilities,
} from "./resource-surface.js";
export type {
  LayoutShape,
  StyleAdapter,
  StyleCapabilities,
} from "./style-surface.js";
export type { EmitCtx, EmittedArtifact, Lines } from "./types.js";

/** Per-platform adapter menu — every supported adapter, keyed by its
 *  registry name.  Stub entries throw `AdapterNotImplementedError` on
 *  any `emit*` call.  Carried on each backend's `PlatformSurface`
 *  (`adapters()`), not a central registry — see D-ADAPTER-HOME in
 *  `docs/decisions.md`. */
export interface PlatformAdapters {
  persistence: Record<string, PersistenceAdapter>;
  styles: Record<string, StyleAdapter>;
  layouts: Record<string, LayoutAdapter>;
}

/** Defaults a platform falls back to when the source doesn't pin one
 *  via `persistence:` / `directoryLayout:`.  (`style` is the single
 *  per-backend emission style — no longer user-selectable.) */
export interface PlatformAdapterDefaults {
  persistence: { state: string; eventLog: string };
  style: string;
  layout: string;
}
