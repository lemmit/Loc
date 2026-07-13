// ---------------------------------------------------------------------------
// ecto — the PersistenceAdapter for the elixir backend.  Plain Ecto / Postgrex.
//
// A *forward seam* registered on the persistence axis so the menu / validation
// / cross-backend parity treat the data layer as first-class.  The actual emit
// is produced by the `vanilla/` generator subtree (`../index.ts` delegates to
// it), not invoked through this adapter today — elixir's `emitProject` threads
// only the STYLE adapter (see `src/platform/elixir.ts`).  The emit methods are
// nonetheless implemented faithfully (delegating to the vanilla emitters) so the
// seam is correct if a later orchestrator rewire routes through it.
//
// Naming (D-REALIZATION-AXES; docs/old/plans/realization-axes-alignment.md §3.1): a
// `persistence:` value names the *data-access library*.  Ecto is DB-agnostic —
// the database is chosen by its adapter (Postgrex / ecto_sqlite3) off the
// `storage` block — so the value is **`ecto`** (singular).
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import type { EmitCtx, Lines, PersistenceAdapter } from "../../_adapters/index.js";
import { toModulePrefix, toSnakeApp } from "../app-naming.js";

function appNameOf(ctx: EmitCtx): string {
  return toSnakeApp(ctx.deployable.name);
}

function _appModuleOf(ctx: EmitCtx): string {
  return toModulePrefix(appNameOf(ctx));
}

function _contextOf(ctx: EmitCtx, aggName: string): EnrichedBoundedContextIR | undefined {
  return ctx.contexts.find((c) => c.aggregates.some((a) => a.name === aggName));
}

export const ectoPersistenceAdapter: PersistenceAdapter = {
  name: "ecto",
  // ecto emits a full event-sourced store (struct + fold + `<agg>_event_log`
  // Ecto schema + load-fold-append repository — see
  // `vanilla/eventsourced-emit.ts`), so it hosts BOTH the `state` and
  // `eventLog` strategies.
  supportedStrategies: ["state", "eventLog"],

  supports(storageType, kind, persistenceStrategy) {
    if (persistenceStrategy === "eventLog") {
      return storageType === "postgres" && kind === "eventLog";
    }
    return (
      persistenceStrategy === "state" &&
      storageType === "postgres" &&
      ["state", "snapshot", "replica"].includes(kind)
    );
  },

  emitProjectDeps(_ctx: EmitCtx): Lines {
    // Plain Ecto/Postgrex.  The rest of `mix.exs` (phoenix / bandit /
    // jason already present via the framework) lives in the shell.
    return [`{:ecto_sql, "~> 3.12"},`, `{:postgrex, ">= 0.0.0"},`];
  },
};
