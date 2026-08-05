// ---------------------------------------------------------------------------
// jpa — the real PersistenceAdapter for the java platform: Spring Data
// JPA over Hibernate against Postgres.  The orchestrator calls the
// underlying emit fns directly, mirroring how dotnet's efcore adapter
// wraps its emitters.
//
// This header used to claim the capability answers (supports /
// supportedStrategies / supportedShapes) were "live from day one —
// they drive the language-layer dataSource validation".  They never
// were: nothing in src/ read them, and the dataSource validation runs
// off the sourceType registry.  The fields are gone; see
// `_adapters/persistence-surface.ts`.
// ---------------------------------------------------------------------------

import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";

export const jpaPersistenceAdapter: PersistenceAdapter = {
  name: "jpa",

  emitProjectDeps(_ctx: EmitCtx): Lines {
    // spring-boot-starter-data-jpa + the Postgres driver ship in the
    // base pom (renderPom) — JPA is the default persistence and the
    // skeleton already boots against it, so there is nothing extra to
    // splice per-deployable.
    return [];
  },
};
