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
  /** Names of the GROUPED (`group by`) readable projections — the reads whose
   *  response is the LIST shape, one row per group (M-T1.3 Phase 4).  Optional
   *  for the same reason as the detector's `projectionsByName`: a caller with
   *  no projection read in scope leaves every projection on the singleton
   *  (one-object) answer, byte-identical to the pre-grouped behaviour. */
  groupedProjections?: { has(name: string): boolean };
}

/** The RESULT SHAPE a `QueryView` `of:` read yields — the two facts every
 *  frontend has to agree on to render the four query arms correctly.
 *
 *  Both are properties of the READ, never of what the page author wrote.  The
 *  `paged:` / `single:` flags on `QueryView` are opt-INs layered on top (see
 *  `emitQueryView`), not the source of either answer. */
export interface QueryShape {
  /** The read returns the `paged<T>` envelope `{items, page, …}` rather than a
   *  bare array — the paged-by-default auto-`findAll` (M-T2.6). */
  paged: boolean;
  /** The read yields at MOST ONE record (`byId`, or a find returning `T` / `T?`)
   *  rather than a collection.  Drives the emptiness question: a single record
   *  is empty when it is absent, a collection when it has no rows.  Asking
   *  `.length` / `Enum.empty?` of one record is a blank page on the JSX
   *  frontends and a raise on HEEx. */
  single: boolean;
}

/** Resolve the result shape of a `QueryView` `of:` expression from the IR.
 *  A non-api or unresolvable expression yields the collection default
 *  (`{paged: false, single: false}`) — the conservative answer, since a wrongly
 *  paged read decodes fields the wire never sends and a wrongly single one
 *  drops the collection arms. */
export function queryShape(ofArg: ExprIR, ctx: PagedQueryContext): QueryShape {
  const detected = tryDetectApiHook(ofArg, ctx);
  // A PROJECTION read (M-T1.3) answers from the projection's own shape: the
  // whole-table singleton yields one object, while a GROUPED (`group by`)
  // projection returns the LIST shape — one row per group, never paged.  Same
  // question, same answer-site.
  if (detected?.kind === "projection") {
    return {
      paged: false,
      single: !ctx.groupedProjections?.has(detected.aggregateName),
    };
  }
  if (detected?.kind !== "aggregate") return { paged: false, single: false };
  // `byId` is a STANDARD op with no declared find to inspect, and it is the
  // overwhelmingly common single read — answer it before the repository lookup.
  if (detected.operation === "byId") return { paged: false, single: true };
  const bc = ctx.bcByAggregate.get(detected.aggregateName);
  const repo = bc?.repositories.find((r) => r.aggregateName === detected.aggregateName);
  const find = repo?.finds.find((f) => f.name === detected.operation);
  if (!find) return { paged: false, single: false };
  if (pagedReturn(find.returnType)) return { paged: true, single: false };
  // A declared find returning `T` or `T?` (an absence-shaped union included) is
  // single; only an array return is a collection.
  const ret = find.returnType;
  const inner = ret.kind === "optional" ? ret.inner : ret;
  return { paged: false, single: inner.kind !== "array" };
}

/** True when a `QueryView` `of:` read returns the `paged<T>` envelope.  Thin
 *  alias over `queryShape` for the call sites that only ask that half. */
export function isPagedQuery(ofArg: ExprIR, ctx: PagedQueryContext): boolean {
  return queryShape(ofArg, ctx).paged;
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
