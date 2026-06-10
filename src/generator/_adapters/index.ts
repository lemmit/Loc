// Public surface of the adapter contracts.  Importers reach for these
// from the platform registry (`src/platform/registry.ts`) and from
// per-platform adapter implementations (`src/generator/<platform>/...`).

import type { LayoutAdapter } from "./layout-surface.js";
import type { PersistenceAdapter } from "./persistence-surface.js";
import type { RuntimeAdapter } from "./runtime-surface.js";
import type { StyleAdapter } from "./style-surface.js";
import type { TransportAdapter } from "./transport-surface.js";

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
  RuntimeAdapter,
  RuntimeCapabilities,
} from "./runtime-surface.js";
export type {
  LayoutShape,
  StyleAdapter,
  StyleCapabilities,
} from "./style-surface.js";
export type {
  TransportAdapter,
  TransportCapabilities,
} from "./transport-surface.js";
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
  /** HTTP surface (`transport:` axis).  Thin today — one real transport
   *  per backend (the per-transport emit is future work); the menu may
   *  carry reserved stubs (`controllers` on dotnet). */
  transports: Record<string, TransportAdapter>;
  /** Aggregate execution model (`runtime:` axis).  Thin today — every
   *  backend ships `transactional`; actor runtimes (`genserver` /
   *  `orleans` / `akka`) are registered as reserved stubs. */
  runtimes: Record<string, RuntimeAdapter>;
}

/** Defaults a platform falls back to when the source doesn't pin one
 *  via `persistence:` / `style:` / `layout:` / `transport:` / `runtime:`. */
export interface PlatformAdapterDefaults {
  persistence: { state: string; eventLog: string };
  style: string;
  layout: string;
  transport: string;
  runtime: string;
}
