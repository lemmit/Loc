// ---------------------------------------------------------------------------
// dapper — a full-parity PersistenceAdapter for the dotnet platform (drained to EF-Core parity, M-T6.9)
// (D-REALIZATION-AXES Phase 5c).  Selected by `persistence: dapper`.
//
// The orchestrator (`generator/dotnet/index.ts`) branches on the deployable's
// `persistence` key and emits the Dapper Infrastructure directly (repository,
// `DbSchema`, connection wiring, deps — see `../emit/dapper.ts`); this adapter
// publishes the capability surface the validator reads to accept the selection
// and gate it (`supports` / `supportedShapes`), and wraps the same emitters on
// the formal contract for the eventual clean orchestrator dispatch.
//
// v1 capability: relational state only.  The IR validator
// (`validateDapperSupport` in `ir/validate/validate.ts`) rejects the gated-out
// features (document/embedded shape, associations, nested parts, inheritance,
// event-sourcing, audit/provenance/managed fields, seeds, stamping).
// ---------------------------------------------------------------------------

import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";
import { DAPPER_PROJECT_DEPS } from "../emit/dapper.js";

function _nsOf(ctx: EmitCtx): string {
  const name = ctx.deployable.name;
  return name[0]!.toUpperCase() + name.slice(1);
}

function _findRepoFor(ctx: EmitCtx, aggName: string) {
  for (const c of ctx.contexts) {
    const r = c.repositories.find((repo) => repo.aggregateName === aggName);
    if (r) return r;
  }
  return undefined;
}

export const dapperPersistenceAdapter: PersistenceAdapter = {
  name: "dapper",
  // State + event-sourced (appliers, Dapper edition): the `<agg>_events`
  // stream + fold reuse the persistence-agnostic domain/CQRS layer.
  supportedStrategies: ["state", "eventLog"],
  // Relational tables only; document / embedded are EF-owned in v1.
  supportedShapes: ["relational"],

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
    return DAPPER_PROJECT_DEPS;
  },
};
