// ---------------------------------------------------------------------------
// The ONE way a walker says "I could not render this".
//
// Every unrenderable construct in the body walker ends the same way: a comment
// in markup-child position, so the page still compiles and the gap is visible to
// whoever reads the generated source.  What was missing is a way for a TEST to
// find those comments without knowing their wording.
//
// `frontend-showcase-render.test.ts` — the cross-frontend matrix whose whole job
// is catching silent degradation — used to scan for a hand-kept list of four
// give-up wordings.  There are 36 distinct ones.  It saw ONE:
//
//   • `Timeline: not yet supported on …` does not contain the substring
//     "not supported" that the list looked for;
//   • the `Icon` fallback is built from a variable (`unknown icon name 'star'`
//     vs `Icon needs name: or svg:`), so it has no static prefix to list at all;
//   • the other 33 were simply never added.
//
// Flutter was the exception, and its `extraScan` says why: it reuses
// `analyzeFlutterParity`, the emitter's OWN scanner, so "a NEW Flutter fallback
// wording is covered the day it is added".  That is the right idea; this module
// generalises it to every target.  A give-up now carries a fixed SENTINEL, so
// the matrix matches on structure instead of on a copy of the wording — which
// is the same "derive, don't hand-keep" rule the walker already applies to
// primitive names (`walker-primitive-names.ts`) and named args
// (`walker-primitive-args.ts`).
//
// `walker-give-up-routing.test.ts` pins that no walker file calls
// `renderComment` for a give-up directly, so a new one cannot skip the sentinel.
// ---------------------------------------------------------------------------

import type { WalkerTarget } from "./target.js";

/** The marker every walker give-up comment carries.
 *
 *  Deliberately lower-case, colon-joined and prefixed `loom` — it has to be a
 *  string that cannot plausibly occur in the surrounding generated code, since
 *  the matrix greps emitted output for it.  Short prefixes like `Action(` or
 *  `Form(` (real give-up wordings) match ordinary emitted code, which is why the
 *  wording itself can never be the thing tests look for. */
export const GIVE_UP_SENTINEL = "loom:unrendered";

/** Emit the give-up comment for a construct this target cannot render.
 *
 *  Use this — never `target.renderComment` — for anything that means "the
 *  authored construct did not make it into the output".  `renderComment` stays
 *  the seam for a comment that is not a degradation.
 *
 *  The sentinel goes FIRST so a truncated line in a diff or a test failure
 *  still shows it. */
export function giveUp(target: WalkerTarget, text: string): string {
  return target.renderComment(`${GIVE_UP_SENTINEL} ${text}`);
}

/** The give-up's VISIBLE twin — for a construct whose absence would otherwise
 *  leave a framed, empty region on the page (see `renderNotice` on
 *  {@link WalkerTarget}).  Carries the same sentinel, so one scan finds both. */
export function giveUpNotice(target: WalkerTarget, text: string): string {
  const render = target.renderNotice ?? target.renderComment;
  return render.call(target, `${GIVE_UP_SENTINEL} ${text}`);
}
