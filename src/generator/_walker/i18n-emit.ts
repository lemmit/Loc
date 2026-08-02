// ---------------------------------------------------------------------------
// i18n emission — the shared translation-runtime seam (M-T1.11, i18n.md Phase 2).
//
// `localizedText` is the drop-in replacement for the
// `unwrapTextLiteral(firstPositionalContent(call, ctx), ctx.target.escapeText)`
// idiom every user-visible text emitter uses. It has THREE behaviours:
//
//   1. A plain string literal in a body that opted into i18n (`ctx.i18nPrefix`
//      set — the React / Vue / Svelte / Angular / Feliz walks set it) → a
//      translation call
//      `{t("<prefix>.<role>.<hash>", "<default>")}`, keyed identically to the
//      `.loom/messages.en.json` catalog (via the SHARED `messageKey`). It also
//      records the `t` import so the page shell emits `import { t } from
//      "../i18n"` (depth-rewritten for nested pages by `renderImportLines`).
//   2. A plain string literal with NO i18n (`ctx.i18nPrefix` absent — a target
//      with no runtime yet, and any app with no extractable strings) → the raw
//      escaped literal. BYTE-IDENTICAL to the pre-i18n path.
//   3. An interpolated slot — a lowered backtick template (`` `Order {o.id}` ``)
//      re-detected as an ICU message via `icuFromConcat` → `{t("<key>", "Order
//      {id}", { id: o.id })}`, keyed identically to the catalog. Only under
//      i18n; a target with no runtime + a dynamic-but-untranslatable slot keep
//      the raw path.
//   4. A dynamic slot with no literal text (a bare `ref`/state, `count + 1`) →
//      the existing `renderTextContent` interpolation. Never translated (no
//      stable source string), unchanged on every target.
//
// The translation runtime is a tiny generated `src/i18n.ts` shim on the four JS
// frontends (see `src/generator/_frontend/i18n-runtime.ts`): a
// `messages[key] ?? default` lookup plus `intl-messageformat` for the ICU
// placeholders. A frontend whose runtime is a different LANGUAGE re-expresses
// the same two halves and overrides the `renderTranslate` seam to spell the call
// (Feliz: an `I18n` F# module in `App.fs`, reaching the SAME
// `intl-messageformat` through Fable interop). A hole may carry a `, format`
// suffix (M-T1.11) — the format text is spliced into the message here
// (`icuFromConcat`), and the runtime locale-formats the raw value.
// ---------------------------------------------------------------------------

import type { ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { ariaLabelAttr, escapeHtmlAttr } from "./a11y-emit.js";
import { chromeKey } from "./i18n-chrome.js";
import { icuFromConcat, literalString, messageKey } from "./i18n-extract.js";
import { addImport } from "./render-primitive.js";
import { namedArgValue, positionalArgs, unwrapTextLiteral } from "./shared/args.js";
import { emitExpr, renderTextContent, type WalkContext } from "./walker-core.js";

/** Import specifier for the generated translation helper. Written with the
 *  default one-hop `../` shape; `renderImportLines` rewrites it to the page's
 *  real depth (`../../i18n` for a `src/pages/orders/list.tsx`). */
const I18N_MODULE = "../i18n";

/** `t()` always returns a `string`, so the interpolation seam is told so.  The
 *  four JSX/markup targets ignore `exprType` (interpolation auto-coerces), which
 *  keeps them byte-identical; Feliz and Flutter read it to drop the redundant
 *  `string (…)` / `'${…}'` coercion around an already-textual value. */
const TRANSLATED: TypeIR = { kind: "primitive", name: "string" };

/** Spell one call into the generated translation runtime, and record the `t`
 *  import the JS frontends need.
 *
 *  The four JS frontends share one `t(key, default, values?)` shim, so the
 *  default spelling here is that JavaScript call — every existing call site is
 *  byte-identical to before this indirection.  A frontend whose runtime is a
 *  different LANGUAGE (Feliz's F#, Flutter's Dart) supplies `renderTranslate`
 *  and spells the same call its own way; the key, the default message and the
 *  ICU hole values are the shared part, so the catalog is unchanged.
 *
 *  The `t` import is added unconditionally: a target with no import map (Feliz
 *  compiles one F# file) simply never reads `WalkResult.imports`. */
function translateCall(
  ctx: WalkContext,
  key: string,
  message: string,
  values?: ReadonlyArray<{ name: string; expr: string }>,
): string {
  addImport(ctx, I18N_MODULE, "t");
  if (ctx.target.renderTranslate) return ctx.target.renderTranslate({ key, message, values });
  const args = [JSON.stringify(key), JSON.stringify(message)];
  if (values) args.push(`{ ${values.map((v) => `${v.name}: ${v.expr}`).join(", ")} }`);
  return `t(${args.join(", ")})`;
}

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
  return localizedRawOf(positionalArgs(call)[argIndex], ctx, role, fallback);
}

