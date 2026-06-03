// Platform realization-axes vocabulary — pure lookups over the `Platform`
// / `SavingShape` IR vocabulary, shared by IR lowering, the IR validator,
// the language validators, and the generator persistence adapters.
//
// Lives at `util/` altitude (a foundational layer every pipeline phase
// may depend on) rather than inside `ir/types/loom-ir.ts`: the language
// validators (`platform-rules.ts`) consume these maps too, and a
// `language → ir` value import would be a backward pipeline edge.  Only
// the IR *types* are imported (type-only), which carries no runtime edge.

import type { Platform, SavingShape } from "../ir/types/loom-ir.js";

// D-REALIZATION-AXES — the `application:` axis is the one axis whose DSL
// spelling differs from its backing D-ADAPTER-HOME adapter key: the
// decision renamed the service-layer value to `serviceLayer`, while the
// `style` adapter key stays `layered`.  `cqrs`/`flat` map to themselves.
// One source of truth so lowering AND the validator agree — the lowered
// `DeployableIR.application` carries the resolved ADAPTER key, ready for
// `resolveStyle`.

/** DSL `application:` value → `style` adapter key. */
export function applicationDslToAdapter(v: string): string {
  return v === "serviceLayer" ? "layered" : v;
}

/** `style` adapter key → DSL `application:` value (for menus / display). */
export function applicationAdapterToDsl(v: string): string {
  return v === "layered" ? "serviceLayer" : v;
}

/** Saving shapes (D-DOCUMENT-AXIS `shape(…)`) each backend platform can
 *  EMIT today — the single source of truth for the `supportedShapes`
 *  capability check.  A `shape(…)` not listed for the target platform is
 *  a hard error (the backend has no emitter for it yet).  Keyed by the
 *  bareword family (a `family@version` pin resolves via `platformFamily`
 *  in the validator).  Frontend platforms (`react`/`static`) own no
 *  persistence and are omitted.  Consumed by both the IR validator
 *  (`validateSavingShapeSupport`) and the generator persistence adapters
 *  (`PersistenceAdapter.supportedShapes`). */
export const PLATFORM_SAVING_SHAPES: Partial<Record<Platform, readonly SavingShape[]>> = {
  dotnet: ["relational", "embedded", "document"],
  node: ["relational", "embedded", "document"],
  // Phoenix/Ash emits relational + embedded (Ash embedded resources);
  // `document` (a single opaque `:map` — non-idiomatic for Ash) is a
  // future allowed-but-warned addition.
  phoenix: ["relational", "embedded"],
};
