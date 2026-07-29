// ---------------------------------------------------------------------------
// i18n emission — the React translation-runtime seam (M-T1.11, i18n.md Phase 2).
//
// `localizedText` is the drop-in replacement for the
// `unwrapTextLiteral(firstPositionalContent(call, ctx), ctx.target.escapeText)`
// idiom every user-visible text emitter uses. It has THREE behaviours:
//
//   1. A plain string literal in a body that opted into i18n (`ctx.i18nPrefix`
//      set — only the React walk sets it) → a translation call
//      `{t("<prefix>.<role>.<hash>", "<default>")}`, keyed identically to the
//      `.loom/messages.en.json` catalog (via the SHARED `messageKey`). It also
//      records the `t` import so the page shell emits `import { t } from
//      "../i18n"` (depth-rewritten for nested pages by `renderImportLines`).
//   2. A plain string literal with NO i18n (`ctx.i18nPrefix` absent — every
//      non-React target, and React apps with no extractable strings) → the raw
//      escaped literal. BYTE-IDENTICAL to the pre-i18n path.
//   3. An interpolated slot — a lowered backtick template (`` `Order {o.id}` ``)
//      re-detected as an ICU message via `icuFromConcat` → `{t("<key>", "Order
//      {id}", { id: o.id })}`, keyed identically to the catalog. Only under
//      i18n; every non-React target + a dynamic-but-untranslatable slot keep the
//      raw path.
//   4. A dynamic slot with no literal text (a bare `ref`/state, `count + 1`) →
//      the existing `renderTextContent` interpolation. Never translated (no
//      stable source string), unchanged on every target.
//
// The translation runtime is a tiny generated `src/i18n.ts` shim (see
// `src/generator/_frontend/i18n-runtime.ts`): a `messages[key] ?? default`
// lookup plus `@formatjs/intl-messageformat` for the ICU placeholders. A hole
// may carry a `, format` suffix (M-T1.11) — the format text is spliced into the
// message here (`icuFromConcat`), and the runtime locale-formats the raw value.
// Plural/select (brace-bodied ICU) are a later slice; the extractor gates them.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { icuFromConcat, literalString, messageKey } from "./i18n-extract.js";
import { addImport } from "./render-primitive.js";
import { positionalArgs, unwrapTextLiteral } from "./shared/args.js";
import { emitExpr, renderTextContent, type WalkContext } from "./walker-core.js";

/** Import specifier for the generated translation helper. Written with the
 *  default one-hop `../` shape; `renderImportLines` rewrites it to the page's
 *  real depth (`../../i18n` for a `src/pages/orders/list.tsx`). */
const I18N_MODULE = "../i18n";

/** The raw text token for a user-visible slot, translating a plain literal
 *  through the generated `t()` helper when the body opted into i18n
 *  (`ctx.i18nPrefix`).  Returns either the interpolation `{t(key, "default")}`
 *  (i18n on), the raw quoted literal `"Badge"`, or a dynamic `{expr}` — the
 *  same token shape `firstPositionalContent` yields.  Callers wrap it for their
 *  slot: `unwrapTextLiteral` for JSX children, `unwrapAsAttr` for an attribute.
 *
 *  `role` MUST match the slot's role in `USER_VISIBLE_SLOTS` so the emitted key
 *  equals the catalog key. `fallback` is the quoted placeholder used when the
 *  slot is empty. `argIndex` selects the positional slot (0 for single-text
 *  primitives; 1 for a `Stat` value). */
export function localizedRaw(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  fallback: string,
  argIndex = 0,
): string {
  const arg = positionalArgs(call)[argIndex];
  const literal = literalString(arg);
  if (literal !== undefined && ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    addImport(ctx, I18N_MODULE, "t");
    return ctx.target.renderInterpolation(`t(${JSON.stringify(key)}, ${JSON.stringify(literal)})`);
  }
  // Interpolated slot (a lowered backtick template) under i18n → an ICU `t()`
  // call: the default carries the named placeholders (`"Order {id}"`), the key
  // is hashed over the positional form, and the holes render into a values
  // object (`{ id: order.id }`) the shim substitutes at runtime.  Keyed
  // identically to the catalog entry (both call `icuFromConcat` + `messageKey`).
  if (arg && ctx.i18nPrefix) {
    const icu = icuFromConcat(arg);
    if (icu) {
      const key = messageKey(ctx.i18nPrefix, role, icu.positional);
      addImport(ctx, I18N_MODULE, "t");
      const values = icu.holes.map((h) => `${h.name}: ${emitExpr(h.expr, ctx)}`).join(", ");
      return ctx.target.renderInterpolation(
        `t(${JSON.stringify(key)}, ${JSON.stringify(icu.display)}, { ${values} })`,
      );
    }
  }
  // Non-i18n / dynamic / empty — exactly the pre-i18n behaviour, at `argIndex`.
  return (arg ? renderTextContent(arg, ctx) : undefined) ?? fallback;
}

/** {@link localizedRaw} unwrapped for a JSX-children text position — the
 *  drop-in replacement for `unwrapTextLiteral(firstPositionalContent(...))`. */
export function localizedText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  fallback: string,
  argIndex = 0,
): string {
  return unwrapTextLiteral(
    localizedRaw(call, ctx, role, fallback, argIndex),
    ctx.target.escapeText,
  );
}
