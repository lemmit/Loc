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
    // The two error-status maps enrichment attaches.  They were MISSING from
    // this merge, and the consequence was silent: an emitter handed the merged
    // context read `undefined` for both, so `resolveErrorStatus(name, undefined)`
    // fell to the stdlib default and every `httpStatus <Error> -> <Code>`
    // override no-opped on that path — while the SAME override moved the
    // per-context emitters in the same generated app.  One backend disagreeing
    // with itself, which is worse than a cross-backend split and which no
    // cross-backend gate can see.
    //
    // `structuralErrorStatuses` is app-wide (folded once across every api), so
    // any context's copy is the same object — first defined wins.
    // `errorStatusOverrides` is per-SUBDOMAIN, and `mergeContexts` is only ever
    // called on contexts of one deployable; where a deployable spans subdomains
    // the maps are merged in declaration order, first-declared winning on a
    // conflicting name, mirroring how the app-wide fold resolves the same clash.
    structuralErrorStatuses: contexts.find((c) => c.structuralErrorStatuses !== undefined)
      ?.structuralErrorStatuses,
    errorStatusOverrides: contexts.some((c) => c.errorStatusOverrides !== undefined)
      ? contexts.reduceRight<Record<string, number>>(
          (acc, c) => ({ ...acc, ...(c.errorStatusOverrides ?? {}) }),
          {},
        )
      : undefined,
  };
}
