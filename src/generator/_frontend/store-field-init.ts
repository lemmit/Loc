// ---------------------------------------------------------------------------
// `store { state { … } }` field initial values — one definition for every
// JS-family frontend (react / vue / svelte / angular).
//
// Why it exists: the four store builders each carried their own
// `storeFieldInit`, and three of them took the field's TYPE only — so a
// declared `store Prefs { state { mode: string = "dark" } }` booted as `""`,
// `pageSize: int = 25` booted as `0`, and nothing warned.  Page `state {}`
// initializers were honoured all along, so the divergence was store-only and
// read as a runtime data bug.  Every shipped example happens to declare
// zero-equal defaults, which is why no fixture caught it.
//
// The URL tier consumes the same value twice: it is the decoder's fallback
// when the query string carries no param for the field, and the encoder's
// "this is the default, drop it from the URL" test — so an absent param and
// the declared default mean the same thing in both directions.
// ---------------------------------------------------------------------------

import type { ExprIR, StateFieldIR } from "../../ir/types/loom-ir.js";
import { defaultInitForJs } from "../_walker/js-target-helpers.js";

/** Render a store-field `= <init>` as JS — a literal (string / number / bool /
 *  null), a list of them, or ARITHMETIC OVER THEM (`1 + 1`, `-5`, `(2 * 3)`);
 *  `undefined` for anything else.
 *
 *  WHY THE CONSTANT TREE IS ADMITTED, not just the bare literal.  A store
 *  initializer is evaluated once, when the store object is constructed, so it
 *  cannot reference store state — which is the real constraint, and the reason
 *  the first version of this function stopped at `literal`.  But "references
 *  state" and "is not a literal" are not the same predicate: a tree of
 *  literals references NOTHING, so it is safe by construction, and the arms
 *  below admit only such trees (no `ref`, no `member`, no call).  Excluding
 *  them fell through to the type ZERO — `state { n: int = 1 + 1 }` booted as
 *  `0`, silently, which is the same wrong-value-no-diagnostic shape this
 *  module exists to close for bare literals.
 *
 *  It also removes a divergence: page `state {}` initializers have always
 *  honoured expressions, and the Feliz / Flutter store emitters render theirs
 *  through their own expression emitters, so the JS family was the odd one out.
 *
 *  No per-frontend renderer is needed. This subset is pure JS operator syntax,
 *  identical on react / vue / svelte / angular, which is exactly why it can
 *  live here rather than behind a callback each store builder supplies. */
function renderStoreInitLiteral(e: ExprIR | undefined): string | undefined {
  if (e === undefined) return undefined;
  if (e.kind === "literal") {
    if (e.lit === "string") return JSON.stringify(e.value);
    if (e.lit === "null") return "null";
    return e.value;
  }
  if (e.kind === "list") {
    const els = e.elements.map(renderStoreInitLiteral);
    return els.every((x): x is string => x !== undefined) ? `[${els.join(", ")}]` : undefined;
  }
  if (e.kind === "paren") {
    const inner = renderStoreInitLiteral(e.inner);
    return inner === undefined ? undefined : `(${inner})`;
  }
  if (e.kind === "unary") {
    const operand = renderStoreInitLiteral(e.operand);
    return operand === undefined ? undefined : `${e.op}${operand}`;
  }
  if (e.kind === "binary") {
    // Loom's arithmetic/comparison operators that are spelled the same in JS.
    // `and`/`or` and the money-aware arms are deliberately absent: a store
    // init has no money receiver to coerce and no state to short-circuit on.
    if (!CONSTANT_JS_BINOPS.has(e.op)) return undefined;
    const left = renderStoreInitLiteral(e.left);
    const right = renderStoreInitLiteral(e.right);
    if (left === undefined || right === undefined) return undefined;
    return `(${left} ${e.op} ${right})`;
  }
  return undefined;
}

/** Binary operators whose Loom spelling IS their JS spelling, so a tree of
 *  literals joined by them renders without a per-frontend emitter. */
const CONSTANT_JS_BINOPS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
]);

/** Initial value for a store field — its declared `= init` literal when it has
 *  one, else the type's zero value (`[]` for arrays, `defaultInitForJs` for
 *  scalars).
 *
 *  A `money` field lowers to `Decimal`, so a numeric `= 0.00` literal must be
 *  CONSTRUCTED rather than assigned raw (a bare number is a TS2322 against the
 *  `Decimal`-typed slot). */
export function storeFieldInitJs(field: StateFieldIR): string {
  const lit = renderStoreInitLiteral(field.init);
  if (lit !== undefined) {
    if (field.type.kind === "primitive" && field.type.name === "money") {
      return `new Decimal(${JSON.stringify(lit)})`;
    }
    return lit;
  }
  return defaultInitForJs(field.type);
}
