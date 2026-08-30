// ---------------------------------------------------------------------------
// jpa — the real PersistenceAdapter for the java platform: Spring Data
// JPA over Hibernate against Postgres.  The orchestrator calls the
// underlying emit fns directly, mirroring how dotnet's efcore adapter
// wraps its emitters.
//
// The adapter carries NO capability answers (supports /
// supportedStrategies / supportedShapes): nothing in src/ would read them, and
// the dataSource validation runs off the sourceType registry.  See
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
