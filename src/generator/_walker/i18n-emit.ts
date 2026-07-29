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
//   3. A dynamic slot (a `ref`/state/`+`-concat) → the existing
//      `firstPositionalContent` interpolation. Never translated (there is no
//      stable source string), unchanged on every target.
//
// The translation runtime is a tiny generated `src/i18n.ts` lookup shim (see
// `src/generator/react/i18n-runtime.ts`), NOT react-intl: this slice extracts
// PLAIN literals only, so a `messages[key] ?? default` lookup is exactly
// sufficient. ICU (`react-intl`/placeholders/plurals) arrives with the
// template→ICU interpolation slice, which upgrades the shim.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import { literalString, messageKey } from "./i18n-extract.js";
import { addImport } from "./render-primitive.js";
import { positionalArgs, unwrapTextLiteral } from "./shared/args.js";
import { firstPositionalContent, type WalkContext } from "./walker-core.js";

/** Import specifier for the generated translation helper. Written with the
 *  default one-hop `../` shape; `renderImportLines` rewrites it to the page's
 *  real depth (`../../i18n` for a `src/pages/orders/list.tsx`). */
const I18N_MODULE = "../i18n";

/** Render a user-visible text slot, translating a plain literal through the
 *  generated `t()` helper when the body opted into i18n (`ctx.i18nPrefix`).
 *
 *  `role` MUST match the slot's role in `USER_VISIBLE_SLOTS` so the emitted key
 *  equals the catalog key. `fallback` is the quoted placeholder the emitter
 *  uses when the slot is empty (e.g. `'"Heading"'`). `argIndex` selects the
 *  positional slot (0 for the common single-text primitives; 1 for a `Stat`
 *  value). */
export function localizedText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  fallback: string,
  argIndex = 0,
): string {
  const literal = literalString(positionalArgs(call)[argIndex]);
  if (literal !== undefined && ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    addImport(ctx, I18N_MODULE, "t");
    return ctx.target.renderInterpolation(`t(${JSON.stringify(key)}, ${JSON.stringify(literal)})`);
  }
  // Non-i18n / dynamic / empty — exactly the pre-i18n behaviour.
  const raw = firstPositionalContent(call, ctx) ?? fallback;
  return unwrapTextLiteral(raw, ctx.target.escapeText);
}
