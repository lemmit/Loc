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
    ...(gridHasFilterableColumn(call) ? [entry("filter")] : []),
  ],
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
