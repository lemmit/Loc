// ---------------------------------------------------------------------------
// LayoutAdapter — the per-(platform × file-layout) routing slot.
//
// Layouts decide the on-disk shape of the generated project: `byLayer`
// puts every controller under `Controllers/`, every repository under
// `Infrastructure/`, …; `byFeature` colocates each aggregate's
// controller / handler / repository under `Features/<Aggregate>/`.
// Decoupled from `StyleAdapter` because the same style (cqrs) renders
// into either layout without changing its emission shape — only the
// destination paths shift.
// ---------------------------------------------------------------------------

import type { EmitCtx, EmittedArtifact } from "./types.js";

export interface LayoutAdapter {
  /** Registry key — `layout: <name>` resolves to this entry. */
  readonly name: string;
  /** Map a logical artifact (named by its emitter) to its
   *  deployable-relative destination path.  Pure — every call with
   *  the same args returns the same path so emit ordering doesn't
   *  matter. */
  pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string;
}

/** Capability subset a stub still answers at registration time. */
export type LayoutCapabilities = Pick<LayoutAdapter, "name">;
