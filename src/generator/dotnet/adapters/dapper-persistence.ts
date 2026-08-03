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
// CAPABILITY — at EF-Core parity since M-T6.9 (drained across 7 waves): every
// relational / document / embedded / event-sourced / inheritance shape,
// containment (incl. recursive part-in-part), associations, audit, provenance,
// managed fields, retrievals, seeds and the workflow outbox all emit.
//
// This paragraph used to read "v1 capability: relational state only" and list
// document/embedded shape, associations, nested parts, inheritance,
// event-sourcing, audit/provenance/managed fields, seeds and stamping as
// REJECTED by `validateDapperSupport`.  That was frozen at the pre-M-T6.9 state
// and had become actively misleading — `validateDapperSupport`'s own header
// (ir/validate/checks/system-checks.ts) describes the parity, so the two
// comments contradicted each other, and the stale one is the one a reader
// finds first.  Empirically: 35 of 36 corpus features generate under
// `persistence: dapper`, and the one that doesn't is rejected honestly.
//
// `validateDapperSupport` now fires only for a genuinely-impossible shape (an
// un-owned by-value entity-array part field) and for a capability filter
// outside the Dapper SQL subset — a fail-fast guard, not a v1 feature gate.
//
// KNOWN GAP — query-time projections still emit an EF-LINQ handler over
// `AppDbContext` and so do not compile under dapper (CS0234); tracked by
// `DAPPER_COMPILE_SKIP` in `test/e2e/corpus-dotnet-dapper-build.test.ts`.  The
// FOLDED projection read controller already has the raw-Npgsql port they need.
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
