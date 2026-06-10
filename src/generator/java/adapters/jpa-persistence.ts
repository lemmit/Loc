// ---------------------------------------------------------------------------
// jpa — the real PersistenceAdapter for the java platform: Spring Data
// JPA over Hibernate against Postgres.  Capability answers (supports /
// supportedStrategies / supportedShapes) are live from day one — they
// drive the language-layer dataSource validation; the emit methods fill
// in across the persistence slices of the java backend plan (the
// orchestrator calls the underlying emit fns directly, mirroring how
// dotnet's efcore adapter wraps its emitters).
// ---------------------------------------------------------------------------

import type { AggregateIR, DataSourceIR, StorageIR } from "../../../ir/types/loom-ir.js";
import { PLATFORM_SAVING_SHAPES } from "../../../util/platform-axes.js";
import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";

export const jpaPersistenceAdapter: PersistenceAdapter = {
  name: "jpa",
  supportedStrategies: ["state", "eventLog"],
  // Sourced from the single capability map so the adapter advertisement
  // and the validator never drift (java starts relational-only).
  supportedShapes: PLATFORM_SAVING_SHAPES.java,

  supports(storageType, kind, persistenceStrategy) {
    // Event-sourced streams: an append-only `<agg>_events` table on the
    // same relational store, folded at load (the EF Core approach — no
    // dedicated event-store library).
    if (persistenceStrategy === "eventLog") {
      return ["postgres", "mysql", "sqlite"].includes(storageType) && kind === "eventLog";
    }
    return (
      persistenceStrategy === "state" &&
      ["postgres", "mysql", "sqlite", "inMemory"].includes(storageType) &&
      ["state", "snapshot", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    // spring-boot-starter-data-jpa + the Postgres driver ship in the
    // base pom (renderPom) — JPA is the default persistence and the
    // skeleton already boots against it, so there is nothing extra to
    // splice per-deployable.
    return [];
  },

  emitConnectionSetup(_physicalStores: readonly StorageIR[], _ctx: EmitCtx): Lines {
    // Spring Boot auto-configures the DataSource + EntityManagerFactory
    // from `spring.datasource.*` (application.yml) — no bootstrap lines.
    return [];
  },

  emitRepository(_agg: AggregateIR, _logical: DataSourceIR, _ctx: EmitCtx): Lines {
    // Repository emission routes through the orchestrator's emit fns
    // (persistence slice of the java backend plan).
    return [];
  },

  emitMigrations(
    _aggs: readonly AggregateIR[],
    _physicalStores: readonly StorageIR[],
    _ctx: EmitCtx,
  ): Lines | null {
    // Flyway-style versioned SQL is emitted from `MigrationsIR` by the
    // orchestrator (persistence slice); see emit/migrations.ts.
    return null;
  },

  emitOutbox(_physical: StorageIR, _aggs: readonly AggregateIR[], _ctx: EmitCtx): Lines | null {
    // Transactional outbox is a capability gap on every backend today —
    // the validator rejects `publish: integration | both` upstream.
    return null;
  },
};
