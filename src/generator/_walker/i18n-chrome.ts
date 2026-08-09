// ---------------------------------------------------------------------------
// Pack-chrome message catalog (M-T1.11, i18n.md — "pack-chrome catalogs").
//
// The design packs bake their own user-visible strings into `.hbs` templates —
// a spinner's `aria-label="Loading"`, a grid pager's "Previous"/"Next", its
// per-column "Filter" placeholder, a form's "Remove" button.  These are NOT authored in the `.ddd` source, so the
// content-hash extraction pass (`i18n-extract.ts`, which keys `page.<P>.<role>.
// <hash>` off literals in the page body) never sees them and the per-app
// `t()` runtime can't translate them.
//
// This module is that missing catalog: a fixed set of STABLE `chrome.<name>`
// keys → their source-language (English) text.  Unlike page/component strings
// the keys are curated, not hashed — chrome is a shared, translator-facing
// vocabulary ("Loading" is ONE key across every pack and page, not a per-site
// hash).  A pack template emits `{{{loadingAria}}}` (a token the primitive's
// emitter builds via `localizedChromeAria` / the other `localizedChrome*`
// helpers in `i18n-emit.ts`), which under i18n becomes a `t("chrome.loading",
// "Loading")` binding keyed to this catalog, and stays byte-identical raw text
// when the app opted out.
//
// Chrome flows into the catalog USED-only, in lockstep with emission: the
// extraction pass (`i18n-extract.ts`) yields a primitive's chrome entries when
// it walks that primitive's call node (`CHROME_BY_PRIMITIVE`), so a page with a
// `Loader()` gets `chrome.loading` and a page without one does not — exactly
// mirroring where `localizedChromeAria` emits the `t()` binding.  Grows one
// entry per chrome string as the pack-chrome slices land.
// ---------------------------------------------------------------------------

import type { ExprIR } from "../../ir/types/loom-ir.js";
import type { MessageEntry } from "./i18n-extract.js";
import { gridHasFilterableColumn } from "./primitives/data-grid-shape.js";

/** Stable key for a pack-chrome string: `chrome.<name>`. */
export function chromeKey(name: string): string {
  return `chrome.${name}`;
}

/** The canonical `chrome.<name>` → English catalog.  One entry per pack-chrome
 *  string the emitters localize; the value is the source-language default that
 *  rides into `t(key, default)` and renders verbatim when no locale overrides. */
export const CHROME_MESSAGES: Record<string, string> = {
  [chromeKey("loading")]: "Loading",
  [chromeKey("previous")]: "Previous",
  [chromeKey("next")]: "Next",
  [chromeKey("filter")]: "Filter",
  // The pager's position counter.  An ICU message with two holes rather than
  // three concatenated fragments ("Page " + n + " of " + m), because a locale
  // must be free to RE-ORDER them — the count-first and count-last languages
  // both exist, and a concatenation can only ever be translated in English word
  // order.  Still a static catalog string: the holes are named, the emitter
  // supplies their values (`localizedChromeIcuText`), and the runtime's
  // `intl-messageformat` substitutes and locale-formats the numbers.
  [chromeKey("pageOf")]: "Page {page} of {pages}",
  // `Table`'s pager says "Prev" where `DataGrid`'s says "Previous".  Two keys,
  // not one: collapsing them onto a canonical English would re-word one of the
  // two controls and break the i18n-off byte-identical guarantee — the same
  // reason `openMenu` and `toggleNavigation` stayed apart.  "Next" IS shared,
  // because both spell it identically.
  [chromeKey("prev")]: "Prev",
  // The empty-state text of a `<select>` picker.  One key rather than one per
  // call site: it is the same sentence to a translator, and every pack that
  // spells it spells it identically (unlike the nav-toggle pair, which packs
  // genuinely word differently and therefore keeps two keys).
  [chromeKey("selectPlaceholder")]: "Select…",
  // Emitter-built chrome — user-visible English constructed in the WALKER (not
  // in a pack template), so neither the extraction pass nor the pack-chrome
  // `.hbs` slice ever saw it.  `{entity}` is the humanized aggregate name: a
  // DSL identifier, so it stays as authored while the sentence around it
  // translates (the alternative is leaving the whole sentence English).
  [chromeKey("deleteEntity")]: "Delete {entity}",
  [chromeKey("deleteConfirm")]: "Delete this {entity}?",
  [chromeKey("cancel")]: "Cancel",
};

