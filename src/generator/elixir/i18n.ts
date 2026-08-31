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
// INTERPOLATION (D-I18N-HEEX-ICU) — gettext interpolates `%{name}`, not ICU
// `{name}`, and has no `plural`/`select` arg-type at all (only `ngettext`'s
// count form).  Rewriting the message to gettext's grammar at emit time was
// rejected: the Phoenix catalog would stop carrying the same msgid as the other
// five, which is the one invariant the whole design rests on.  So the message
// stays ICU VERBATIM and the two jobs split along their natural seam —
//
//     gettext resolves the message  →  an ICU engine formats the result
//
// which is exactly the two steps the JS shim already is (`messages[key] ??
// default`, then `intl-messageformat`).  The engine is `ex_cldr_messages`; the
// generated `<App>Web.I18n.loom_icu/2` wraps it with the raw-substitution
// fallback described there.
//
// SECOND-TIER GATE.  The CLDR backend costs real compile time, so it ships only
// when the ui has an INTERPOLATED message — one tier below the existing "has
// any string at all" gate, so a plain-literal Phoenix app pays for none of
// it.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { buildUiCatalog } from "../_frontend/i18n-runtime.js";
import { APP_SHELL_CHROME, chromeKey } from "../_walker/i18n-chrome.js";
import { collectUiMessages } from "../_walker/i18n-extract.js";

/** The gettext domain every generated message lands in — the Phoenix default,
 *  so `mix gettext.extract` and every `.po` tool need no configuration. */
export const GETTEXT_DOMAIN = "default";

/** The hex dependency line for the generated `mix.exs` `deps do` list. */
export const GETTEXT_DEP = `{:gettext, "~> 0.26"}`;

/** The ICU formatter dependency, added only for a ui with an INTERPOLATED
 *  message (D-I18N-HEEX-ICU).  `ex_cldr_messages` is the Elixir ICU
 *  MessageFormat implementation — the counterpart of `intl-messageformat` on
 *  the four JS frontends and Feliz, and of `package:intl`'s `MessageFormat` on
 *  Flutter.  It pulls `ex_cldr` + `ex_cldr_numbers` transitively; `ex_cldr` is
 *  named explicitly because the generated backend module `use`s it. */
export const ICU_DEPS = [`{:ex_cldr, "~> 2.47"}`, `{:ex_cldr_messages, "~> 1.0"}`];

/** True when this ui has any extractable user-visible string — the single gate
 *  for the whole runtime (backend module + `.po`/`.pot` + the `mix.exs` dep +
 *  the walk prefix).  Empty catalog → no i18n anywhere, byte-identical. */
export function heexI18nEnabled(ui: UiIR): boolean {
  return Object.keys(buildUiCatalog(ui)).length > 0;
}

/** True when this ui has an INTERPOLATED user-visible message and therefore
 *  needs an ICU engine (D-I18N-HEEX-ICU) — the SECOND-tier gate, strictly
 *  narrower than {@link heexI18nEnabled}.
 *
 *  Read off the extraction pass's own `icu` marker rather than by sniffing the
 *  catalog for a `{`: the merged pack-chrome messages carry holes too
 *  (`chrome.pageOf` is "Page {page} of {pages}"), and HEEx renders none of
 *  them through this path, so a `{`-sniff would put the CLDR compile into every
 *  translatable app instead of the ones that use interpolation. */
export function heexIcuEnabled(ui: UiIR): boolean {
  return collectUiMessages(ui).some((m) => m.icu);
}

/** `lib/<app>/cldr.ex` — the CLDR backend `ex_cldr_messages` formats against.
 *
 *  `locales:` carries the SOURCE language only.  A generated app ships one
 *  `.po` tree (`en`); a translator adding `fr` copies that tree AND adds the
 *  locale here, because CLDR's plural rules are per-locale data that has to be
 *  compiled in.  Both halves of that are stated in the moduledoc — a `.po` file
 *  whose plural forms no backend can evaluate is the failure mode this note
 *  exists to prevent. */
