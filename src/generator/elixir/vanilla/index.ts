// Vanilla foundation orchestrator (vanilla-foundation-tdd-plan.md;
// D-VANILLA-PHOENIX-FOUNDATION).  Plain Ecto/Phoenix — no Ash.Resource,
// AshPostgres, or AshPhoenix.  Grows slice by slice; today (slice 1) it emits
// the shared `<App>.Types` typespec module + a plain `Ecto.Schema` per
// aggregate.  Changesets, repositories, contexts, controllers, migrations,
// LiveView, and the project shell follow in subsequent slices.
//
// Reached only from `generateElixirProject` when `deployable.foundation ===
// "vanilla"`.  The user-facing validator gate
// (`loom.foundation-vanilla-phoenix-not-yet-implemented`) stays up until the
// tree emits a project that compiles end-to-end; tests drive this path with
// `validate: false`.

import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import { renderTypesModule } from "../types-module-emit.js";
import { emitVanillaSchemas } from "./schema-emit.js";

export interface GenerateVanillaArgs {
  contexts: EnrichedBoundedContextIR[];
  appName: string;
  appModule: string;
}

/** Emit the vanilla-foundation project files into `out`. */
export function emitVanillaProject(args: GenerateVanillaArgs, out: Map<string, string>): void {
  const { contexts, appName, appModule } = args;
  // Shared `<App>.Types` typespec vocabulary — foundation-agnostic.
  out.set(`lib/${appName}/types.ex`, renderTypesModule(`${appModule}.Types`));
  for (const ctx of contexts) {
    emitVanillaSchemas(appName, ctx, appModule, out);
  }
}
