// ---------------------------------------------------------------------------
// Pack-chrome message catalog (M-T1.11, i18n.md — "pack-chrome catalogs").
//
// The design packs bake their own user-visible strings into `.hbs` templates —
// a spinner's `aria-label="Loading"`, a grid pager's "Previous"/"Next", a
// form's "Remove" button.  These are NOT authored in the `.ddd` source, so the
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

import type { MessageEntry } from "./i18n-extract.js";

/** Stable key for a pack-chrome string: `chrome.<name>`. */
export function chromeKey(name: string): string {
  return `chrome.${name}`;
}

/** The canonical `chrome.<name>` → English catalog.  One entry per pack-chrome
 *  string the emitters localize; the value is the source-language default that
 *  rides into `t(key, default)` and renders verbatim when no locale overrides. */
export const CHROME_MESSAGES: Record<string, string> = {
  [chromeKey("loading")]: "Loading",
};

/** Walker-primitive call name → the chrome catalog entries it renders.  The
 *  extraction pass consults this per call node so the catalog carries exactly
 *  the chrome a UI actually emits (used-only), and a chrome-only page still
 *  counts as translatable (turns the runtime on).  Keyed by the primitive's
 *  DSL call name (`Loader`, …), the same name `registry.ts` dispatches. */
export const CHROME_BY_PRIMITIVE: Record<string, readonly MessageEntry[]> = {
  Loader: [{ key: chromeKey("loading"), message: CHROME_MESSAGES[chromeKey("loading")]! }],
};

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
};
