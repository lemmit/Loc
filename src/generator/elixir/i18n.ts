// ---------------------------------------------------------------------------
// The Phoenix HEEx translation runtime (M-T1.11) — the LAST frontend, and the
// one that diverges most.
//
// The other five reach a generated `t(key, default)` shim (TypeScript on the
// four JS frontends, an `I18n` F# module on Feliz, `lib/i18n.dart` on Flutter).
// Elixir has a STANDARD answer — `gettext` — and a generated Phoenix app that
// ignored it in favour of a bespoke shim would be the wrong kind of different:
// every Phoenix tool (`mix gettext.extract`, `mix gettext.merge`, every
// translation-service `.po` importer) speaks gettext.
//
// The awkward part is that gettext keys by the SOURCE STRING (`msgid`) while
// Loom keys by a content hash (D-I18N-KEY, `page.<P>.<role>.<hash>`) shared with
// `.loom/messages.en.json` and the `ddd i18n sync` CLI.  `pgettext/2` resolves
// it exactly: the Loom key becomes the gettext CONTEXT (`msgctxt`) and the
// English becomes the `msgid`, so
//
//     pgettext("page.Home.heading.gwr3o9", "Storefront")
//
// carries BOTH — key parity with the other five frontends, and gettext's own
// "a missing translation returns the msgid" fallback, which is the same
// `messages[key] ?? default` semantics the JS shim has.
//
// Emitted only when the ui has extractable user-visible strings; a string-less
// app is byte-identical to pre-i18n (no backend module, no `.po`, no dep).
//
// SCOPE — plain literals only.  An INTERPOLATED slot (a lowered backtick
// template, `` `Order {id}` ``) keeps the pre-i18n raw path: gettext
// interpolates `%{name}`, not ICU `{name}`, and has no `plural`/`select`
// arg-type at all (only `ngettext`'s count form), so lining the two message
// grammars up is its own slice.  Recorded in `docs/new-plan/T1-ui-frontend.md`.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { buildUiCatalog } from "../_frontend/i18n-runtime.js";
import { APP_SHELL_CHROME, chromeKey } from "../_walker/i18n-chrome.js";

/** The gettext domain every generated message lands in — the Phoenix default,
 *  so `mix gettext.extract` and every `.po` tool need no configuration. */
export const GETTEXT_DOMAIN = "default";

/** The hex dependency line for the generated `mix.exs` `deps do` list. */
export const GETTEXT_DEP = `{:gettext, "~> 0.26"}`;

/** True when this ui has any extractable user-visible string — the single gate
 *  for the whole runtime (backend module + `.po`/`.pot` + the `mix.exs` dep +
 *  the walk prefix).  Empty catalog → no i18n anywhere, byte-identical. */
export function heexI18nEnabled(ui: UiIR): boolean {
  return Object.keys(buildUiCatalog(ui)).length > 0;
}

/** Escape a string for a `.po` quoted field (RFC-ish: backslash, quote, and
 *  the newline that would otherwise terminate the line). */
function poString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** An Elixir double-quoted string literal, for the emitted `pgettext` args. */
export function elixirI18nString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/#/g, "\\#").replace(/\n/g, "\\n")}"`;
}

/** `lib/<app>_web/gettext.ex` — the Gettext backend every `~H` template calls
 *  into.  A plain `use Gettext.Backend`, imported into `html_helpers` so
 *  `pgettext/2` resolves inside a template without qualification. */
