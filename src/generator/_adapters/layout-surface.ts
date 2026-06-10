// ---------------------------------------------------------------------------
// LayoutAdapter — the per-(platform × file-layout) routing slot.
//
// Layouts decide the on-disk shape of the generated project: `byLayer`
// puts every controller under `Controllers/`, every repository under
// `Infrastructure/`, …; `byFeature` colocates each aggregate's
// controller / handler / repository under `Features/<Plural>/`.
// Decoupled from `StyleAdapter` because the same style (cqrs) renders
// into either layout without changing its emission shape — only the
// destination paths shift.  (Language-level reference fixups that a
// relocation entails stay OUTSIDE this contract, as platform-local
// post-emit passes over the final file map: relative-import rewriting
// on TS (`typescript/layout-imports.ts`), namespace rewriting on
// dotnet (`dotnet/layout-namespaces.ts`).)
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
