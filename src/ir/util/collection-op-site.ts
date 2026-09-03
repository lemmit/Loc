// The ONE recognizer for "this expression node is a stdlib collection op
// applied to a collection, in a frontend page/component/store body".
//
// Two consumers, and they MUST agree exactly:
//
//   • the IR-validate gate `loom.frontend-collection-op-unsupported`
//     (`ir/validate/checks/ui-checks.ts`) — decides which ops are REFUSED;
//   • the frontend body walkers (`generator/_walker/walker-core.ts` and the
//     parallel HEEx engine `generator/elixir/heex-walker-core.ts`) — decide
//     which nodes get routed to a per-target collection-op renderer.
//
// If the two disagreed in the direction "gate says fine, walker doesn't
// recognise it", the op would fall through to the walker's verbatim
// `<recv>.<member>(<args>)` emit — which is the EXACT failure the gate was
// created to stop (`rows.count` shipped as literal `rows.count`: TS2339 /
// not-F# / not-Dart).  Sharing one predicate makes that disagreement
// unrepresentable rather than merely unlikely.
//
// Two spellings reach here, because `lower-expr.ts` only rewrites a no-paren
// op into a call for `NO_PAREN_CALL_COLLECTION_OPS` (`first`/`firstOrNull`) on
// a TYPED collection:
//
//   `rows.where(λ)`  → `method-call` with `isCollectionOp: true`
//   `rows.count`     → a plain `member` whose name is in the catalogue
//
// Recognising a COLLECTION RECEIVER (not merely a catalogue NAME) is what
// keeps a scaffolded repository read `Sales.Customer.all` — which lowering
// also flags `isCollectionOp` off the name alone, with a primitive receiver —
// out of this.  There are two ways to be one, because page bodies mix typed
// and untyped bindings; see `isCollectionReceiver`.

import { isCollectionOp } from "../../util/collection-ops.js";
import type { ExprIR, TypeIR } from "../types/loom-ir.js";

/** The collection ops the FRONTENDS render — the ops that RESHAPE a collection
 *  (size it, filter it, test it, order it, window it, print it) without
 *  folding arithmetic over it or reaching for an element.
 *
 *  ONE definition, because it is simultaneously a VALIDATOR policy (what
 *  `loom.frontend-collection-op-unsupported` lets through) and an EMITTER
 *  contract (what every target's `renderCollectionOp` table must answer for),
 *  and the two disagreeing is the failure this whole module exists to make
 *  unrepresentable.  It lives at the `ir/util` layer because that is the one
 *  both the gate (`ir/validate/checks/ui-checks.ts`) and the generators sit
 *  downstream of.
 *
 *  The per-target TABLES cannot be derived from it — each is real code in a
 *  different language — so they are pinned against it instead, by
 *  `test/generator/_walker/collection-op-coverage.test.ts`.
 *
 *  The catalogue's other eight are refused, and each for a REPRESENTATION
 *  divergence rather than for want of a spelling:
 *
 *    • `sum` / `min` / `max` / `avg` fold ARITHMETIC, and `money` is a
 *      decimal.js / Elixir `Decimal` OBJECT on the JS frontends and Phoenix but
 *      a native `decimal` on Feliz and a `double` on Flutter — a naive `+`/`<`
 *      is silently wrong on the first two.
 *    • `first` / `firstOrNull` differ on PARTIALITY (`undefined` on the JS
 *      frontends, a raise on F# `List.head` / Dart `.first`) and on the
 *      optional type (`T | null` vs `'T option`).
 *    • `distinct` / `contains` need VALUE equality, and Flutter's generated
 *      wire models declare no `operator ==`.
 *
 *  Grow this set only alongside a real renderer on EVERY frontend, and expect
 *  the coverage test to tell you which one you forgot. */
export const FRONTEND_RENDERED_COLLECTION_OPS: ReadonlySet<string> = new Set([
  "count",
  "where",
  "any",
  "all",
  "map",
  "sortBy",
  "take",
  "skip",
  "join",
]);

/** A recognised collection-op application, in the shape both consumers want. */
export interface CollectionOpSite {
  /** Catalogue op name — `count`, `where`, `sortBy`, … */
  readonly op: string;
  readonly receiver: ExprIR;
  readonly receiverType: TypeIR;
  readonly args: readonly ExprIR[];
  /** The `method-call` node, when the op was spelled with parens.  The
   *  per-target renderer tables read `args[1]` off it for `sortBy`'s
   *  descending flag, and its `receiverType` for money/value-object element
   *  special-cases. */
  readonly call?: Extract<ExprIR, { kind: "method-call" }>;
}

/** True when a receiver type is a real collection — an `array`, or an
 *  `optional` wrapping one (`rows?.count`). */
export function isCollectionType(t: TypeIR): boolean {
  const unwrapped = t.kind === "optional" ? t.inner : t;
  return unwrapped.kind === "array";
}

/** True when this receiver is known to hold a collection: either its `TypeIR`
 *  says so, or it is a bare ref to a ROW-SET binding.
 *
 *  Both are needed because page bodies mix TYPED and UNTYPED bindings.  A
 *  `state { xs: string[] }`, a typed `derived`, a list literal and any chained
 *  result (`rows.where(λ).count`) all carry a real array `TypeIR`.  A
 *  `QueryView { of: X.all, data: rows => … }` lambda param does NOT — lowering
 *  leaves UI-primitive lambda params at the `string` placeholder — yet it is a
 *  collection by construction, and it is the shape the original defect was
 *  reported against. */