/** The source-language text for a chrome key, for an emitter building the
 *  `t(key, default)` binding.  Throws on an unknown name rather than emitting a
 *  `t(key, undefined)` the runtime would render as the literal string
 *  "undefined" — the emitted default MUST equal the catalog entry, so the two
 *  read the same table instead of repeating the English by hand. */
export function chromeMessage(name: string): string {
  const message = CHROME_MESSAGES[chromeKey(name)];
  if (message === undefined) throw new Error(`i18n-chrome: unknown chrome string "${name}"`);
  return message;
}

/** One catalog entry for a chrome name. */
function entry(name: string): MessageEntry {
  return { key: chromeKey(name), message: chromeMessage(name) };
}

/** The chrome a primitive contributes: a fixed list, or — when it depends on
 *  HOW the primitive was called — a function of the call node.  A `DataGrid`
 *  renders its per-column "Filter" placeholder only when a column asked to be
 *  filtered, so its entries are computed rather than declared. */
export type ChromeContribution =
  | readonly MessageEntry[]
  | ((call: ExprIR & { kind: "call" }) => readonly MessageEntry[]);

/** Walker-primitive call name → the chrome catalog entries it renders.  The
 *  extraction pass consults this per call node so the catalog carries exactly
 *  the chrome a UI actually emits (used-only), and a chrome-only page still
 *  counts as translatable (turns the runtime on).  Keyed by the primitive's
 *  DSL call name (`Loader`, `DataGrid`, …), the same name `registry.ts`
 *  dispatches. */
export const CHROME_BY_PRIMITIVE: Record<string, ChromeContribution> = {
  Loader: [entry("loading")],
  // Every shipped pack's grid renders the pager unconditionally; the per-column
  // filter input rides `hasFilters`, so the placeholder is contributed only when
  // a column is actually filterable — the SAME predicate the emitter gates that
  // input on (`data-grid-shape.ts`), so key and binding cannot drift.
  DataGrid: (call) => [
    entry("previous"),
    entry("next"),
    entry("pageOf"),
    ...(gridHasFilterableColumn(call) ? [entry("filter")] : []),
  ],
  // A `SelectField` ALWAYS renders the picker, so this is exact — the primitive
  // is the only thing that renders `primitive-select-field`.
  //
  // The form-built pickers spell the SAME placeholder, but they are not here —
  // a form primitive must not FLIP i18n on (see `FORM_CHROME`).
  SelectField: [entry("selectPlaceholder")],
};

/** Resolve a primitive's chrome contribution against the call node that
 *  produced it.  Undefined for a primitive that bakes in no chrome. */
export function chromeEntriesFor(call: ExprIR & { kind: "call" }): readonly MessageEntry[] {
  const contribution = CHROME_BY_PRIMITIVE[call.name];
  if (contribution === undefined) return [];
  return typeof contribution === "function" ? contribution(call) : contribution;
}

/** App-shell chrome — strings the design packs bake into the application shell
 *  (`app-shell.hbs`: the 404 route text, the skip-to-content link).  Unlike
 *  primitive chrome the shell is ALWAYS rendered, so these are NOT driven by an
 *  authored call node: they translate only when the app is ALREADY i18n-enabled
 *  by its authored strings (never flip i18n on for a string-less app), and the
 *  catalog builders merge them under that same gate.  Shell emitters read
 *  `APP_SHELL_CHROME[chromeKey(name)]` for the source default so the emitted
 *  `t()` default lines up with the merged catalog entry. */
export const APP_SHELL_CHROME: Record<string, string> = {
  [chromeKey("notFound")]: "Not found",
  [chromeKey("skipToContent")]: "Skip to content",
  [chromeKey("primaryNav")]: "Primary navigation",
  [chromeKey("somethingWentWrong")]: "Something went wrong",
  // The ROOT error boundary (`src/ErrorBoundary.tsx`, mounted by every React
  // pack's `main.tsx` outside the provider chain) spells the same idea WITH a
  // full stop.  Its own key rather than a re-use, because the two raw strings
  // differ and re-wording either would break the i18n-off byte-identical
  // guarantee — and rather than hoisting the "." out of the message, because
  // sentence-final punctuation is not universal (CJK uses 。).
  [chromeKey("rootErrorTitle")]: "Something went wrong.",
  // The mobile nav toggle: two keys, not one, because the packs genuinely spell
  // it differently (chakra "Open menu" vs the shadcn/flowbite family "Toggle
  // navigation").  Collapsing them onto one canonical English would silently
  // re-word a pack and break the i18n-off byte-identical guarantee.
  [chromeKey("openMenu")]: "Open menu",
  [chromeKey("toggleNavigation")]: "Toggle navigation",
  // The error boundary's / 404's recovery link.  ONE key for both, even though
  // the 404 renders it as "← Back to home": the arrow is decoration the template
  // keeps OUTSIDE the token, so i18n-off still concatenates to the byte-identical
  // "← Back to home" while translators see one clean phrase.
  [chromeKey("backToHome")]: "Back to home",
};

