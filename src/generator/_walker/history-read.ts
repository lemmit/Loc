// ---------------------------------------------------------------------------
// Entity-history reads in a page body — which frontends can actually serve one.
//
// `QueryView { of: <api>.<Agg>.history(id) }` is not a normal aggregate read.
// The find behind it (`RepositoryIR.historyFind`) deliberately sits BESIDE
// `finds` (docs/audit.md), so every read layer that discovers a page's queries
// by walking `finds` — or by matching only the `all` / `byId` standard ops —
// does not see it.  Every shipped frontend now serves it; the histories below
// record what each read layer got wrong before it joined, because a NEW
// frontend starts in exactly that position.
//
// **Flutter used to skip it** — `collectFlutterReads` skipped
// non-`all`/`byId` ops while the walker still referenced `<agg>HistoryProvider`,
// an undefined name.  It now collects the read (`flutter/reads-emit.ts` — a
// `FutureProvider.family<List<AuditEntry>, String>` keyed by the route id over
// `GET /<coll>/$id/history`, decoding the Track A `AuditEntry` wire model) and
// renders the trail natively (`flutter/flutter-target.ts` `renderTimeline`).
//
// **Feliz used to be in that position too** — its `collectPageReads` matched
// `all` / `byId` only and `buildHookUse` mapped every OTHER operation onto the
// `All<Plural>` Model field, so a history read would have silently bound the
// unfiltered list.  It now collects the read (`feliz/wire.ts`
// `felizHistoryRead`: page-entry keyed off the route id like a byId, fired by
// `pageCmd`, but list-shaped — `Remote<AuditEntry list>` matched by
// `View.remoteList`), `buildHookUse` maps it to that `<Agg>History` field, and
// `felizTarget.renderTimeline` renders the ordered list natively.
//
// **Phoenix/HEEx used to be another** — it mapped the read onto the
// aggregate's `list_<aggs>` context function, which is the LIST, not the trail,
// so the whole view was skipped.  It now serves the trail natively: the LiveView
// hosts its contexts in the SAME OTP app, so the read is a page-private
// `load_<agg>_history/2` calling `<App>.Audit.History.for_target/3` in-process
// (the same three guards the `history` controller action applies) — see
// `elixir/liveview-emit.ts`.  No api client, no fetch.
//
// None of those was a rendering gap the `Timeline` primitive's own comment
// covers: the damage was in the READ the surrounding `QueryView` registers, one
// level up.  A frontend OUTSIDE the capable set therefore has its whole view
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
