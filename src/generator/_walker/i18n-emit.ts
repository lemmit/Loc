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
import { chromeKey, chromeMessage } from "./i18n-chrome.js";
import { icuFromConcat, literalString, messageKey } from "./i18n-extract.js";
import { registerI18nImport } from "./render-primitive.js";
import { namedArgValue, positionalArgs, unwrapTextLiteral } from "./shared/args.js";
import type { StringPart } from "./target.js";
import { emitExpr, renderTextContent, type WalkContext } from "./walker-core.js";

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
  registerI18nImport(ctx);
  return translateExpr(ctx, key, message, values);
}

/** {@link translateCall} WITHOUT the import registration — the seam application
 *  alone.
 *
 *  Split out for pack chrome that lands in a HOISTED CHILD file: on Vue, Svelte
 *  and Angular a `DataGrid`'s markup is emitted into a separate component, so
 *  the page's import map is the wrong place for its `t` and the child's own
 *  renderer places the import (see `localizedChromeText` below).  Everything
 *  else — the seam, the default JS spelling, the argument order — is shared, so
 *  a chrome call and an authored-string call are spelled identically on every
 *  frontend. */
function translateExpr(
  ctx: WalkContext,
  key: string,
  message: string,
  values?: ReadonlyArray<{ name: string; expr: string }>,
): string {
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
  const icu = icuTranslateCall(arg, ctx, role);
  if (icu) return ctx.target.renderInterpolation(icu, TRANSLATED);
  // Non-i18n / dynamic / empty — exactly the pre-i18n behaviour, at `argIndex`.
  return (arg ? renderTextContent(arg, ctx) : undefined) ?? fallback;
}

/** The INTERPOLATED-slot branch, shared by the text-position localizer above and
 *  the three ATTRIBUTE-position ones below.
 *
 *  A lowered backtick template (`` `Delete {order.id}` ``) under i18n becomes an
 *  ICU `t()` call: the default carries the named placeholders (`"Delete {id}"`),
 *  the key is hashed over the positional form, and the holes render into a values
 *  object (`{ id: order.id }`) the shim substitutes at runtime.  Keyed identically
 *  to the catalog entry, because both sides call `icuFromConcat` + `messageKey`.
 *
 *  Returns `undefined` when there is nothing to translate — i18n is off, the slot
 *  is absent, or the expression is not an interpolated template at all (a bare
 *  `label: row.name` is dynamic but carries no translatable TEXT, so
 *  `icuFromConcat` rejects it and the caller's raw-expression branch still runs).
 *
 *  This lives here rather than at each call site because the ATTRIBUTE helpers
 *  originally had only two branches — literal and raw-expression — so an
 *  interpolated `label:`/`title:` fell straight through to concatenation while the
 *  extraction pass still wrote its ICU entry into the catalog.  That is the
 *  dead-key shape `user-visible-slot-coverage.test.ts` cannot see (the slot DOES
 *  render, just not through `t()`), and it emitted the very concatenation
 *  `loom.user-visible-concat` bans in `.ddd` source. */
function icuTranslateCall(
  arg: ExprIR | undefined,
  ctx: WalkContext,
  role: string,
): string | undefined {
  if (!arg || !ctx.i18nPrefix) return undefined;
  const icu = icuFromConcat(arg);
  if (!icu) return undefined;
  const key = messageKey(ctx.i18nPrefix, role, icu.positional);
  const values = icu.holes.map((h) => ({ name: h.name, expr: emitExpr(h.expr, ctx) }));
  return translateCall(ctx, key, icu.display, values);
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
  const arg = namedArgValue(call, name);
  const literal = literalString(arg);
  if (literal === undefined) {
    // INTERPOLATED (`` title: `Order {o.id}` ``) — a real translatable message.
    const icu = icuTranslateCall(arg, ctx, role);
    if (icu) return ctx.target.renderAttrBinding(attrName, icu);
    // DYNAMIC (`title: order.status`) — no stable source string, so nothing to
    // translate, but the value is still the author's user-visible text.  Bind
    // the expression rather than dropping the attribute: silently rendering a
    // titled Alert with no title is the same dead-slot bug a missing template
    // branch causes.  Absent slot → still the empty fragment.
    return arg ? ctx.target.renderAttrBinding(attrName, emitExpr(arg, ctx)) : "";
  }
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
  const arg = namedArgValue(call, name);
  const literal = literalString(arg);
  const attrName = `${ctx.target.ariaAttrPrefix ?? ""}aria-label`;
  if (literal !== undefined && ctx.i18nPrefix) {
    const key = messageKey(ctx.i18nPrefix, role, literal);
    return ctx.target.renderAttrBinding(attrName, translateCall(ctx, key, literal));
  }
  // INTERPOLATED (`` label: `Delete {order.id}` ``) — a real translatable
  // message, so the accessible name translates like any other slot.
  const icu = icuTranslateCall(arg, ctx, role);
  if (icu) return ctx.target.renderAttrBinding(attrName, icu);
  // DYNAMIC (`label: row.name`) — no stable source string to translate, but
  // dropping it left an icon-only Button with NO accessible name at all, on a
  // control whose a11y contract says `needsName` (WCAG 4.1.2).  The
  // `loom.a11y-icon-only-no-name` validator stays quiet precisely because a
  // `label:` IS present, so nothing else catches it.  Bind the expression.
  if (literal === undefined && arg) {
    return ctx.target.renderAttrBinding(attrName, emitExpr(arg, ctx));
  }
  return ariaLabelAttr(literal ?? defaultLabel);
}

