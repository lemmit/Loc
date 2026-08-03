// ---------------------------------------------------------------------------
// The Feliz (F#/Fable) translation runtime (M-T1.11) — the FIFTH frontend to
// translate, and the first whose runtime is a different LANGUAGE.
//
// React / Vue / Svelte / Angular all ship the one generated TypeScript shim
// (`_frontend/i18n-runtime.ts`): a `messages[key] ?? default` lookup plus
// `intl-messageformat` for the ICU holes.  Feliz cannot import that shim — its
// whole app is a single `src/App.fs` compiled by `dotnet fable`, and a relative
// JS import would have to be written against the FABLE OUTPUT directory rather
// than the F# source.  So the runtime is re-expressed in F#:
//
//   * the CATALOG is a generated `Map<string, string>` compiled into `App.fs`
//     (the "generated resource map"), built from the SAME `buildUiCatalog` the
//     JS frontends' `locales/en.json` comes from — so every key/message is
//     byte-identical to the `.loom/messages.en.json` entry;
//   * the ICU FORMATTER is the SAME `intl-messageformat` engine, reached through
//     ordinary Fable interop (Fable compiles F# to JavaScript — the escape hatch
//     the `@tanstack/table-core` DataGrid bindings already use).  A
//     `{n, plural, …}` / `{total, number, ::currency/USD}` message therefore
//     renders IDENTICALLY on Feliz and on the four JS frontends, rather than
//     Feliz getting a hand-rolled `{name}` substituter that would drift.
//
// Emitted only when the ui has extractable user-visible strings; a string-less
// app is byte-identical to pre-i18n (no module, no npm dependency).
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { buildUiCatalog } from "../_frontend/i18n-runtime.js";
import { fsString } from "./fs-expr.js";

/** The npm dependency the ICU half needs — the same engine, at the same pin,
 *  the four JS frontends' stack dependency blocks carry. */
export const FELIZ_INTL_MESSAGEFORMAT = "^10.7.0";

/** True when this ui has any extractable user-visible string — the single gate
 *  for the whole runtime (module + npm dependency + `ctx.i18nPrefix`).  Empty
 *  catalog → no i18n anywhere and byte-identical output. */
export function felizI18nEnabled(ui: UiIR): boolean {
  return Object.keys(buildUiCatalog(ui)).length > 0;
}

/** The `I18n` F# module spliced into `App.fs` — catalog + lookup + ICU format.
 *  Placed near the top of the file (it references nothing else, and F# is
 *  order-sensitive: every page view below calls into it). */
export function renderFelizI18nModule(ui: UiIR): string {
  const catalog = buildUiCatalog(ui);
  // `buildUiCatalog` already returns key-sorted entries, so the emitted map is
  // stable across runs (a reordered page must not churn App.fs).
  // F# is offside-sensitive: the list literal must be indented PAST its
  // `Map.ofList` receiver or it reads as a separate expression rather than the
  // argument, and every element must start at the SAME column as the first (the
  // one that follows the opening bracket).
  const catalogEntries = Object.entries(catalog);
  const entries = catalogEntries.map(
    ([key, message], i) =>
      `${i === 0 ? "            [ " : "              "}${fsString(key)}, ${fsString(message)}` +
      (i === catalogEntries.length - 1 ? " ]" : ""),
  );
  return lines(
    "/// Translation runtime (Loom i18n, M-T1.11).",
    "///",
    "/// `I18n.t key default` looks the message key up in the active locale's",
    "/// catalog, falling back to the source-language default the call site",
    "/// carries.  `I18n.tf` additionally ICU-formats the message from its hole",
    "/// values through `intl-messageformat` — the SAME engine the React / Vue /",
    "/// Svelte / Angular runtimes use, so a `{n, plural, …}` or",
    "/// `{total, number, ::currency/USD}` message renders identically here.",
    "///",
    "/// To add a locale: add its `Map` below and register it in `catalogs`.",
    "module I18n =",
    '    let private intlMessageFormat: obj = import "IntlMessageFormat" "intl-messageformat"',
    "",
    '    [<Fable.Core.Emit("new $0($1, $2).format($3)")>]',
    "    let private icuFormat (ctor: obj) (message: string) (locale: string) (values: obj) : string = jsNative",
    "",
    // `globalThis.navigator` rather than the shim's `typeof navigator !==
    // \"undefined\"`: the emitted F# is checked by `no-js-isms.test.ts`, which
    // (rightly) treats a bare `undefined` anywhere in App.fs as a walker leak.
    "    [<Fable.Core.Emit(\"(globalThis.navigator ? globalThis.navigator.language : 'en').split('-')[0]\")>]",
    "    let private browserLanguage () : string = jsNative",
    "",
    "    /// Source-language catalog for this ui — the same keys and messages",
    "    /// `.loom/messages.en.json` carries (D-I18N-KEY content hashes).",
    "    let private en: Map<string, string> =",
    "        Map.ofList",
    ...entries,
    "",
    '    let private catalogs: Map<string, Map<string, string>> = Map.ofList [ "en", en ]',
    "",
    "    let private activeLocale: string =",
    "        let lang = browserLanguage ()",
    '        if catalogs.ContainsKey lang then lang else "en"',
    "",
    "    let private messages: Map<string, string> =",
    "        match catalogs.TryFind activeLocale with",
    "        | Some m -> m",
    "        | None -> en",
    "",
    "    /// Translate a key, falling back to the source-language default.",
    "    let t (key: string) (defaultMessage: string) : string =",
    "        match messages.TryFind key with",
    "        | Some m -> m",
    "        | None -> defaultMessage",
    "",
    "    /// Translate, then ICU-format the message's holes in the active locale.",
    "    let tf (key: string) (defaultMessage: string) (values: (string * obj) list) : string =",
    "        icuFormat intlMessageFormat (t key defaultMessage) activeLocale (createObj values)",
  );
}