/** The shared body behind {@link localizedRaw} (positional) and
 *  {@link localizedNamedRaw} (named) — the three literal / ICU-template /
 *  dynamic-or-off branches over an ALREADY-RESOLVED slot arg.  Keeps the two
 *  entry points reading their arg from different sources (a positional index vs
 *  a named key) while sharing one translation decision. */
function localizedRawOf(
  arg: ExprIR | undefined,
  ctx: WalkContext,
  role: string,
  fallback: string,
): string {
  const literal = literalString(arg);
  if (literal !== undefined && ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    return ctx.target.renderInterpolation(translateCall(ctx, key, literal), TRANSLATED);
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
      const values = icu.holes.map((h) => ({ name: h.name, expr: emitExpr(h.expr, ctx) }));
      return ctx.target.renderInterpolation(
        translateCall(ctx, key, icu.display, values),
        TRANSLATED,
      );
    }
  }
  // Non-i18n / dynamic / empty — exactly the pre-i18n behaviour, at `argIndex`.
  return (arg ? renderTextContent(arg, ctx) : undefined) ?? fallback;
}

/** The NAMED-arg twin of {@link localizedRaw} (`Alert.title` → `alertTitle`,
 *  role in `USER_VISIBLE_SLOTS`).  Reads the named arg (`namedArgValue`) rather
 *  than a positional index, then runs the identical literal / ICU-template /
 *  dynamic / off branches — so a literal `title:` under i18n becomes a `t()`
 *  call keyed to the catalog, and every non-i18n path stays byte-identical.
 *  `fallback` is the quoted placeholder used when the slot is empty. */
export function localizedNamedRaw(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name: string,
  fallback = '""',
): string {
  return localizedRawOf(namedArgValue(call, name), ctx, role, fallback);
}

/** {@link localizedNamedRaw} unwrapped for a JSX/markup-children text position —
 *  the named-slot twin of {@link localizedText} (packs that render the title as
 *  element text, e.g. shadcn's `<AlertTitle>…</AlertTitle>`). */
export function localizedNamedText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name: string,
  fallback: string,
): string {
  return unwrapTextLiteral(
    localizedNamedRaw(call, ctx, role, name, fallback),
    ctx.target.escapeText,
  );
}

/** A COMPLETE bound-attribute fragment for a NAMED user-visible slot rendered
 *  in ATTRIBUTE position (`Alert.title` on Mantine/Vuetify's `title="…"`),
 *  leading space included — the attribute-position twin of {@link localizedText}
 *  and the byte-identical analogue of the old `{{#if hasTitle}} title="{{title}}"`.
 *
 *   - literal + `ctx.i18nPrefix` → a BOUND attribute `renderAttrBinding`-emitted
 *     per frontend (` title={t(key, def)}` React/Svelte, ` :title="t(…)"` Vue,
 *     ` [title]="t(…)"` Angular), keyed identically to the catalog;
 *   - a literal with NO i18n → the static ` title="<escaped-literal>"` fragment
 *     (byte-identical to the pre-i18n Handlebars `title="{{title}}"`);
 *   - a dynamic / absent slot → the empty string (the pre-i18n `hasTitle` guard
 *     already withheld the fragment; nothing to bind).
 *
 *  Unlike {@link localizedAriaLabelAttr} this uses NO `ariaAttrPrefix` — `title`
 *  is a real HTML attribute, not an aria-* one, and no Alert pack binds it on
 *  Angular. */
