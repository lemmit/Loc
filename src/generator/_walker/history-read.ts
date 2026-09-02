// ---------------------------------------------------------------------------
// Entity-history reads in a page body — which frontends can actually serve one.
//
// `QueryView { of: <api>.<Agg>.history(id) }` is not a normal aggregate read.
// The find behind it (`RepositoryIR.historyFind`) deliberately sits BESIDE
// `finds` (docs/audit.md), so every read layer that discovers a page's queries
// by walking `finds` — or by matching only the `all` / `byId` standard ops —
// does not see it.  A read layer that discovers reads that way binds the wrong
// thing — the unfiltered list, or a handle nothing declares — so each frontend
// has to collect this read explicitly.  How each one does:
//
// **Flutter** — `flutter/reads-emit.ts` collects it as a
// `FutureProvider.family<List<AuditEntry>, String>` keyed by the route id over
// `GET /<coll>/$id/history`, decoding the Track A `AuditEntry` wire model;
// `flutter/flutter-target.ts` `renderTimeline` renders the trail.
//
// **Feliz** — `feliz/wire.ts` `felizHistoryRead` collects it as a page-entry
// keyed off the route id like a byId, fired by `pageCmd`, but list-shaped
// (`Remote<AuditEntry list>`, matched by `View.remoteList`); `buildHookUse`
// maps it to the `<Agg>History` Model field, and `felizTarget.renderTimeline`
// renders the ordered list.
//
// **Phoenix/HEEx** — the LiveView hosts its contexts in the SAME OTP app, so
// the read is a page-private `load_<agg>_history/2` calling
// `<App>.Audit.History.for_target/3` in-process (the same three guards the
// `history` controller action applies) — see `elixir/liveview-emit.ts`.  No api
// client, no fetch.
//
// None of this is the rendering gap the `Timeline` primitive's own comment
// covers: the exposure is in the READ the surrounding `QueryView` registers,
// one level up.  A frontend OUTSIDE the capable set has its whole view
// skipped, with a visible notice in its place — the same "honest degradation"
// contract every unported-frontend primitive follows, rather than emitting a
// dangling handle that only fails at `dotnet fable` / `flutter analyze` /
// `mix compile` time.
//
// The gate is one predicate, shared by BOTH walker engines (the JSX/markup
// `walkBody` core and the parallel HEEx one), so the two cannot disagree about
// which reads a target serves.  A frontend joins the set by collecting the
// history read AND implementing `Timeline` — the same day, or not at all.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { AUDIT_HISTORY_FIND } from "../../util/audit-names.js";

/** Frontends whose read layer collects the derived `history(id)` read and whose
 *  walker renders `Timeline`.  Both halves are required — a target that renders
 *  the primitive but binds the wrong read is worse than one that renders
 *  nothing, because it looks like it works. */
export const HISTORY_CAPABLE_FRAMEWORKS: ReadonlySet<string> = new Set([
  "react",
  "vue",
  "svelte",
  "angular",
  "phoenixLiveView",
  "feliz",
  "flutter",
]);

/** True when a `QueryView` `of:` expression is the derived entity-history read
 *  — `<api>.<Agg>.history(id)` or the no-api-handle `<Agg>.history(id)`.  The
 *  receiver must name an aggregate this ui knows, so an unrelated
 *  `something.history(…)` is not mistaken for one. */
export function isEntityHistoryRead(
  ofArg: ExprIR,
  aggregatesByName: { has(name: string): boolean },
): boolean {
  if (ofArg.kind !== "method-call" || ofArg.member !== AUDIT_HISTORY_FIND) return false;
  const recv = ofArg.receiver;
  const name = recv.kind === "member" ? recv.member : recv.kind === "ref" ? recv.name : undefined;
  return name !== undefined && aggregatesByName.has(name);
}

/** True when this target must SKIP a history-read view (see the module header).
 *  Callers render `renderComment(...)` in its place. */
export function skipsEntityHistoryRead(
  framework: string,
  ofArg: ExprIR | undefined,
  aggregatesByName: { has(name: string): boolean },
): boolean {
  if (HISTORY_CAPABLE_FRAMEWORKS.has(framework)) return false;
  return ofArg !== undefined && isEntityHistoryRead(ofArg, aggregatesByName);
}
