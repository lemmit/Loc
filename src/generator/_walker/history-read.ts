// ---------------------------------------------------------------------------
// Entity-history reads in a page body — which frontends can actually serve one.
//
// `QueryView { of: <api>.<Agg>.history(id) }` is not a normal aggregate read.
// The find behind it (`RepositoryIR.historyFind`) deliberately sits BESIDE
// `finds` (docs/audit.md), so every read layer that discovers a page's queries
// by walking `finds` — or by matching only the `all` / `byId` standard ops —
// does not see it.  Three of the six frontends are in that position today:
//
//   - **Feliz** collects page reads for `all` / `byId` only (`feliz/wire.ts`
//     `collectPageReads`) and its `buildHookUse` maps every OTHER operation to
//     the `All<Plural>` Model field, so a history read would silently bind the
//     unfiltered list — and its `Timeline` is a comment, which as the sole body
//     of an Elmish `data:` lambda is not even an expression.
//   - **Flutter** skips non-`all`/`byId` ops in `collectFlutterReads` while the
//     walker still references `<agg>HistoryProvider`, i.e. an undefined name.
//   - **Phoenix/HEEx** maps the read onto the aggregate's `list_<aggs>` context
//     function, which is the LIST, not the trail.
//
// None of those is a rendering gap the `Timeline` primitive's own comment
// covers: the damage is in the READ the surrounding `QueryView` registers, one
// level up.  So the whole view is skipped on those targets, with a visible
// comment in its place — the same "honest degradation" contract every
// unported-frontend primitive follows, rather than emitting a dangling handle
// that only fails at `dotnet fable` / `flutter analyze` / `mix compile` time.
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
const HISTORY_CAPABLE_FRAMEWORKS: ReadonlySet<string> = new Set([
  "react",
  "vue",
  "svelte",
  "angular",
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
