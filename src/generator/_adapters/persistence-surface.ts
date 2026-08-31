// ---------------------------------------------------------------------------
// PersistenceAdapter — the per-(platform × storage type) emitter slot.
//
// One adapter per concrete persistence library each platform ships
// (`efcore` and `dapper` on .NET; `drizzle` and `mikroorm` on Node;
// `ecto` on Phoenix; …).  The adapter carries the registry key and the
// project-level dependency lines; the orchestrator calls the underlying
// emitters directly.
// ---------------------------------------------------------------------------

import type { EmitCtx, Lines } from "./types.js";

export interface PersistenceAdapter {
  /** Registry key — what `persistence: <name>` in source resolves
   *  this adapter against.  Always lowercase / kebab-case. */
  readonly name: string;
  /** Project-level dependency lines spliced into the deployable's
   *  manifest (`<PackageReference …/>` rows for .NET, `dependencies`
   *  entries for Node, `mix.exs` deps for Phoenix).  The one LIVE emit
   *  method — consumed by the hono v4 backend (`hono/v4/emit.ts`). */
  emitProjectDeps(ctx: EmitCtx): Lines;
  // NOTE: this surface deliberately carries NO heavy emit methods
  // (emitConnectionSetup / emitRepository / emitMigrations / emitOutbox) and no
  // capability declarations (`supports()` / `supportedShapes` /
  // `supportedStrategies`).  The persistence seam lives INSIDE each backend's
  // emitters, not behind the adapter registry (see
  // docs/new-plan/missions/M-T9.2-persistence-seam-design.md §0.7/§2.5): each
  // orchestrator calls the underlying emitters directly, so an emit method here
  // would sit on no production path.
  //
  // The checks a capability declaration would claim to serve already live
  // elsewhere, against a different source of truth:
  //   - the per-`dataSource` kind↔storage check is `checkDataSource`
  //     (language/validators/datasource.ts), driven by the sourceType registry
  //     in `util/source-types.ts`;
  //   - the `shape: …` check is `validateSavingShapeSupport`, driven by
  //     `PLATFORM_SAVING_SHAPES` (util/platform-axes.ts), keyed by PLATFORM
  //     rather than by adapter.
  // An unread declaration here would just drift from those — and a test
  // asserting it equals itself would keep the drift green.
  //
  // Contrast `StyleAdapter.supportedLayouts`, which IS live — it reaches the
  // validator through the adapter-metadata mirror.  See style-surface.ts.
}

/** Capability subset a stub still answers at registration time.  Used
 *  by `stubPersistenceAdapter` and the registry's lookup tests. */
export type PersistenceCapabilities = Pick<PersistenceAdapter, "name">;