export function renderGettextBackend(appName: string, appModule: string): string {
  return lines(
    `defmodule ${appModule}Web.Gettext do`,
    '  @moduledoc """',
    "  Translation runtime (Loom i18n, M-T1.11).",
    "",
    "  A page's user-visible text is emitted as",
    "",
    '      pgettext("page.<Page>.<role>.<hash>", "<English>")',
    "",
    "  — the CONTEXT is Loom's content-hashed catalog key (identical to the one",
    "  in `.loom/messages.en.json` and on every other frontend), and the msgid is",
    "  the source-language default, so an untranslated message renders the",
    "  English rather than the key.",
    "",
    "  Translators work in `priv/gettext/<locale>/LC_MESSAGES/default.po`; add a",
    "  locale by copying the `en` tree.  `mix gettext.extract` / `gettext.merge`",
    "  work normally — the emitted `.pot` is a regeneratable convenience, not a",
    "  hand-maintained file.",
    '  """',
    `  use Gettext.Backend, otp_app: :${appName}`,
    "end",
  );
}

/** The `.pot` template + the source-language `.po`, both derived from the SAME
 *  `buildUiCatalog` the other five frontends' catalogs come from.
 *
 *  The `en` catalog's `msgstr` is deliberately EMPTY, not a copy of the msgid:
 *  gettext falls back to the msgid when a translation is empty, so an empty
 *  `msgstr` renders the English AND leaves `mix gettext.merge` free to treat
 *  the entry as untranslated in a real translation workflow. */
export function renderGettextCatalog(ui: UiIR, kind: "pot" | "po"): string {
  const catalog = buildUiCatalog(ui);
  const header =
    kind === "pot"
      ? [
          "## Generated by Loom (M-T1.11) — the source-language template.",
          "## `msgctxt` is Loom's content-hashed catalog key (D-I18N-KEY); `msgid` is",
          "## the English default.  Regenerated on every `ddd generate system`.",
          'msgid ""',
          'msgstr ""',
          '"Content-Type: text/plain; charset=UTF-8\\n"',
        ]
      : [
          "## Generated by Loom (M-T1.11) — the source-language catalog.",
          "## An EMPTY msgstr means gettext renders the msgid (the English), which is",
          "## exactly the source-language behaviour.  Copy this tree to add a locale.",
          'msgid ""',
          'msgstr ""',
          '"Language: en\\n"',
          '"Content-Type: text/plain; charset=UTF-8\\n"',
        ];
  const entries = Object.entries(catalog).flatMap(([key, message]) => [
    "",
    `msgctxt ${poString(key)}`,
    `msgid ${poString(message)}`,
    'msgstr ""',
  ]);
  return lines(...header, ...entries);
}

/** The ui a deployable mounts, but ONLY when it has extractable user-visible
 *  strings — the single i18n gate the Phoenix shell emitter takes.  Undefined
 *  for a JSON-API-only deployable, an unresolvable `ui:`, or a string-less ui,
 *  all of which keep the generated project byte-identical to pre-i18n. */
export function heexI18nUi(
  sys: { uis: readonly UiIR[] },
  deployable: { uiName?: string },
): UiIR | undefined {
  if (!deployable.uiName) return undefined;
  const ui = sys.uis.find((u) => u.name === deployable.uiName);
  return ui && heexI18nEnabled(ui) ? ui : undefined;
}

/** A baked-in app-shell chrome string in HEEx TEXT position — a
 *  `<%= pgettext(…) %>` call under i18n (M-T1.11), else the raw English, which
 *  is byte-identical to the pre-i18n shell.  The English comes from the shared
 *  `APP_SHELL_CHROME` table so the emitted msgid equals the catalog entry. */
export function shellChromeText(name: string, i18nEnabled: boolean): string {
  const key = chromeKey(name);
  const english = APP_SHELL_CHROME[key]!;
  return i18nEnabled
    ? `<%= pgettext(${elixirI18nString(key)}, ${elixirI18nString(english)}) %>`
    : english;
}

/** The same chrome string in ATTRIBUTE position — a HEEx `{…}` expression
 *  attribute under i18n, else the quoted English literal (byte-identical). */
export function shellChromeAria(name: string, i18nEnabled: boolean): string {
  const key = chromeKey(name);
  const english = APP_SHELL_CHROME[key]!;
  return i18nEnabled
    ? `{pgettext(${elixirI18nString(key)}, ${elixirI18nString(english)})}`
    : `"${english}"`;
}