/** A NAMED user-visible slot as a TARGET-NATIVE EXPRESSION — the value-position
 *  twin of {@link localizedAriaLabelAttr}.
 *
 *  Two kinds of caller need a value rather than markup: the frontends whose
 *  markup is NOT HTML (Feliz's F# props, Flutter's Dart args), and any pack slot
 *  that is a plain JS EXPRESSION rather than an element (Mantine's
 *  `modals.open({ title: … })`).
 *
 *  D-I18N-ATTR (M-T1.11): **the a11y helper emits an already-TRANSLATED value;
 *  a pack never resolves a key.**  One accessible name, two renderings, both
 *  derived here from the SAME `messageKey()` the extraction pass uses:
 *
 *   - the HTML-ish attribute FRAGMENT (`localizedAriaLabelAttr`) — spliced
 *     verbatim by the four JSX/markup frontends, whose packs are `.hbs`
 *     templates that can only interpolate text;
 *   - this VALUE (`localizedNamedValue`) — an expression in the target's own
 *     language, for the procedural packs that build props rather than markup
 *     (Feliz `prop.ariaLabel <expr>`, Flutter `Semantics(label: <expr>)`).
 *
 *  The alternative — hand the pack the KEY and let it call the runtime — was
 *  rejected: it duplicates the "is this app i18n-enabled at all" decision into
 *  every pack, and a pack that forgets the check emits a `t()` call into an app
 *  with no runtime.  Deciding once here keeps the i18n-OFF path byte-identical
 *  by construction.
 *
 *  Returns `undefined` only when the slot carries no name AT ALL (no arg, no
 *  `defaultLabel`) — the caller omits the prop, matching the empty-string
 *  fragment `ariaLabelAttr` yields.  A DYNAMIC (non-literal) slot has no stable
 *  source string to translate, but it is still the author's user-visible text,
 *  so it renders as the target's own expression rather than vanishing. */
export function localizedNamedValue(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name = "label",
  defaultLabel?: string,
): string | undefined {
  const arg = namedArgValue(call, name);
  const literal = literalString(arg);
  if (literal !== undefined && ctx.i18nPrefix) {
    return translateCall(ctx, messageKey(ctx.i18nPrefix, role, literal), literal);
  }
  // INTERPOLATED — the value-position twin of the fragment helpers' ICU branch,
  // so Feliz's `prop.ariaLabel` / Flutter's `Semantics(label:)` translate too.
  const icu = icuTranslateCall(arg, ctx, role);
  if (icu) return icu;
  if (literal === undefined && arg) return emitExpr(arg, ctx);
  const text = literal ?? defaultLabel;
  if (text === undefined || text === "") return undefined;
  return stringLiteral(ctx, text);
}

/** A plain string literal in the target's own expression language — the
 *  `renderStringLiteral` seam, JSON-quoted when a target leaves it unset. */
function stringLiteral(ctx: WalkContext, text: string): string {
  return ctx.target.renderStringLiteral?.(text) ?? JSON.stringify(text);
}

