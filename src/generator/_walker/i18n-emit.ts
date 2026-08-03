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

/** The accessible name of a NAMED user-visible slot as a TARGET-NATIVE
 *  EXPRESSION — the value-position twin of {@link localizedAriaLabelAttr}, and
 *  the seam for the two frontends whose markup is NOT HTML.
 *
 *  D-I18N-ATTR (M-T1.11): **the a11y helper emits an already-TRANSLATED value;
 *  a pack never resolves a key.**  One accessible name, two renderings, both
 *  derived here from the SAME `messageKey()` the extraction pass uses:
 *
 *   - the HTML-ish attribute FRAGMENT (`localizedAriaLabelAttr`) — spliced
 *     verbatim by the four JSX/markup frontends, whose packs are `.hbs`
 *     templates that can only interpolate text;
 *   - this VALUE (`localizedAriaLabelValue`) — an expression in the target's own
 *     language, for the procedural packs that build props rather than markup
 *     (Feliz `prop.ariaLabel <expr>`, Flutter `Semantics(label: <expr>)`).
 *
 *  The alternative — hand the pack the KEY and let it call the runtime — was
 *  rejected: it duplicates the "is this app i18n-enabled at all" decision into
 *  every pack, and a pack that forgets the check emits a `t()` call into an app
 *  with no runtime.  Deciding once here keeps the i18n-OFF path byte-identical
 *  by construction.
 *
 *  Returns `undefined` when the slot carries no name at all (no literal, no
 *  `defaultLabel`) — the caller omits the prop, matching the empty-string
 *  fragment `ariaLabelAttr` yields.  A DYNAMIC (non-literal) label is likewise
 *  `undefined`: it has no stable source string, exactly as in the attribute
 *  path. */
export function localizedAriaLabelValue(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  role: string,
  name = "label",
  defaultLabel?: string,
): string | undefined {
  const literal = literalString(namedArgValue(call, name));
  if (literal !== undefined && ctx.i18nPrefix) {
    return translateCall(ctx, messageKey(ctx.i18nPrefix, role, literal), literal);
  }
  const text = literal ?? defaultLabel;
  if (text === undefined || text === "") return undefined;
  return stringLiteral(ctx, text);
}

/** A plain string literal in the target's own expression language — the
 *  `renderStringLiteral` seam, JSON-quoted when a target leaves it unset. */
function stringLiteral(ctx: WalkContext, text: string): string {
  return ctx.target.renderStringLiteral?.(text) ?? JSON.stringify(text);
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