export function renderCldrBackend(appModule: string): string {
  return lines(
    `defmodule ${appModule}.Cldr do`,
    '  @moduledoc """',
    "  CLDR backend for the ICU message formatter (Loom i18n, M-T1.11).",
    "",
    "  `Cldr.Message` formats the ICU message gettext resolved — the holes,",
    "  `{n, plural, …}` categories and `{x, select, …}` cases in",
    "  `priv/gettext/**/*.po`.",
    "",
    "  ADDING A LOCALE takes two steps, not one:",
    "",
    "    1. copy `priv/gettext/en` to `priv/gettext/<locale>` and translate it;",
    "    2. add `<locale>` to `locales:` below.",
    "",
    "  Step 2 is what compiles that locale's CLDR plural rules in.  Without it a",
    "  translated `{n, plural, few {…} many {…}}` has no rules to select by.",
    '  """',
    "  use Cldr,",
    '    locales: ["en"],',
    '    default_locale: "en",',
    "    providers: [Cldr.Number, Cldr.Message]",
    "end",
  );
}

/** `lib/<app>_web/i18n.ex` — the ICU formatting step that runs over gettext's
 *  result (D-I18N-HEEX-ICU).
 *
 *  `loom_icu/2` rather than a bare `format/2`: it is `import`ed into every
 *  template through `html_helpers`, where a generic name would collide with
 *  Phoenix's own helpers or the page's.
 *
 *  The FALLBACK is the interesting half.  `ex_cldr_messages` implements ICU
 *  MessageFormat but not ICU number SKELETONS — `{total, number,
 *  ::currency/USD}`, which is the canonical currency spelling Loom's own
 *  grammar documents — and raises outright on a `date`/`time` style unless
 *  `ex_cldr_dates_times` is also configured.  Rather than crash a page render
 *  on a message shape the DSL admits, an unformattable message degrades to raw
 *  hole substitution: the value is interpolated unformatted, which is EXACTLY
 *  what pre-i18n Phoenix rendered for that hole.  Same trade, and same reason,
 *  as the Flutter runtime's documented `_substitute` fallback.
 *
 *  Both the `{:error, _}` tuple and a raise are caught: the library reports a
 *  parse/bind failure as a tuple but a missing date provider as a
 *  `FunctionClauseError`, and a page render must survive either. */
export function renderIcuRuntime(appModule: string): string {
  return lines(
    `defmodule ${appModule}Web.I18n do`,
    '  @moduledoc """',
    "  ICU message formatting (Loom i18n, M-T1.11).",
    "",
    "  Loom keeps ONE message per catalog key across all six frontends, in ICU",
    "  form.  gettext resolves it (`pgettext/2` — Loom's key is the msgctxt);",
    "  this module formats the result:",
    "",
    '      loom_icu(pgettext("page.Home.text.k2f", "Status: {code}"), code: @code)',
    "",
    "  An unformattable message (an ICU number SKELETON such as",
    "  `::currency/USD`, or a date style with no `ex_cldr_dates_times`) falls",
    "  back to raw hole substitution rather than raising — the value renders",
    "  unformatted, which is what this app rendered before it was translatable.",
    '  """',
    "",
    '  @doc "Format an ICU message against its bindings; never raises."',
    "  def loom_icu(message, bindings) when is_binary(message) do",
    "    case safe_format(message, bindings) do",
    "      {:ok, formatted} -> formatted",
    "      :error -> substitute(message, bindings)",
    "    end",
    "  end",
    "",
    "  defp safe_format(message, bindings) do",
    `    case Cldr.Message.format(message, bindings, backend: ${appModule}.Cldr) do`,
    "      {:ok, formatted} -> {:ok, formatted}",
    "      _ -> :error",
    "    end",
    "  rescue",
    "    _ -> :error",
    "  end",
    "",
    "  # Replace each `{name…}` with its binding, formatting nothing.  The regex",
    "  # takes the NAME up to the first `,` or `}` so a formatted hole",
    "  # (`{total, number, ::currency/USD}`) resolves by name too.  An unbound",
    "  # hole is left verbatim — visible, rather than silently blank.",
    "  #",
    "  # The lookup compares the binding keys AS STRINGS rather than interning",
    "  # the hole name: message text comes from a `.po` file a translator edits,",
    "  # and `String.to_atom/1` over it would let an added hole grow the atom",
    "  # table without bound.",
    "  defp substitute(message, bindings) do",
    "    Regex.replace(~r/\\{\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*(?:,[^{}]*)?\\}/, message, fn whole, name ->",
    "      case Enum.find(bindings, fn {key, _} -> Atom.to_string(key) == name end) do",
    "        {_, value} -> to_string(value)",
    "        nil -> whole",
    "      end",
    "    end)",
    "  end",
    "end",
  );
}

