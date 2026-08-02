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
    // Guarded by test/ir/ir-merge-completeness.test.ts: every field of
    // BoundedContextIR must be carried here or named in that gate's
    // DELIBERATELY_DROPPED list with a reason.  A field added upstream and not
    // handled here reads `undefined` in every emitter fed a merged context,
    // with no type error, which is exactly how the two maps below went missing.
    structuralErrorStatuses: contexts.find((c) => c.structuralErrorStatuses !== undefined)
      ?.structuralErrorStatuses,
    errorStatusOverrides: mergeErrorStatusOverrides(contexts),
  };
}

/** Per-subdomain `httpStatus` overrides folded across the contexts of one
 *  deployable, FIRST-DECLARED winning on a conflicting name — the same tie-break
 *  the app-wide `structuralErrorStatuses` fold in `enrichments.ts` applies, so
 *  the two mechanisms can't disagree about which api won.
 *
 *  Written as a reverse loop rather than a `reduce` with a spread accumulator:
 *  the spread form is O(n²) and Biome rejects it (`noAccumulatingSpread`).
 *  Walking backwards and letting each earlier context overwrite gives
 *  first-declared-wins in one pass.
 *
 *  Returns `undefined` when no context declares any, so the field stays absent
 *  rather than becoming an empty object — `resolveErrorStatus` treats the two
 *  identically, but an absent field keeps the merged context byte-comparable
 *  with one built before this merge existed. */
function mergeErrorStatusOverrides(
  contexts: EnrichedBoundedContextIR[],
): Record<string, number> | undefined {
  if (!contexts.some((c) => c.errorStatusOverrides !== undefined)) return undefined;
  const out: Record<string, number> = {};
  for (let i = contexts.length - 1; i >= 0; i--) {
    Object.assign(out, contexts[i]?.errorStatusOverrides ?? {});
  }
  return out;
}
