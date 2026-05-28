// Public surface of the adapter contracts.  Importers reach for these
// from the platform registry (`src/platform/registry.ts`) and from
// per-platform adapter implementations (`src/generator/<platform>/...`).

export type {
  LayoutAdapter,
  LayoutCapabilities,
} from "./layout-surface.js";
export {
  type AdapterKind,
  AdapterNotImplementedError,
  stubAdapter,
} from "./not-implemented.js";
export type {
  PersistenceAdapter,
  PersistenceCapabilities,
} from "./persistence-surface.js";
export type {
  LayoutShape,
  StyleAdapter,
  StyleCapabilities,
} from "./style-surface.js";
export type { EmitCtx, EmittedArtifact, Lines } from "./types.js";
