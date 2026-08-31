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

/** Render a store-field `= <init>` literal (string / number / bool / null, or
 *  a list of literals); `undefined` for anything non-literal — an init
 *  expression would evaluate before the store exists, so it cannot reference
 *  state and is not admitted here. */
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
  return undefined;
}

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