/** A string built from literal + expression pieces in the target's own language
 *  — the `renderStringConcat` seam, a JS template literal when a target leaves
 *  it unset (which is what React, Svelte and Vue already spelled). */
function stringConcat(ctx: WalkContext, parts: readonly StringPart[]): string {
  return ctx.target.renderStringConcat?.(parts) ?? jsTemplateLiteral(parts);
}

/** The default `renderStringConcat`: a JS template literal.  Literal pieces are
 *  escaped for a backtick body (backslash, backtick, and the `${` that would
 *  otherwise open a hole); expression pieces are spliced verbatim. */
function jsTemplateLiteral(parts: readonly StringPart[]): string {
  const body = parts
    .map((p) =>
      "expr" in p
        ? `\${${p.expr}}`
        : p.text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${"),
    )
    .join("");
  return `\`${body}\``;
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

/** A pack-chrome string the WALKER builds, rendered INTO THE PAGE, as a
 *  markup-TEXT token — `{t("chrome.<name>", "<english>", { … })}` under i18n,
 *  the escaped literal otherwise (byte-identical).
 *
 *  Chrome the emitter constructs from model data — the destroy button's
 *  `Delete <Aggregate>`, its `window.confirm` prompt, an op dialog's Cancel —
 *  reached NO catalog: the content-hash extraction pass only sees literals in
 *  the `.ddd` body, and the pack-chrome slice only covers `.hbs` templates.
 *
 *  `values` carries the ICU holes (`{entity}`), whose values are DSL
 *  identifiers: they stay as authored while the sentence around them
 *  translates.  Unlike the hoisted-child helpers below this DOES register the
 *  `t` import — the markup lands in the page itself.
 *
 *  For a holed sentence whose values are RUNTIME expressions rather than
 *  generate-time identifiers — a pager's "Page {page} of {pages}", a column
 *  control's "Sort by {column}" — see {@link localizedChromeIcuText} and its
 *  siblings.  `fillHoles` below cannot serve those: substituting a live
 *  expression into the sentence would emit it as literal TEXT. */
export function localizedPageChromeText(
  ctx: WalkContext,
  name: string,
  values?: ReadonlyArray<{ name: string; expr: string }>,
): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) {
    return unwrapTextLiteral(
      ctx.target.renderInterpolation(
        translateCall(ctx, chromeKey(name), english, values),
        TRANSLATED,
      ),
      ctx.target.escapeText,
    );
  }
  return fillHoles(english, values);
}

/** {@link localizedPageChromeText} as a target-native EXPRESSION — for a slot
 *  that is a JS/Dart/F# value rather than markup (a `window.confirm(…)`
 *  argument). */
export function localizedPageChromeValue(
  ctx: WalkContext,
  name: string,
  values?: ReadonlyArray<{ name: string; expr: string }>,
): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) return translateCall(ctx, chromeKey(name), english, values);
  return JSON.stringify(fillHoles(english, values));
}

/** Substitute ICU `{hole}`s with their rendered values — the i18n-OFF spelling,
 *  where the sentence is a plain string rather than a runtime `t()` call.  Only
 *  QUOTED literal values are inlined (chrome holes are model-derived names). */
function fillHoles(
  english: string,
  values?: ReadonlyArray<{ name: string; expr: string }>,
): string {
  let out = english;
  for (const v of values ?? []) {
    const literal = /^"(.*)"$/.exec(v.expr);
    out = out.replace(`{${v.name}}`, literal ? literal[1]! : v.expr);
  }
  return out;
}

// --- Chrome that lands in a HOISTED CHILD file -----------------------------
//
// `localizedChromeAria` above registers the `t` import on the walk context,
// which is right for chrome rendered INTO THE PAGE.  The two helpers below
// deliberately do NOT: a `DataGrid`'s pack markup is rendered into a hoisted
// CHILD component (`renderDataGridChild`), and on Vue/Svelte/Angular that child
// is a SEPARATE FILE — so the page's import map is the wrong place for its `t`.
// Each target's child renderer places the import (or, on Angular, the class
// member) itself; see `data-grid-child.ts` on all four JS frontends.
//
// Both read the English from `chromeMessage(name)` rather than taking it as an
// argument, so the emitted `t()` default cannot drift from the catalog entry.

