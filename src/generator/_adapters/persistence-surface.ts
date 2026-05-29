// ---------------------------------------------------------------------------
// PersistenceAdapter — the per-(platform × storage type) emitter slot.
//
// One adapter per concrete persistence library each platform ships
// (`efcore` and `dapper` on .NET; `drizzle` and `prisma` on Node;
// `ash-postgres` on Phoenix; …).  The validator reads `supports(...)`
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
  AggregateIR,
  DataSourceIR,
  DataSourceKind,
  PersistenceStrategy,
  StorageIR,
  StorageKind,
} from "../../ir/types/loom-ir.js";
import type { EmitCtx, Lines } from "./types.js";

/** Saving shape of an aggregate's materialised read model / snapshot
 *  (D-DOCUMENT-AXIS, the `normalised` axis).  `normalised` = relational
 *  tables (the default); `document` = one JSON document. */
export type SavingShape = "normalised" | "document";

export interface PersistenceAdapter {
  /** Registry key — what `persistence: <name>` in source resolves
   *  this adapter against.  Always lowercase / kebab-case. */
  readonly name: string;
  /** Aggregate persistence strategies this library can host. */
  readonly supportedStrategies: readonly PersistenceStrategy[];
  /** Saving shapes this adapter can emit (D-DOCUMENT-AXIS).  Omitted ⇒
   *  `["normalised"]` (relational only).  An adapter advertising
   *  `"document"` can emit a `normalised(false)` binding as a single
   *  JSON document; the orchestrator routes the binding to that
   *  adapter's document branch and the validator's "no document emitter
   *  yet" warning stands down. */
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
   *  entries for Node, `mix.exs` deps for Phoenix). */
  emitProjectDeps(ctx: EmitCtx): Lines;
  /** Bootstrap lines spliced into the deployable's startup —
   *  `DbContext` registration, connection-pool init, etc.  Receives
   *  every physical storage the deployable's dataSources resolve to. */
  emitConnectionSetup(physicalStores: readonly StorageIR[], ctx: EmitCtx): Lines;
  /** A single repository class / module for one aggregate, routed
   *  through the logical binding (`DataSourceIR`) that resolved to
   *  this adapter.  The `logical` arg carries the per-binding config
   *  (`schema`, `tablePrefix`, `every`, `retain`, `ttl`, …). */
  emitRepository(agg: AggregateIR, logical: DataSourceIR, ctx: EmitCtx): Lines;
  /** DDL / EF migration body for every aggregate the adapter hosts
   *  on the given physical stores.  Return `null` when the adapter
   *  delegates schema management elsewhere (e.g. Ash auto-migrate). */
  emitMigrations(
    aggs: readonly AggregateIR[],
    physicalStores: readonly StorageIR[],
    ctx: EmitCtx,
  ): Lines | null;
  /** Transactional outbox writer + dispatcher for any aggregate that
   *  publishes integration events.  Return `null` when the adapter
   *  declines to emit one — the validator runs first, so reaching
   *  this point on `publish: integration | both` is treated as a
   *  capability gap, not silent success. */
  emitOutbox(physical: StorageIR, aggs: readonly AggregateIR[], ctx: EmitCtx): Lines | null;
}

/** Capability subset a stub still answers at registration time.  Used
 *  by `stubPersistenceAdapter` and the registry's lookup tests. */
export type PersistenceCapabilities = Pick<
  PersistenceAdapter,
  "name" | "supportedStrategies" | "supports"
>;