/** Chrome a FORM renders — currently the id/enum picker's "Select…".
 *
 *  Not in `CHROME_BY_PRIMITIVE`, and the distinction is the whole design.  A
 *  contribution there FLIPS i18n ON for a UI that has nothing else to translate
 *  (that is the point for `Loader`, `DataGrid`, `SelectField` — each always
 *  renders its chrome, so it earns the runtime).  A form does NOT always render
 *  a picker: only an `X id` field whose target has a `derived display`, or an
 *  enum field, does.  Contributing from `CreateForm`/`OperationForm`/
 *  `WorkflowForm` was measured to ship `src/i18n.ts`, `locales/en.json` and the
 *  `intl-messageformat` dependency into a plain-string form app that needs none.
 *
 *  Merged instead under the ALREADY-ENABLED gate, exactly like the app-shell
 *  chrome below.  That makes key and binding agree precisely, because both sides
 *  now answer the same question: `localizedChromeAttr` emits the `t()` form iff
 *  `ctx.i18nPrefix` is set, and `ctx.i18nPrefix` is set iff the UI is
 *  i18n-enabled — the same condition this table is merged under.
 *
 *  The residue is one over-merged key: an i18n-enabled app whose forms happen to
 *  have no picker carries "Select…" unused.  That is the trade `APP_SHELL_CHROME`
 *  already makes (a pack renders `openMenu` OR `toggleNavigation`, never both),
 *  and it is the cheap side of the asymmetry — an unused key costs a translator
 *  one phrase, while a missing one is a binding no locale can ever reach. */
export const FORM_CHROME: Record<string, string> = {
  [chromeKey("selectPlaceholder")]: "Select…",
  // The destroy button's label, its `window.confirm` prompt, and the op
  // dialog's Cancel — all built in the EMITTER from model data, so neither the
  // content-hash extraction pass nor the pack-chrome `.hbs` slice ever saw
  // them.  They sit here rather than in `CHROME_BY_PRIMITIVE` for the same
  // reason `selectPlaceholder` does: `DestroyForm`/`Modal` are form primitives,
  // and a form must not FLIP i18n on for an app with no authored strings.
  [chromeKey("deleteEntity")]: "Delete {entity}",
  [chromeKey("deleteConfirm")]: "Delete this {entity}?",
  [chromeKey("cancel")]: "Cancel",
};

/** Chrome a paged `Table` renders — "Prev" / "Next" / the position counter.
 *
 *  Merged-when-already-enabled rather than contributed off the `Table` call
 *  node, for the same reason `FORM_CHROME` is: the pager is CONDITIONAL, and
 *  here the condition is not even readable off the call node.  A `Table` pages
 *  only when it carries a `page:` state ref AND its rows come from a read the
 *  walker classified as server-controlled — and that second half is a
 *  walk-context fact (`primitives/table.ts`'s `serverControls`), invisible to
 *  the target-agnostic extraction pass.  A contribution would therefore either
 *  over-claim (catalog keys no pager emits) or under-claim (a binding no locale
 *  can reach); the gate below sidesteps the question, because emitter and merge
 *  site then answer the identical one — is this UI i18n-enabled. */
export const TABLE_PAGER_CHROME: Record<string, string> = {
  [chromeKey("prev")]: "Prev",
  [chromeKey("next")]: "Next",
  [chromeKey("pageOf")]: "Page {page} of {pages}",
};

/** Every chrome table merged into a catalog ONLY when the UI is already
 *  i18n-enabled — never flipping the runtime on by itself.
 *
 *  One helper rather than a list at each merge site, so a future table joins by
 *  editing this function instead of by remembering both callers
 *  (`system/i18n-catalog.ts` for `.loom/messages.en.json`, and
 *  `_frontend/i18n-runtime.ts` for each app's `locales/en.json`). */
export function chromeMergedWhenEnabled(): Record<string, string> {
  return { ...APP_SHELL_CHROME, ...FORM_CHROME, ...TABLE_PAGER_CHROME };
}