/** Register the `t` import on the page's import map.
 *
 *  The chrome helpers below deliberately do NOT, because their markup may land
 *  in a hoisted CHILD file — but chrome rendered straight INTO THE PAGE
 *  (`SelectField`, a form's field inputs) resolves `t` against the page's own
 *  import block and must ask for it.  Exported so those call sites don't repeat
 *  the module specifier, which only this file should know. */
export { registerI18nImport };

/** The literal prefix of every chrome `t()` binding {@link localizedChromeText}
 *  and {@link localizedChromeAttr} emit.
 *
 *  A hoisted-child renderer greps its RENDERED body for this to decide whether
 *  that file needs `t` wired in — the honest question, because whether the
 *  chrome appears at all is the active design pack's call (a pack with no pager
 *  renders none).  Precise on purpose: a looser `"t("` test matches
 *  `getContext(`, `format(` and friends. */
export const CHROME_T_CALL = 't("chrome.';

/** A pack-chrome string in a TEXT/children position (a grid pager's
 *  "Previous"), for markup that may land in a hoisted child file.
 *
 *   - `ctx.i18nPrefix` set → the per-frontend interpolation of the `t()` call
 *     (`{t("chrome.previous","Previous")}` on React/Svelte, `{{ t(…) }}` on
 *     Vue/Angular), keyed to the merged chrome catalog;
 *   - no prefix (a frontend with no i18n runtime, a string-less app) → the
 *     escaped English — BYTE-IDENTICAL to the pre-i18n pack template.
 *
 *  Registers no import — see the section note above. */
export function localizedChromeText(ctx: WalkContext, name: string): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) {
    return ctx.target.renderInterpolation(translateExpr(ctx, chromeKey(name), english));
  }
  return ctx.target.escapeText(english);
}

/** A pack-chrome string with ICU HOLES in a TEXT/children position — a grid
 *  pager's "Page 3 of 7" — for markup that may land in a hoisted child file.
 *
 *  The chrome catalog stays exactly what it was: `chrome.pageOf` is the STATIC
 *  string `"Page {page} of {pages}"`, so an extractor, a translator and a locale
 *  file all see one ordinary ICU message.  What is new is only that the emitter
 *  supplies the hole VALUES, in the target's own expression language.
 *
 *   - `ctx.i18nPrefix` set → the interpolated `t(key, default, { page: … })`
 *     call; the runtime's `intl-messageformat` substitutes and locale-formats
 *     the numbers, so a locale is free to re-ORDER the holes ("Seite 3 von 7",
 *     `{pages}`-first languages included) — the whole reason this is one message
 *     rather than three concatenated fragments;
 *   - no prefix → the message re-assembled AROUND the holes: literal segments
 *     escaped, each `{name}` replaced by the target's interpolation of its
 *     expression.  That reproduces the pre-i18n pack template byte for byte
 *     (`Page {expr} of {expr}` on React/Svelte, `Page {{ expr }} of {{ expr }}`
 *     on Vue/Angular) — which is why the template can hand its two expressions
 *     over and stop spelling the sentence itself.
 *
 *  Registers no import — see the section note above.
 *
 *  NOT {@link localizedPageChromeText}, whose signature is identical and whose
 *  job is not.  That one fills its holes with GENERATE-TIME constants (an
 *  aggregate's name), so with i18n off it substitutes them and hands back a
 *  finished string; and it registers `t`, because its markup lands in the page.
 *  This one's holes are RUNTIME expressions, so the off-path has to re-assemble
 *  the sentence around them rather than into them — and its markup lands in a
 *  hoisted child, which owns its own `t`.  Pick by where the hole's value comes
 *  from, not by which name reads better at the call site. */
export function localizedChromeIcuText(
  ctx: WalkContext,
  name: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) {
    return ctx.target.renderInterpolation(
      translateExpr(ctx, chromeKey(name), english, values),
      TRANSLATED,
    );
  }
  // No `TRANSLATED` here: with i18n off the holes carry their OWN types (a page
  // NUMBER, not a string), and the two targets that read `exprType` coerce
  // accordingly.  Claiming `string` would drop a coercion they need.
  return spliceIcuHoles(
    english,
    values,
    (expr) => ctx.target.renderInterpolation(expr),
    (text) => ctx.target.escapeText(text),
  );
}

