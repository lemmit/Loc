// Scalar-intrinsic snippet table for the JAVASCRIPT emission family
// (`src/util/intrinsics.ts` — one arm per catalogue row, keyed
// `<receiver>.<name>` via `intrinsicKey`).
//
// This lives in a shared `_` dir because it has TWO consumers that emit the
// SAME language: the Hono/TypeScript backend (`typescript/render-expr.ts`,
// which re-exports it as `TS_INTRINSIC_RENDERERS`) and the four JS-embedding
// frontend walkers (React / Vue / Svelte / Angular, via `jsExprLeaves`).
// Keeping one table is the point: an intrinsic must mean the same thing in an
// aggregate `derived` and in a page body.  Before this was shared, the walker
// had no intrinsic arm at all and emitted the Loom spelling verbatim — which
// is a TS2339 for the ops JS spells differently (`toUpper` / `toLower` /
// `contains`) and, worse, SILENTLY WRONG for the two JS happens to spell the
// same but define differently:
//
//   Loom `s.replace(a, b)`      = replace ALL   → JS `.replaceAll(a, b)`
//     (bare `.replace(a, b)` replaces only the FIRST occurrence)
//   Loom `s.substring(start, len)` = start+LENGTH → JS `.slice(s, s + len)`
//     (bare `.substring(a, b)` takes start+END indices)
//
// `money` is decimal.js `Decimal` on BOTH surfaces (the frontend's
// `moneySchema` parses a decimal string into a `Decimal`, and `jsExprLeaves`
// already emits `new Decimal(...)` for a money `convert`), so the money arms
// are shared verbatim too.  The arms that name the `Decimal` binding need it
// imported wherever they land; each page shell decides that by scanning its
// rendered source — see `usesDecimalBinding`.

import type { TypeIR } from "../../ir/types/loom-ir.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
export const JS_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `${recv}.trim()`,
  "string.toUpper": (recv) => `${recv}.toUpperCase()`,
  "string.toLower": (recv) => `${recv}.toLowerCase()`,
  // 0-based clamping semantics = JS slice (see the catalogue contract).
  "string.substring": (recv, args) =>
    args.length > 1
      ? `${recv}.slice(${args[0]}, (${args[0]}) + (${args[1]}))`
      : `${recv}.slice(${args[0]})`,
  "string.startsWith": (recv, args) => `${recv}.startsWith(${args[0]})`,
  "string.endsWith": (recv, args) => `${recv}.endsWith(${args[0]})`,
  "string.contains": (recv, args) => `${recv}.includes(${args[0]})`,
  "string.replace": (recv, args) => `${recv}.replaceAll(${args[0]}, ${args[1]})`,
  "string.split": (recv, args) => `${recv}.split(${args[0]})`,
  // ---- numerics (A3) -------------------------------------------------------
  // `money` is decimal.js `Decimal` on this backend; int/long/decimal are
  // plain numbers (see the catalogue's representation note).  Loom
  // expressions are pure, so a snippet may mention `recv` more than once.
  "int.abs": (recv) => `Math.abs(${recv})`,
  "long.abs": (recv) => `Math.abs(${recv})`,
  "decimal.abs": (recv) => `Math.abs(${recv})`,
  "money.abs": (recv) => `${recv}.abs()`,
  // Truncating integer division (toward zero) — `Math.trunc` on the float quotient.
  "int.divTrunc": (recv, args) => `Math.trunc(${recv} / ${args[0]})`,
  "long.divTrunc": (recv, args) => `Math.trunc(${recv} / ${args[0]})`,
  "int.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `Decimal.min(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `Decimal.max(${recv}, ${args[0]})`,
  // HALF-AWAY-FROM-ZERO (catalogue contract) — `Math.round` alone rounds
  // -2.5 UP to -2, so route through sign/abs on the float path.  Self-
  // parenthesized: the snippet lands in arbitrary expression slots.
  "decimal.round": (recv, args) =>
    args.length > 0
      ? `(Math.sign(${recv}) * (Math.round(Math.abs(${recv}) * 10 ** (${args[0]})) / 10 ** (${args[0]})))`
      : `(Math.sign(${recv}) * Math.round(Math.abs(${recv})))`,
  "money.round": (recv, args) =>
    `${recv}.toDecimalPlaces(${args[0] ?? "0"}, Decimal.ROUND_HALF_UP)`,
  "decimal.floor": (recv) => `Math.floor(${recv})`,
  "decimal.ceil": (recv) => `Math.ceil(${recv})`,
  "money.floor": (recv) => `${recv}.floor()`,
  "money.ceil": (recv) => `${recv}.ceil()`,
  // ---- datetime ------------------------------------------------------------
  // Midnight UTC of the receiver's day (catalogue contract) — built from the
  // UTC field readers so the bucket boundary never follows the host's local
  // zone (`setHours(0,…)` would).  Loom expressions are pure, so mentioning
  // `recv` three times is safe.
  "datetime.startOfDay": (recv) =>
    `new Date(Date.UTC((${recv}).getUTCFullYear(), (${recv}).getUTCMonth(), (${recv}).getUTCDate()))`,
};

