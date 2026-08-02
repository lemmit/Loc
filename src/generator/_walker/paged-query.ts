// ---------------------------------------------------------------------------
// Is a `QueryView`'s `of:` read PAGED?  One derivation, every consumer.
//
// The auto-`findAll` returns `paged<T>` (M-T2.6), so paged-ness is a property
// of the FIND's return type, not of anything the page author wrote — a
// hand-written `QueryView { of: X.all }` is paged whether or not it says so.
// `paged: true` is an explicit OPT-IN on top: it also tells the walker to leave
// the binding as the envelope (the scaffold's server-paged list reads
// `rows.items` itself) instead of unwrapping it to the row array.
//
// Those are two different questions, and the split is why this module exists.
// The walker derived paged-ness from the return type while the Feliz and
// Flutter read collectors keyed their wire decode on the explicit FLAG — so a
// hand-written paged read had a walker that resolved `rows.total` to a decoded
// field and a wire layer that never decoded it.  Two defensible readings of the
// same word, one non-compiling app.  A derived flag and a declared flag with
// the same name are two flags; this module makes them one.
// ---------------------------------------------------------------------------

import { pagedReturn } from "../../ir/stdlib/generics.js";
import type { BoundedContextIR, ExprIR } from "../../ir/types/loom-ir.js";
import { type ApiHookDetectorContext, tryDetectApiHook } from "./api-hook-detector.js";

/** What `isPagedQuery` needs beyond the detector's own context: the bounded
 *  context each aggregate lives in, so the read's find can be looked up. */
export interface PagedQueryContext extends ApiHookDetectorContext {
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
}

/** True when a `QueryView` `of:` expression resolves to a repository find whose
 *  return type is a `paged<T>` envelope.  False for a byId read, a plain array
 *  find, a non-api expression, or an unresolvable one — the conservative answer
 *  everywhere, since a wrongly-paged read decodes fields the wire never sends. */
export function isPagedQuery(ofArg: ExprIR, ctx: PagedQueryContext): boolean {
  const detected = tryDetectApiHook(ofArg, ctx);
  if (detected?.kind !== "aggregate") return false;
  const bc = ctx.bcByAggregate.get(detected.aggregateName);
  const repo = bc?.repositories.find((r) => r.aggregateName === detected.aggregateName);
  const find = repo?.finds.find((f) => f.name === detected.operation);
  return find ? !!pagedReturn(find.returnType) : false;
}

/** Build the `bcByAggregate` index `isPagedQuery` needs from a ui's bound
 *  contexts.  Shared so the Feliz and Flutter collectors index identically. */
export function bcByAggregateOf(
  contexts: readonly BoundedContextIR[],
): ReadonlyMap<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const c of contexts) for (const a of c.aggregates) out.set(a.name, c);
  return out;
}