/** Escape a string for a `.po` quoted field (RFC-ish: backslash, quote, and
 *  the newline that would otherwise terminate the line). */
function poString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** An Elixir double-quoted string literal for the emitted `pgettext` args.
 *
 *  Beyond the obvious `\\` / `"` / `#{` / newline, this `\\x`-escapes the four
 *  characters that are SIGNIFICANT TO THE TEMPLATE GRAMMAR AROUND THE CALL, not
 *  to Elixir:
 *
 *    - `>` and `<` — the call sits inside an EEx tag (`<%= pgettext(…) %>`), so
 *      a `%>` anywhere in the message would TERMINATE that tag early and the
 *      rest of the message would spill into markup.  A `.ddd` heading of
 *      `"a <%= x %> b"` is enough to break the template.
 *    - `{` and `}` — the attribute form (`aria-label={pgettext(…)}`) is a HEEx
 *      `{…}` expression, which a `}` in the message would close early.
 *
 *  `\\xHH` produces the IDENTICAL runtime string, so the emitted msgid still
 *  matches the `.po` entry byte-for-byte — this is purely about the bytes in the
 *  generated source.  (Caught by `text-escaping-cross-target.test.ts`, which
 *  drives a payload hostile in every text grammar through all six frontends.) */
export function elixirI18nString(value: string): string {
  const body = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/#/g, "\\#")
    .replace(/\n/g, "\\n")
    .replace(/</g, "\\x3C")
    .replace(/>/g, "\\x3E")
    .replace(/\{/g, "\\x7B")
    .replace(/\}/g, "\\x7D");
  return `"${body}"`;
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
export function renderGettextCatalog(
  ui: UiIR | undefined,
  kind: "pot" | "po",
  /** Backend validation messages (M-T1.11) — `msg.<hash>` → authored English,
   *  from `collectWireValidationMessages`. Merged into the SAME `.po` tree as the
   *  ui strings: a Loom key is globally unique and always the `msgctxt`, so one
   *  domain carries both halves and `mix gettext.merge` sees one catalog. An
   *  API-only deployable (no ui) therefore still gets a real gettext tree. */
  validationMessages: readonly { code: string; text: string }[] = [],
  /** The active HEEx pack's DECLARED chrome (`pack.<family>.<role>.<hash>` →
   *  English).  A `.hbs` pack bakes its own user-visible English ("No items.",
   *  a pager landmark), which no IR walk sees — so the `.po` a translator opens
   *  has to carry it alongside the authored strings, keyed identically to
   *  `.loom/messages.en.json`. */
  packChrome: Record<string, string> = {},
): string {
  const catalog: Record<string, string> = ui ? { ...buildUiCatalog(ui, packChrome) } : {};
  for (const m of validationMessages) catalog[m.code] = m.text;
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
  // Key-sorted: `buildUiCatalog` already sorts its own keys, but merging the
  // `msg.*` half in would otherwise append them after the `page.*` ones, making
  // the file's order depend on which half contributed a key.
  const entries = Object.keys(catalog)
    .sort()
    .flatMap((key) => [
      "",
      `msgctxt ${poString(key)}`,
      `msgid ${poString(catalog[key]!)}`,
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