/** The ICU twin of {@link localizedChromeValue}: the bound `t()` EXPRESSION for
 *  a holed chrome string, for a procedural pack that splices it into its own
 *  language rather than into markup (Feliz's `prop.text (…)`).
 *
 *  Returns `undefined` with i18n off — deliberately, and unlike
 *  {@link localizedChromeIcuText}.  Re-assembling the message around its holes
 *  needs a CONCATENATION spelling (F#'s `"a" + string (e) + "b"`), and inventing
 *  a seam for it would put the pre-i18n output at the mercy of that seam getting
 *  the parens and coercions exactly right.  A pack instead keeps its existing
 *  hand-written sentence as the `??` fallback, so the i18n-off path is
 *  byte-identical BY CONSTRUCTION rather than by reconstruction — the same trade
 *  {@link localizedAriaLabelValue} makes when it returns `undefined` for a slot
 *  with nothing to bind. */
export function localizedChromeIcuValue(
  ctx: WalkContext,
  name: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
): string | undefined {
  if (!ctx.i18nPrefix) return undefined;
  return translateExpr(ctx, chromeKey(name), chromeMessage(name), values);
}

/** An ICU-holed chrome string as an ` aria-label` ATTRIBUTE fragment — a grid's
 *  per-column "Sort by {column}" / "Filter by {column}".
 *
 *  Returns the complete fragment with NO leading space, like
 *  {@link localizedChromeAttr}: these sit on their own indented line in the pack
 *  templates, so the token stands exactly where the static attribute stood.
 *
 *   - i18n on → the target's bound attribute over the `t()` call
 *     (`[attr.aria-label]` on Angular via `ariaAttrPrefix`);
 *   - off → the same bound attribute over the message re-assembled by
 *     `renderStringConcat`, which is a JS template literal by default — exactly
 *     what React/Svelte/Vue spelled by hand, and what Angular's override spells
 *     as `'Sort by ' + <expr>`.
 *
 *  Unlike the counter, the off-path here needed a SEAM rather than a caller
 *  fallback: the message lands in fifteen `.hbs` templates whose token is built
 *  once, in target-neutral code, so there is no per-dialect caller to ask.
 *
 *  Registers no import — this markup lands in the hoisted child, like the rest
 *  of the grid's chrome. */
export function localizedChromeIcuAria(
  ctx: WalkContext,
  name: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
): string {
  return ctx.target
    .renderAttrBinding(ariaLabelAttrName(ctx), localizedChromeIcuExpr(ctx, name, values))
    .trimStart();
}

/** The HOLE-FREE sibling of {@link localizedChromeIcuAria}: a plain chrome
 *  string as an ` aria-label` attribute, for markup that lands in a hoisted
 *  CHILD file (a grid's row-selection checkboxes).
 *
 *  Not {@link localizedChromeAria}, which is the PAGE-side helper — it registers
 *  the `t` import and returns a leading-space fragment.  Not
 *  {@link localizedChromeIcuAria} with an empty `values` either: that would route
 *  through `renderStringConcat` and spell the i18n-off form as a one-piece
 *  template literal (`` `Select row` ``) where the pre-i18n markup had a plain
 *  quoted attribute.  A message with no holes is not a concatenation, so it
 *  takes the ordinary attribute path and stays byte-identical. */
export function localizedChromeAriaAttr(ctx: WalkContext, name: string): string {
  return localizedChromeAttr(ctx, ariaLabelAttrName(ctx), name);
}

/** `aria-label`, or the target's binding-safe spelling of it (`attr.aria-label`
 *  on Angular, whose `[aria-label]` would bind a non-existent DOM property). */
function ariaLabelAttrName(ctx: WalkContext): string {
  return `${ctx.target.ariaAttrPrefix ?? ""}aria-label`;
}

/** An ICU-holed chrome string as a target-native EXPRESSION, always defined —
 *  for a procedural pack that builds props (Feliz's `prop.ariaLabel (…)`,
 *  Flutter's `Semantics(label: …)`), and the expression half of
 *  {@link localizedChromeIcuAria}.
 *
 *  The sibling of {@link localizedChromeIcuValue}, and the two differ only in
 *  what happens with i18n OFF — which is the whole question for a holed message,
 *  since it has to be re-spelled as a concatenation:
 *
 *   - THIS one re-spells it, through the `renderStringConcat` seam.  Right when
 *     the caller's existing raw form IS a concatenation, which the seam then
 *     reproduces byte for byte.
 *   - `localizedChromeIcuValue` returns `undefined` and lets the caller keep its
 *     own sentence.  Right when the raw form is something a concat seam cannot
 *     spell — Feliz's pager `sprintf "Page %d of %d"`, Flutter's `'Page $p of
 *     $n'` interpolation.
 *
 *  Hole expressions must already be STRINGS: the seam concatenates, it does not
 *  coerce, because a coercion the source never had would break byte-identity.
 *
 *  Registers no import — see the section note above. */
