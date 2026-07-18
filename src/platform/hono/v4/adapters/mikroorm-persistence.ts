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
// The IR validator (`validateMikroOrmSupport` in `ir/validate/checks/
// system-checks.ts`) accepts the wired surface — relational + event-sourced
// state, associations, retrievals, seeds, managed/audited fields, aggregate
// inheritance (TPH `sharedTable` shared-Row + TPC `ownTable` per-concrete
// tables), single-level flat contained entity parts (relational child tables),
// and `shape(embedded)` (root columns + jsonb containments) — and still rejects
// the not-yet-wired features (`shape(document)`, deeper-nested parts,
// provenanced fields).
// ---------------------------------------------------------------------------

import type { EmitCtx, Lines, PersistenceAdapter } from "../../../../generator/_adapters/index.js";
import { MIKRO_DEPS } from "../../../../generator/typescript/emit/mikroorm.js";
import type { EnrichedBoundedContextIR } from "../../../../ir/types/loom-ir.js";

/** The owning bounded context for an aggregate. */
function _contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

function _findRepoFor(ctx: EmitCtx, aggName: string) {
  for (const c of ctx.contexts) {
    const r = c.repositories.find((repo) => repo.aggregateName === aggName);
    if (r) return r;
  }
  return undefined;
}

const _splitLines = (s: string): Lines => s.split("\n");

export const mikroOrmPersistenceAdapter: PersistenceAdapter = {
  name: "mikroorm",
  // State + event-sourced (appliers, MikroORM edition): the `<agg>_events`
  // stream + fold reuse the persistence-agnostic domain/CQRS layer.
  supportedStrategies: ["state", "eventLog"],

  supports(storageType, kind, persistenceStrategy) {
    if (persistenceStrategy === "eventLog") {
      return storageType === "postgres" && kind === "eventLog";
    }
    return (
      persistenceStrategy === "state" &&
      ["postgres"].includes(storageType) &&
      ["state", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    return [...MIKRO_DEPS];
  },
};
