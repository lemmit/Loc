// ---------------------------------------------------------------------------
// mergeContexts — union several enriched bounded contexts into one synthetic
// context.  A multi-context backend deployable (hono / dotnet / python) emits
// its shared domain + schema/DbContext once from this merged view rather than
// per hosted context.
//
// Ambient root-level enums / value objects are folded into EVERY context by
// enrichment, so a plain union would emit them once per hosted context
// (duplicate `export const currencyEnum = …` / duplicate C# enum decls, which
// the bundlers reject).  They are deduped by name; every other member is a
// plain union.
//
// The three orchestrators built this inline, verbatim apart from two fields:
//   - `name`   — dotnet uses the project namespace; hono / python use the
//                first context's name.  Callers that need a different name
//                spread over the result (`{ ...mergeContexts(cs), name: ns }`).
//   - `eventSubscriptions` — hono RE-DERIVES these over the merged channel /
//                workflow / projection union (so a reactor in one hosted
//                context can route off a channel declared in another); dotnet
//                / python take the plain union.  Hono spreads its derived set
//                over the result.  The default here is the plain union.
// Keeping both divergences at the call site keeps this helper a pure union and
// the per-backend intent visible where it matters.
// ---------------------------------------------------------------------------

import { dedupeByName } from "../../util/dedupe.js";
import type { EnrichedBoundedContextIR } from "../types/loom-ir.js";

/** Union enriched bounded contexts into one synthetic merged context (ambient
 *  enums / VOs deduped by name, every other member a plain union). */
export function mergeContexts(contexts: EnrichedBoundedContextIR[]): EnrichedBoundedContextIR {
  return {
    name: contexts[0]?.name ?? "merged",
    enums: dedupeByName(contexts.flatMap((c) => c.enums)),
    valueObjects: dedupeByName(contexts.flatMap((c) => c.valueObjects)),
    events: contexts.flatMap((c) => c.events),
    payloads: contexts.flatMap((c) => c.payloads),
    aggregates: contexts.flatMap((c) => c.aggregates),
    repositories: contexts.flatMap((c) => c.repositories),
    workflows: contexts.flatMap((c) => c.workflows),
    views: contexts.flatMap((c) => c.views),
    criteria: contexts.flatMap((c) => c.criteria),
    domainServices: contexts.flatMap((c) => c.domainServices ?? []),
    channels: contexts.flatMap((c) => c.channels),
    projections: contexts.flatMap((c) => c.projections ?? []),
    retrievals: contexts.flatMap((c) => c.retrievals),
    seeds: contexts.flatMap((c) => c.seeds),
    tests: contexts.flatMap((c) => c.tests ?? []),
    eventSubscriptions: contexts.flatMap((c) => c.eventSubscriptions),
    // Application-layer explicit handlers (unfoldable-api-derivation.md) — a
    // plain union, so a merged-context consumer (e.g. the .NET Program.cs extern
    // Scrutor scan) sees every hosted context's commandHandler / queryHandler.
    commandHandlers: contexts.flatMap((c) => c.commandHandlers ?? []),
    queryHandlers: contexts.flatMap((c) => c.queryHandlers ?? []),
  };
}
