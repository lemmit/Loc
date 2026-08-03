// ---------------------------------------------------------------------------
// The Flutter (Dart) translation runtime (M-T1.11) — the SIXTH frontend to
// translate, and the second whose runtime is a different LANGUAGE.
//
// React / Vue / Svelte / Angular all ship the one generated TypeScript shim
// (`_frontend/i18n-runtime.ts`); Feliz re-expresses it in F#.  Flutter's app is
// Dart compiled by the Flutter SDK — no JS runtime on the shipping (native)
// target at all — so the runtime is re-expressed a third time:
//
//   * the CATALOG is a generated `const Map<String, String>` in `lib/i18n.dart`,
//     built from the SAME `buildUiCatalog` the JS frontends' `locales/en.json`
//     comes from, so every key/message equals the `.loom/messages.en.json`
//     entry.  A `const` map rather than a JSON asset: an asset needs a pubspec
//     declaration AND an async `rootBundle.loadString`, which would make every
//     text slot in every widget `build` await something;
//   * the ICU FORMATTER is `MessageFormat` from `package:intl` — already an
//     unconditional dependency of every generated Flutter app (it formats
//     money/dates).  It covers `{name}` and the brace-bodied `plural` / `select`
//     / `gender` forms, i.e. everything the JS `intl-messageformat` covers
//     EXCEPT the `, number` / `, date` skeleton arg-types.  Those degrade to the
//     raw value — which is exactly what pre-i18n Flutter already rendered (the
//     `i18nFormat` IR node renders `inner`, format inert), so the fallback is a
//     no-change, not a regression.  Locale-formatted skeletons on Flutter are a
//     recorded follow-up.
//
// Emitted only when the ui has extractable user-visible strings; a string-less
// app is byte-identical to pre-i18n.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { buildUiCatalog } from "../_frontend/i18n-runtime.js";

/** A Dart single-quoted string literal.  Escapes the backslash, the quote and
 *  `$` (Dart interpolates `$name` / `${…}` inside a plain string), plus real
 *  newlines.  Catalog messages routinely carry `{name}` holes, which are inert
 *  in Dart, and `$`-bearing text would otherwise be a compile error. */
export function dartStringLit(value: string): string {
  const body = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n");
  return `'${body}'`;
}

/** True when this ui has any extractable user-visible string — the single gate
 *  for the whole runtime (the `lib/i18n.dart` file, the per-page import, and
 *  `ctx.i18nPrefix`).  Empty catalog → no i18n anywhere, byte-identical output. */
export function flutterI18nEnabled(ui: UiIR): boolean {
  return Object.keys(buildUiCatalog(ui)).length > 0;
}

/** `lib/i18n.dart` — the catalog + `t(key, default, [values])` lookup/format. */
export function renderFlutterI18nModule(ui: UiIR): string {
  const catalog = buildUiCatalog(ui);
  // `buildUiCatalog` returns key-sorted entries, so the emitted map is stable
  // across runs (a reordered page must not churn the file).
  const entries = Object.entries(catalog).map(
    ([key, message]) => `  ${dartStringLit(key)}: ${dartStringLit(message)},`,
  );
  return lines(
    "// Generated translation runtime (Loom i18n, M-T1.11).",
    "//",
    "// Source-language lookup with a per-key fallback, plus ICU message",
    "// formatting via `package:intl`'s `MessageFormat`.  The `t(key, default,",
    "// values)` call sites the walker emits are stable across every frontend —",
    "// only the spelling differs.",
    "//",
    "// To add a locale: add its map below and register it in `_catalogs`.",
    "import 'dart:ui' as ui;",
    "",
    "import 'package:intl/message_format.dart';",
    "",
    "/// Source-language catalog for this ui — the same keys and messages",
    "/// `.loom/messages.en.json` carries (D-I18N-KEY content hashes).",
    "const Map<String, String> _en = <String, String>{",
    ...entries,
    "};",
    "",
    "const Map<String, Map<String, String>> _catalogs = <String, Map<String, String>>{",
    "  'en': _en,",
    "};",
    "",
    "String _activeLocale() {",
    "  final String code = ui.PlatformDispatcher.instance.locale.languageCode;",
    "  return _catalogs.containsKey(code) ? code : 'en';",
    "}",
    "",
    "final String locale = _activeLocale();",
    "final Map<String, String> _messages = _catalogs[locale] ?? _en;",
    "",
    "/// Translate a message key, falling back to the source-language default,",
    "/// then ICU-format its placeholders from [values] in the active locale.",
    "String t(String key, String defaultMessage, [Map<String, Object>? values]) {",
    "  final String message = _messages[key] ?? defaultMessage;",
    "  if (values == null || values.isEmpty) return message;",
    "  try {",
    "    return MessageFormat(message, locale: locale).format(values);",
    "  } catch (_) {",
    "    // `MessageFormat` covers {name} and the brace-bodied plural/select/gender",
    "    // forms, but NOT the ICU `, number` / `, date` skeleton arg-types the JS",
    "    // frontends' intl-messageformat handles.  Substituting the raw value is",
    "    // what pre-i18n Flutter already rendered for those holes, so a message",
    "    // the parser rejects degrades rather than crashing a widget build.",
    "    return _substitute(message, values);",
    "  }",
    "}",
    "",
    "String _substitute(String message, Map<String, Object> values) {",
    "  String out = message;",
    "  values.forEach((String name, Object value) {",
    "    out = out.replaceAll(",
    // Interpolated rather than `+`-composed so the emitted file is clean under
    // the generated `analysis_options.yaml` (`prefer_interpolation_to_compose_strings`).
    "      RegExp('\\\\{${RegExp.escape(name)}(,[^{}]*)?\\\\}'),",
    "      value.toString(),",
    "    );",
    "  });",
    "  return out;",
    "}",
  );
}
