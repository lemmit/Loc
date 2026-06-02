// ---------------------------------------------------------------------------
// Shared types every adapter (PersistenceAdapter / StyleAdapter /
// LayoutAdapter) consumes.  Pure type-only module — no runtime imports.
//
// `EmitCtx` is the read-only bag every adapter method receives.  We thread
// the same three pieces of context every platform's `emitProject` already
// gets (deployable / contexts / sys), plus the per-deployable migration
// slice — backends can read whatever they need without expanding the
// signature.  Additional cross-cutting fields (observability switches,
// per-deployable wire-spec, etc.) slot in here as they become shared.
// ---------------------------------------------------------------------------

import type { DeployableIR, EnrichedBoundedContextIR, SystemIR } from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import type { LayoutAdapter } from "./layout-surface.js";
import type { StyleAdapter } from "./style-surface.js";

/** Lines emitter result — same shape every existing emitter already
 *  returns via `code-builder.lines(...)`. */
export type Lines = readonly string[];

/** A produced file plus its emitted path, returned by style adapters'
 *  `emitHandlerOrService(op)` so the orchestrator can place each
 *  emitted artifact under the platform's chosen layout. */
export interface EmittedArtifact {
  /** Logical name the layout adapter routes to a file path.  Examples:
   *   - `OrderRepository.cs` (a class)
   *   - `place-order-handler.ts` (a function module)
   *  Layout adapters map this to the final deployable-relative path. */
  name: string;
  /** Emitted source contents. */
  content: string;
  /** Optional category the layout adapter may key on (e.g. `"handler"`
   *  vs `"endpoint"`) when the same logical artifact has multiple
   *  emit paths under different layouts. */
  category?: string;
}

/** Read-only context every adapter method receives.  Mirrors the shape
 *  `PlatformSurface.emitProject` already takes — no new IR shape needed. */
export interface EmitCtx {
  deployable: DeployableIR;
  contexts: EnrichedBoundedContextIR[];
  sys: SystemIR;
  /** Per-deployable migration slices — same wire as `emitProject`. */
  migrations?: MigrationsIR[];
  /** Generate-time observability switch — when true, emit trace-level
   *  domain instrumentation. */
  emitTrace?: boolean;
  /** The deployable's resolved STYLE adapter (`application:` axis →
   *  D-REALIZATION-AXES).  Resolved once at the system orchestrator from
   *  `deployable.application` via `resolveStyle` and threaded down, so a
   *  per-deployable selection takes effect.  Absent in legacy
   *  single-context generate mode (no system orchestrator) — call sites
   *  fall back to the backend's hardcoded default sibling, keeping output
   *  byte-identical.  With today's size-1 real menus the resolved adapter
   *  IS that default. */
  styleAdapter?: StyleAdapter;
  /** The deployable's resolved LAYOUT adapter (`directoryLayout:` axis).
   *  Resolved from `deployable.directoryLayout` via `resolveLayout`; same
   *  fallback discipline as `styleAdapter`. */
  layoutAdapter?: LayoutAdapter;
}