/**
 * True when `source` references decimal.js's `Decimal` binding — either the
 * CONSTRUCTOR (`new Decimal(…)`, which `jsExprLeaves.exprConvert` emits for a
 * cast to money) or a STATIC (`Decimal.min(…)`, `Decimal.ROUND_HALF_UP`, from
 * the table above).  Both need the binding in scope wherever the source lands.
 *
 * Matched on RENDERED source rather than on a declaration, because that is the
 * only signal covering both producers at once — and it cannot drift out of
 * sync with the tables the way a hand-kept key list would.  The pattern is
 * deliberately narrow (a construction or a member access, never the bare
 * word), so a literal `"Decimal"` in user-authored page text does not trip it.
 *
 * This used to be a private `needsDecimalImport`, used to make
 * `renderJsIntrinsic` DECLINE the three arms that hit it — `money.min`,
 * `money.max`, `money.round` — because the frontend PAGE shells never imported
 * decimal.js (only `store-builder.ts` did).  Declining did not avoid broken
 * output, it chose a different one: the walker's verbatim
 * `<recv>.<member>(…)` fallthrough emitted `amt.min(x)` / `amt.max(x)`, for
 * which decimal.js has no INSTANCE method (TS2339), and `amt.round(2)`, whose
 * instance method takes no arguments (TS2554).  Since no `.ddd` in the repo
 * put a money intrinsic in a page body, no build gate ever said so.
 *
 * Now every page shell consumes this to bring the binding into scope itself,
 * so the arms render.
 */
export function usesDecimalBinding(source: string): boolean {
  return /\bnew Decimal\(|\bDecimal\.[a-zA-Z]/.test(source);
}

/**
 * Render a scalar intrinsic for a JS-embedding frontend walker, or `undefined`
 * when this member is not a catalogue intrinsic on this receiver (the caller
 * then falls through to its ordinary member/method-call emission).
 *
 * `receiverType` must be the METHOD-CALL's receiver type: intrinsics are
 * receiver-qualified (`string.contains` is a substring test, `T[].contains` is
 * the collection membership op), and lowering already keys that distinction
 * off the receiver — a primitive receiver with a catalogue intrinsic is never
 * flagged `isCollectionOp`.
 */
export function renderJsIntrinsic(
  receiverType: TypeIR,
  member: string,
  recv: string,
  args: readonly string[],
): string | undefined {
  if (receiverType.kind !== "primitive") return undefined;
  if (!intrinsicFor(receiverType.name, member)) return undefined;
  const render = JS_INTRINSIC_RENDERERS[intrinsicKey(receiverType.name, member)];
  if (!render) return undefined;
  return render(recv, [...args]);
}
