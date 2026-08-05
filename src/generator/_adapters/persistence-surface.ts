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
  // NOTE: the heavy emit methods (emitConnectionSetup / emitRepository /
  // emitMigrations / emitOutbox) were removed (M-T9.2 / M-T6.10 residue).
  // They were never invoked on the production emit path — each backend's
  // orchestrator calls the underlying emitters directly — and were
  // scaffolding for a "route the orchestrator through the adapter registry"
  // rewire that the M-T9.2 conclusion superseded (the persistence seam lives
  // INSIDE each backend's emitters, not behind the adapter registry — see
  // docs/new-plan/missions/M-T9.2-persistence-seam-design.md §0.7/§2.5).
  //
  // The capability half (`supports()` / `supportedShapes` /
  // `supportedStrategies`) was removed for the same reason, one level down:
  // it was read by NOTHING in src/ (only by tests asserting a declaration
  // equalled itself), while each check it claimed to serve was already
  // implemented elsewhere, against a different source of truth —
  //   - the per-`dataSource` kind↔storage check `supports()` documented is
  //     `checkDataSource` (language/validators/datasource.ts), driven by the
  //     sourceType registry in `util/source-types.ts`;
  //   - the `shape: …` check `supportedShapes` documented is
  //     `validateSavingShapeSupport`, driven by `PLATFORM_SAVING_SHAPES`
  //     (util/platform-axes.ts), keyed by PLATFORM rather than by adapter.
  // Being unread, they also drifted: `dapper` advertised
  // `supportedShapes: ["relational"]` long after M-T6.9 gave it document +
  // embedded emission, with a test pinning the false value green.
  //
  // Contrast `StyleAdapter.supportedLayouts`, which is NOT dead — it reaches
  // the validator through the adapter-metadata mirror.  See style-surface.ts.
}

/** Capability subset a stub still answers at registration time.  Used
 *  by `stubPersistenceAdapter` and the registry's lookup tests. */
export type PersistenceCapabilities = Pick<PersistenceAdapter, "name">;
