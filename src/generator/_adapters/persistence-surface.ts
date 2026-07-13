// ---------------------------------------------------------------------------
// PersistenceAdapter — the per-(platform × storage type) emitter slot.
//
// One adapter per concrete persistence library each platform ships
// (`efcore` and `dapper` on .NET; `drizzle` and `mikroorm` on Node;
// `ecto` on Phoenix; …).  The validator reads `supports(...)`
// to enforce capability rules at the language layer; the orchestrator
// calls the `emit*` methods to produce repositories / migrations /
// outbox writers / connection setup.
//
// Aligns with the IR names from PR-3:
//   - `StorageKind`        — physical store type (postgres, redis, …)
//   - `DataSourceKind`     — logical kind (state, eventLog, snapshot, …)
//   - `StorageIR`          — physical storage declaration
//   - `DataSourceIR`       — logical (context, kind) → physical binding
//   - `PersistenceStrategy` — aggregate's `stateBased` vs `eventSourced`
// ---------------------------------------------------------------------------

import type {
  DataSourceKind,
  PersistenceStrategy,
  SavingShape,
  StorageKind,
} from "../../ir/types/loom-ir.js";
import type { EmitCtx, Lines } from "./types.js";

// `SavingShape` (the `shape(relational | embedded | document)` axis) is
// defined canonically in the IR layer; re-exported here so adapter
// authors import it from the persistence surface alongside
// `PersistenceAdapter`.
export type { SavingShape };

export interface PersistenceAdapter {
  /** Registry key — what `persistence: <name>` in source resolves
   *  this adapter against.  Always lowercase / kebab-case. */
  readonly name: string;
  /** Aggregate persistence strategies this library can host. */
  readonly supportedStrategies: readonly PersistenceStrategy[];
  /** Saving shapes this adapter can emit (D-DOCUMENT-AXIS).  Omitted ⇒
   *  `["relational"]` only.  An adapter advertising `"embedded"` /
   *  `"document"` can host a `shape(embedded)` / `shape(document)`
   *  aggregate; the validator rejects a `shape(…)` the target backend
   *  doesn't list. */
  readonly supportedShapes?: readonly SavingShape[];
  /** Per-binding capability check.  The validator calls this for
   *  every `dataSource X { for:, kind:, use: }` to reject obviously
   *  wrong combinations (e.g. routing an `eventLog` to redis through
   *  an EF Core adapter) before emission. */
  supports(
    storageType: StorageKind,
    kind: DataSourceKind,
    persistenceStrategy: PersistenceStrategy,
  ): boolean;
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
  // docs/new-plan/missions/M-T9.2-persistence-seam-design.md §0.7/§2.5). The
  // live capability half (name / supportedStrategies / supportedShapes /
  // supports) + emitProjectDeps + the menu/defaults are unchanged.
}

/** Capability subset a stub still answers at registration time.  Used
 *  by `stubPersistenceAdapter` and the registry's lookup tests. */
export type PersistenceCapabilities = Pick<
  PersistenceAdapter,
  "name" | "supportedStrategies" | "supports"
>;
