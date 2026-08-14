// Which page-body primitives carry an `of:` API/PROJECTION READ — one answer,
// derived from the registry.
//
// WHY THIS EXISTS
// ---------------
// Most targets never need to ask.  The four JSX frontends hoist a read inline
// at its call site through the walker's Pattern H, so the read is wherever the
// expression is and nothing has to go looking for it.
//
// Feliz and Flutter DO need to ask, because on those two a read is not an
// expression — it is a materialised piece of app structure.  Feliz turns each
// read into a Model field + a `Msg` case + an init `Cmd` + an update arm;
// Flutter into a Riverpod `FutureProvider` the page watches.  Both therefore
// walk the page body up front, collecting the reads to materialise.
//
// Both collectors used to spell that walk as `e.name === "QueryView"`.  When
// `Chart` — the second read-bearing primitive ever added — arrived, both were
// duly missed, and the failure was not subtle: a chart-only page emitted
// `View.chart … model.<Field>` against a Model field nothing declared (Feliz),
// and imported `reads.dart` while watching a provider the emitter never wrote
// (Flutter: `uri_does_not_exist` + `undefined_identifier`).  Two hand-kept
// copies of the same list, and one new primitive was enough to break both.
//
// So the fact lives on the registry entry (`readsOf`), where primitives are
// declared, and both collectors ask here.  Adding a third read-bearing
// primitive is that one flag — there is no second place left to forget.
//
// The lookup is LAZY (a registry read per call, not a Set built at module
// load) so the answer cannot go stale relative to the registry, and so a test
// can register a primitive and observe both collectors pick it up.

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { WALKER_PRIMITIVES } from "./registry.js";

/** True when a primitive NAME is registered as carrying an `of:` read. */
export function isOfReadPrimitive(name: string): boolean {
  return WALKER_PRIMITIVES[name]?.readsOf === true;
}

/** True when an expression is a call to a read-bearing primitive. */
export function isOfReadCall(e: ExprIR): e is ExprIR & { kind: "call" } {
  return e.kind === "call" && isOfReadPrimitive(e.name);
}

/** The `of:` argument of a read-bearing call, or undefined when the call is
 *  not read-bearing or omits `of:` (a body that failed validation still walks
 *  here, so this stays total rather than asserting). */
export function ofArgOf(e: ExprIR): ExprIR | undefined {
  if (!isOfReadCall(e)) return undefined;
  const idx = (e.argNames ?? []).indexOf("of");
  return idx >= 0 ? e.args[idx] : undefined;
}