export function isCollectionReceiver(
  receiver: ExprIR,
  receiverType: TypeIR,
  rowSetBindings: ReadonlySet<string>,
): boolean {
  if (isCollectionType(receiverType)) return true;
  return receiver.kind === "ref" && rowSetBindings.has(receiver.name);
}

/** The collection-op application this node is, or undefined.
 *
 *  `rowSetBindings` are the row-set lambda params currently in scope — grown
 *  by `rowSetLambdaParam` as the caller descends into a `QueryView`'s `data:`
 *  lambda. */
export function collectionOpSite(
  e: ExprIR,
  rowSetBindings: ReadonlySet<string>,
): CollectionOpSite | undefined {
  if (e.kind === "method-call" && e.isCollectionOp) {
    if (!isCollectionReceiver(e.receiver, e.receiverType, rowSetBindings)) return undefined;
    return {
      op: e.member,
      receiver: e.receiver,
      receiverType: e.receiverType,
      args: e.args,
      call: e,
    };
  }
  if (e.kind === "member" && isCollectionOp(e.member)) {
    if (!isCollectionReceiver(e.receiver, e.receiverType, rowSetBindings)) return undefined;
    return { op: e.member, receiver: e.receiver, receiverType: e.receiverType, args: [] };
  }
  return undefined;
}

/** True iff `e.args[1]` is the boolean literal `true` — the descending flag a
 *  `sortBy(λ, true)` call carries (the only collection op with a 2nd arg).
 *  Lives here rather than in any one renderer because every frontend's
 *  `sortBy` arm has to read it, and this is the layer they all sit downstream
 *  of. */
export function isDescendingSort(e: Extract<ExprIR, { kind: "method-call" }>): boolean {
  const flag = e.args[1];
  return flag?.kind === "literal" && flag.lit === "bool" && flag.value === "true";
}

/** The `data:` lambda param a `QueryView` binds to a query's ROW SET, or
 *  undefined.
 *
 *  TWO forms bind something that is NOT a row set, and both must decline:
 *
 *    • `single: true` binds ONE record.
 *    • `paged: true` binds the `Paged<T>` ENVELOPE (`{items, page, pageSize,
 *      total, totalPages}`) — that is the whole point of the explicit flag, so
 *      the scaffold body can read `rows.items` and the pager can read
 *      `rows.totalPages` off it.  `rows.count` there is a `.length` on an
 *      object, which is a type error on the JSX frontends and a silently
 *      different value elsewhere.  (AUTO-paged is not this: the walker unwraps
 *      that binding to `.items`, so it really is an array and is not excluded
 *      — it carries no `paged:` arg to see here.) */
export function rowSetLambdaParam(e: ExprIR): string | undefined {
  if (e.kind !== "call" || e.name !== "QueryView") return undefined;
  if (isTrue(named(e, "single")) || isTrue(named(e, "paged"))) return undefined;
  const data = named(e, "data");
  return data?.kind === "lambda" ? data.param : undefined;
}

/** The `data:` lambda param an EXPLICITLY-PAGED `QueryView` binds — the one
 *  the sibling above declines.
 *
 *  It exists so the two consumers can disagree DELIBERATELY rather than by
 *  omission.  Such a binding is neither a collection (so no renderer can
 *  answer for it) nor a plain scalar (so ignoring it would let `rows.count`
 *  fall through to the walker's verbatim emit — the silent shape the whole
 *  gate exists to prevent).  The gate therefore refuses EVERY catalogue op off
 *  one, whatever the op; the walker is never handed the set, so it never
 *  treats such a node as a collection-op site. */
export function pagedEnvelopeLambdaParam(e: ExprIR): string | undefined {
  if (e.kind !== "call" || e.name !== "QueryView") return undefined;
  if (!isTrue(named(e, "paged")) || isTrue(named(e, "single"))) return undefined;
  const data = named(e, "data");
  return data?.kind === "lambda" ? data.param : undefined;
}

function named(e: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  const i = e.argNames?.indexOf(name) ?? -1;
  return i >= 0 ? e.args[i] : undefined;
}

function isTrue(x: ExprIR | undefined): boolean {
  return x?.kind === "literal" && x.lit === "bool" && x.value === "true";
}

/** The catalogue-op name this node reads off a bare ref in `bindings`, or
 *  undefined.  Same two spellings as `collectionOpSite`, but keyed on the
 *  BINDING rather than on the receiver being a collection — used by the gate
 *  for the paged-envelope case above. */
export function collectionOpOnBinding(
  e: ExprIR,
  bindings: ReadonlySet<string>,
): string | undefined {
  if (bindings.size === 0) return undefined;
  const named2 =
    (e.kind === "method-call" && isCollectionOp(e.member)) ||
    (e.kind === "member" && isCollectionOp(e.member))
      ? e
      : undefined;
  if (named2 === undefined) return undefined;
  return named2.receiver.kind === "ref" && bindings.has(named2.receiver.name)
    ? named2.member
    : undefined;
}
