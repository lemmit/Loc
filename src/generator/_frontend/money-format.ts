// The one owner of money DISPLAY semantics for the Handlebars frontends
// (M-T1.25).  Emitted verbatim into the `src/lib/format.*` every React / Vue /
// Svelte / Angular project already ships, so all 15 design packs render a
// money value the same way — their `MoneyValue` / `formatMoney` helper keeps
// its own markup wrapper and delegates the SEMANTICS here.
//
// Why this exists: every pack used to do
// `Number(value)` → `Intl.NumberFormat(undefined, { style: "currency",
// currency: "USD", maximumFractionDigits: 2 })`.  That is wrong three times
// over for a Loom `money`:
//
//   1. Loom money has NO currency dimension (M-T2.12 owns adding one), so the
//      "$" was fabricated by the toolchain, not carried by the model;
//   2. the wire form is the RS-12 fixed-scale decimal STRING (`"12.3456"`) at
//      scale 4 — `maximumFractionDigits: 2` made the stored 4th decimal
//      unreachable in the UI;
//   3. `Number()` is a float hop that `NUMERIC(19,4)`'s 19 significant digits
//      do not survive.
//
// The contract, therefore:
//
//   * DEFAULT = VERBATIM.  Render the value's own digits, locale-neutral: no
//     `Number()`, no grouping separators, no currency, no re-scaling.
//   * `decimals: n` (a declared `Money(x, decimals: 2)` argument) re-scales to
//     exactly n fraction digits, rounding half-away-from-zero ON THE DIGIT
//     STRING — the same rounding family the five backends and Postgres use,
//     and never through a float.
//   * `currency: "EUR"` (a declared argument) prefixes the code THE CALLER
//     PASSED, verbatim.  Never a symbol the toolchain guessed.  This is what
//     the Feliz target already emits, so the two engines agree by construction.
//
// Both knobs are pre-existing, user-declared DSL arguments carried through the
// walker (`src/generator/_walker/primitives/text.ts` → `hasCurrency` /
// `hasDecimals`); no new pack-manifest knob is introduced.

/** The `moneyText` module source spliced into each pack's `format-helpers`
 *  emit.  Framework-neutral and JSX-free, so React, Vue, Svelte and Angular
 *  (and the behavioural test) all execute the same implementation. */
export const MONEY_TEXT_SOURCE = `/** Render a money value's own digits, faithfully (generated — M-T1.25).
 *
 *  Loom money rides the wire as a fixed-scale decimal STRING ("12.3456") and
 *  is a decimal.js instance in form state; both stringify to the same digits.
 *  The default rendering is VERBATIM and locale-neutral — no Number()
 *  coercion, no locale grouping, no currency symbol, no re-scaling — so what
 *  the database stores is what the screen shows.
 *
 *  @param currency  Optional currency CODE, printed verbatim as a prefix
 *                   ("EUR 12.3456").  Only ever what the page source declared.
 *  @param decimals  Optional exact fraction-digit count; re-scales the digit
 *                   string (half away from zero), never through a float.
 */
export function moneyText(
  value: number | string | { toString(): string },
  currency?: string,
  decimals?: number,
): string {
  const raw = typeof value === "string" ? value : String(value);
  const body = decimals === undefined ? raw : scaleDecimalString(raw, decimals);
  return currency ? currency + " " + body : body;
}

/** Re-scale a decimal STRING to exactly \`digits\` fraction digits.
 *
 *  Operates on the digits themselves — pad with zeros when widening, and when
 *  narrowing round half AWAY FROM ZERO by incrementing the retained digit
 *  string.  This is the rounding family every Loom backend and Postgres itself
 *  uses, and it keeps all 19 significant digits of NUMERIC(19,4) intact (a
 *  float hop would not).  A value that is not a plain decimal literal, or a
 *  negative \`digits\`, is returned untouched.
 */
export function scaleDecimalString(raw: string, digits: number): string {
  const m = /^([+-]?)(\\d+)(?:\\.(\\d*))?$/.exec(raw.trim());
  const n = Math.trunc(digits);
  if (!m || !Number.isFinite(n) || n < 0) {
    return raw;
  }
  const sign = m[1] === "-" ? "-" : "";
  const frac = m[3] ?? "";
  let intPart = m[2];
  let kept = frac.slice(0, n);
  if (frac.length <= n) {
    kept = frac + "0".repeat(n - frac.length);
  } else if (frac.charCodeAt(n) >= 53 /* '5' */) {
    const bumped = bumpDigits(intPart + kept);
    intPart = bumped.slice(0, bumped.length - n);
    kept = bumped.slice(bumped.length - n);
  }
  intPart = intPart.replace(/^0+(?=\\d)/, "");
  return sign + intPart + (n > 0 ? "." + kept : "");
}

/** Add one to a string of decimal digits, carrying left and growing a new
 *  leading digit when the whole string was nines ("999" -> "1000"). */
function bumpDigits(s: string): string {
  const out = s.split("");
  let i = out.length - 1;
  for (; i >= 0; i--) {
    if (out[i] === "9") {
      out[i] = "0";
      continue;
    }
    out[i] = String(Number(out[i]) + 1);
    break;
  }
  if (i < 0) {
    out.unshift("1");
  }
  return out.join("");
}`;