export function localizedChromeIcuExpr(
  ctx: WalkContext,
  name: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) return translateExpr(ctx, chromeKey(name), english, values);
  return stringConcat(ctx, icuParts(english, values));
}

/** Cut an ICU message into its alternating literal / hole pieces — the one place
 *  the catalog's `{name}` grammar is read, shared by the two i18n-off paths (the
 *  markup splice below and the `renderStringConcat` assembly above).
 *
 *  Throws on a hole with no supplied value rather than passing the `{name}`
 *  through — a literal `{page}` in JSX children is a syntax error at best and a
 *  visible "{page}" at worst, and either would only surface in a generated
 *  project.  The catalog message and the emitter's value list are two halves of
 *  one contract; this is where they are checked against each other. */
function icuParts(
  message: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
): StringPart[] {
  const byName = new Map(values.map((v) => [v.name, v.expr]));
  const pattern = /\{(\w+)\}/g;
  const parts: StringPart[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    if (text !== "") parts.push({ text });
  };
  for (let m = pattern.exec(message); m !== null; m = pattern.exec(message)) {
    const expr = byName.get(m[1]!);
    if (expr === undefined) {
      throw new Error(`i18n-chrome: no value supplied for ICU hole "${m[1]}" in "${message}"`);
    }
    pushText(message.slice(cursor, m.index));
    parts.push({ expr });
    cursor = m.index + m[0].length;
  }
  pushText(message.slice(cursor));
  return parts;
}

/** Re-assemble an ICU message around its holes for a MARKUP text position:
 *  literal pieces through `escapeText`, each hole through `hole`. */
function spliceIcuHoles(
  message: string,
  values: ReadonlyArray<{ name: string; expr: string }>,
  hole: (expr: string) => string,
  escapeText: (text: string) => string,
): string {
  return icuParts(message, values)
    .map((p) => ("expr" in p ? hole(p.expr) : escapeText(p.text)))
    .join("");
}

/** The raw translation-call EXPRESSION for a pack-chrome string, unwrapped — for
 *  a pack that splices it into its own expression language rather than into
 *  markup (Feliz's `prop.text (…)`, Flutter's `Text(…)`).  Returns the plain
 *  source-language literal, spelled by `renderStringLiteral`, when i18n is off.
 *
 *  Registers no import — see the section note above. */
export function localizedChromeValue(ctx: WalkContext, name: string): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) return translateExpr(ctx, chromeKey(name), english);
  return ctx.target.renderStringLiteral?.(english) ?? JSON.stringify(english);
}

/** A pack-chrome string in an ATTRIBUTE position (a grid's per-column
 *  `placeholder="Filter"`), for markup that may land in a hoisted child file.
 *
 *  Returns the COMPLETE attribute fragment with NO leading space — unlike
 *  `localizedChromeAria`, whose leading space replaces the one in the template.
 *  Here the pack template keeps the attribute on its own indented line, so the
 *  token stands exactly where the static attribute stood:
 *
 *      placeholder="Filter"     →     {{{filterPlaceholderAttr}}}
 *
 *  i18n off renders `placeholder="Filter"` verbatim (byte-identical); on, it is
 *  the target's bound form (` placeholder={t(…)}` React/Svelte, `:placeholder="…"`
 *  Vue, `[placeholder]="…"` Angular), trimmed of that leading space.
 *
 *  Registers no import — see the section note above. */
export function localizedChromeAttr(ctx: WalkContext, attrName: string, name: string): string {
  const english = chromeMessage(name);
  if (ctx.i18nPrefix) {
    return ctx.target
      .renderAttrBinding(attrName, translateExpr(ctx, chromeKey(name), english))
      .trimStart();
  }
  return `${attrName}="${escapeHtmlAttr(english)}"`;
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
