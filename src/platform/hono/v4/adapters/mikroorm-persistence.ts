// ---------------------------------------------------------------------------
// mikroorm — a real (minimal-v1) PersistenceAdapter for the node/hono platform.
// The SECOND node persistence backend, selected by `persistence: mikroorm`
// (alongside the default `drizzle`).
//
// As with the dotnet `dapper` adapter, the orchestrator (`emit.ts`) branches on
// the deployable's resolved `persistence` key and emits the MikroORM `db/` layer
// directly (entities + config + repository + connection wiring — see
// `generator/typescript/emit/mikroorm.ts`); this adapter publishes the
// capability surface the validator reads to accept + gate the selection
// (`supports`), and wraps the same emitters on the formal contract for the
// eventual clean orchestrator dispatch.
//
// v1 capability: relational state only.  The IR validator
// (`validateMikroOrmSupport` in `ir/validate/validate.ts`) rejects the gated-out
// features (document/embedded shape, associations, nested parts, inheritance,
// event-sourcing, audit/provenance/managed fields, retrievals, seeds).
// ---------------------------------------------------------------------------

import type { EmitCtx, Lines, PersistenceAdapter } from "../../../../generator/_adapters/index.js";
import {
  MIKRO_DEPS,
  mikroConnectionSetup,
  renderMikroRepository,
} from "../../../../generator/typescript/emit/mikroorm.js";
import type {
  AggregateIR,
  DataSourceIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  StorageIR,
} from "../../../../ir/types/loom-ir.js";

/** The owning bounded context for an aggregate. */
function contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

function findRepoFor(ctx: EmitCtx, aggName: string) {
  for (const c of ctx.contexts) {
    const r = c.repositories.find((repo) => repo.aggregateName === aggName);
    if (r) return r;
  }
  return undefined;
}

const splitLines = (s: string): Lines => s.split("\n");

export const mikroOrmPersistenceAdapter: PersistenceAdapter = {
  name: "mikroorm",
  // v1 is state-based only — no event-sourcing.
  supportedStrategies: ["state"],

  supports(storageType, kind, persistenceStrategy) {
    return (
      persistenceStrategy === "state" &&
      ["postgres"].includes(storageType) &&
      ["state", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    return [...MIKRO_DEPS];
  },

  emitConnectionSetup(_physicalStores: readonly StorageIR[], _ctx: EmitCtx): Lines {
    return mikroConnectionSetup();
  },

  emitRepository(agg: AggregateIR, _logical: DataSourceIR, ctx: EmitCtx): Lines {
    const owningCtx = contextOf(ctx, agg.name);
    if (!owningCtx) return [];
    const enriched = agg as EnrichedAggregateIR;
    return splitLines(renderMikroRepository(enriched, findRepoFor(ctx, agg.name), owningCtx));
  },

  emitMigrations(): Lines | null {
    // MikroORM owns its schema via `orm.schema.updateSchema()` at startup — no
    // drizzle-style per-deployable migration files.
    return null;
  },

  emitOutbox(): Lines | null {
    // Integration-event outbox is out of scope for mikroorm v1.
    return null;
  },
};