export function localizedNamedAttr(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name: string,
  attrName: string,
): string {
  const literal = literalString(namedArgValue(call, name));
  if (literal === undefined) return "";
  if (ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    return ctx.target.renderAttrBinding(attrName, translateCall(ctx, key, literal));
  }
  return ` ${attrName}="${escapeHtmlAttr(literal)}"`;
}

/** An ` aria-label="…"` attribute fragment for a NAMED user-visible slot
 *  (`Button.label` → `buttonAria`, `Toolbar.label` → `toolbarAria`), translated
 *  through `t()` when the body opted into i18n (M-T1.11).  Reads the named arg's
 *  string literal (mirroring the extraction pass's `namedArgValue`+`literalString`,
 *  so the emitted key equals the catalog key), and:
 *
 *   - literal + `ctx.i18nPrefix` → a BOUND attribute `renderAttrBinding`-emitted
 *     per frontend (` aria-label={t(key, def)}` on React/Svelte, ` :aria-label="…"`
 *     on Vue, ` [attr.aria-label]="…"` on Angular via `target.ariaAttrPrefix`);
 *   - otherwise (no prefix, a dynamic/absent label) → the static
 *     `ariaLabelAttr(literal ?? defaultLabel)` fragment — BYTE-IDENTICAL to the
 *     pre-i18n path, so every non-JS frontend + a string-less app are unchanged.
 *
 *  `role` MUST match the slot's role in `USER_VISIBLE_SLOTS`.  `defaultLabel`
 *  (Toolbar's "Actions") is a canonical fallback with no source literal — it is
 *  not in the catalog, so it always renders static, never a `t()` call. */
export function localizedAriaLabelAttr(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name = "label",
  defaultLabel?: string,
): string {
  const literal = literalString(namedArgValue(call, name));
  if (literal !== undefined && ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    const attrName = `${ctx.target.ariaAttrPrefix ?? ""}aria-label`;
    return ctx.target.renderAttrBinding(attrName, translateCall(ctx, key, literal));
  }
  return ariaLabelAttr(literal ?? defaultLabel);
}

/** An ` aria-label="…"` fragment for a PACK-CHROME string a design-pack
 *  template bakes in (a spinner's `aria-label="Loading"`) — the chrome twin of
 *  {@link localizedAriaLabelAttr}.  Unlike the named-slot helper the key is the
 *  STABLE, curated `chrome.<name>` (`i18n-chrome.ts`), not a content hash: chrome
 *  is one shared vocabulary across every pack + page.
 *
 *   - `ctx.i18nPrefix` set → a BOUND attribute `renderAttrBinding`-emitted per
 *     frontend (` aria-label={t("chrome.loading","Loading")}` React/Svelte,
 *     ` :aria-label="t(…)"` Vue, ` [attr.aria-label]="t(…)"` Angular via
 *     `ariaAttrPrefix`), keyed to the merged chrome catalog;
 *   - no prefix (every non-JS frontend, a string-less app) → the static
 *     ` aria-label="<english>"` fragment — BYTE-IDENTICAL to the pre-i18n pack
 *     template.
 *
 *  `english` MUST equal `CHROME_MESSAGES[chromeKey(name)]` so the emitted default
 *  lines up with the catalog entry. */
export function localizedChromeAria(ctx: WalkContext, name: string, english: string): string {
  if (ctx.i18nPrefix) {
    const attrName = `${ctx.target.ariaAttrPrefix ?? ""}aria-label`;
    return ctx.target.renderAttrBinding(attrName, translateCall(ctx, chromeKey(name), english));
  }
  return ` aria-label="${escapeHtmlAttr(english)}"`;
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
