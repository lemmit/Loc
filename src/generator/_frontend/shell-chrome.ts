// ---------------------------------------------------------------------------
// App-shell chrome binding forms (M-T1.11, pack-chrome).
//
// The shell templates carry baked-in user-visible strings (the 404 heading, the
// skip link, the nav landmark's aria, the error boundary, "Back to home").  Each
// frontend's generator turns one of these into a TOKEN it hands the `.hbs`
// shell: under i18n a `t("chrome.<name>", "<English>")` binding in that
// framework's syntax, and otherwise the raw source string — byte-identical to
// the pre-i18n shell, which is the invariant every one of these helpers exists
// to preserve.
//
// Four generators used to carry their own copy of this pair.  React's and
// Svelte's were character-for-character identical (both bind JSX-shaped
// `{t(…)}`); Vue's and Angular's differ only in the wrapper syntax.  Keeping
// four copies meant a fifth chrome string had to be added in four places and the
// byte-identical `else` branch re-derived each time — so they live here, one
// per framework, named by the syntax they emit.
//
// The English default always comes from the shared `APP_SHELL_CHROME` table so
// the emitted `t()` default equals the merged catalog entry (a mismatch would
// ship a translation key whose fallback text differs from the catalog's).
//
// Phoenix/HEEx deliberately keeps its own pair in `elixir/i18n.ts`: it binds
// `pgettext(...)` (gettext, not the JS `t()` runtime) and is a single copy, so
// there is nothing to share.
// ---------------------------------------------------------------------------

import { APP_SHELL_CHROME, chromeKey } from "../_walker/i18n-chrome.js";

/** The `chrome.<name>` key + its source-language English, resolved once.
 *  Throws on an unknown name — a typo'd chrome key would otherwise emit
 *  `undefined` into a generated shell. */
function entry(name: string): { key: string; english: string } {
  const key = chromeKey(name);
  const english = APP_SHELL_CHROME[key];
  if (english === undefined) {
    throw new Error(
      `unknown app-shell chrome '${name}' — add it to APP_SHELL_CHROME in _walker/i18n-chrome.ts`,
    );
  }
  return { key, english };
}

/** The `t(key, default)` call itself, no framework wrapper. */
function call(name: string): string {
  const { key, english } = entry(name);
  return `t(${JSON.stringify(key)}, ${JSON.stringify(english)})`;
}

// --- React / Svelte (JSX-shaped) -------------------------------------------

/** TEXT position, JSX form: `{t(…)}` under i18n, else the raw English.
 *  Shared by React and Svelte — both interpolate with single braces. */
export function jsxChromeText(name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `{${call(name)}}` : entry(name).english;
}

/** ATTRIBUTE position, JSX form — a whole `<attr>=…` fragment with NO leading
 *  space (the template keeps the surrounding whitespace): `<attr>={t(…)}` under
 *  i18n, else the static `<attr>="<English>"`.  `attr` varies by pack —
 *  `aria-label` on a nav landmark or toggle, `title` on Mantine's `<Alert>`. */
export function jsxChromeAttr(attr: string, name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `${attr}={${call(name)}}` : `${attr}="${entry(name).english}"`;
}

// --- Vue --------------------------------------------------------------------

/** TEXT position, Vue form: a `{{ t(…) }}` mustache under i18n, else the raw
 *  English.  The braces are DATA, not Handlebars — the shell renders this token
 *  through a triple-stache so it reaches the `.vue` file verbatim. */
export function vueChromeText(name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `{{ ${call(name)} }}` : entry(name).english;
}

/** ATTRIBUTE position, Vue form (no leading space): the bound `:<attr>='t(…)'`
 *  under i18n — single-quoted, since the `t()` call holds double quotes — else
 *  the static `<attr>="<English>"`. */
export function vueChromeAttr(attr: string, name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `:${attr}='${call(name)}'` : `${attr}="${entry(name).english}"`;
}

// --- Angular ----------------------------------------------------------------

/** TEXT position, Angular form: `{{ t(…) }}` — same mustache as Vue, but
 *  resolved against the COMPONENT INSTANCE, so the caller must also emit the
 *  `protected readonly t = t;` member (see `angular/index.ts`). */
export function angularChromeText(name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `{{ ${call(name)} }}` : entry(name).english;
}

/** ATTRIBUTE position, Angular form (no leading space): the bound
 *  `[attr.<attr>]='t(…)'` under i18n, else the static `<attr>="<English>"`. */
export function angularChromeAttr(attr: string, name: string, i18nEnabled: boolean): string {
  return i18nEnabled ? `[attr.${attr}]='${call(name)}'` : `${attr}="${entry(name).english}"`;
}
