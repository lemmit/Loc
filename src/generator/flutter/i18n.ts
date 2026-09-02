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
//     EXCEPT the `, number` / `, date` / `, time` arg-types.  Those are resolved
//     BEFORE the message reaches it, by `_resolveFormats` below: each such hole
//     is formatted through `intl`'s `NumberFormat` / `DateFormat` and handed to
//     `MessageFormat` as a plain value, so `{total, number, ::currency/USD}`
//     renders `$1,234.50` exactly as the four JS frontends and Feliz render it.
//
//     That pre-pass is not an optimisation — without it a skeleton hole is not
//     even a degradation.  `MessageFormat` does not THROW on the arg-type (which
//     is what the old `try`/`catch` assumed): its `_parseBlockType` classifies
//     the block as a SIMPLE PLACEHOLDER whose name is the whole
//     `total, number, ::currency/USD` string, finds no value under that key, and
//     renders the literal text `Undefined parameter - total, number,
//     ::currency/USD` into the widget.  The `catch` still guards a message
//     `MessageFormat` genuinely rejects — degrading beats crashing a `build()`,
//     the same trade PR #2437 made on HEEx.
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
    "// Generated translation runtime (Loom i18n).",
    "//",
    "// Source-language lookup with a per-key fallback, plus ICU message",
    "// formatting via `package:intl`'s `MessageFormat`.  The `t(key, default,",
    "// values)` call sites the walker emits are stable across every frontend —",
    "// only the spelling differs.",
    "//",
    "// To add a locale: add its map below and register it in `_catalogs`.  Date",
    "// symbols load lazily — call `initializeDateFormatting(<locale>)` from",
    "// `main()` and `, date` holes format in that locale too (without it they fall",
    "// back to the SDK default rather than failing).",
    "import 'dart:ui' as ui;",
    "",
    "import 'package:intl/intl.dart';",
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
    "    final _Icu icu = _resolveFormats(message, values);",
    "    return MessageFormat(icu.message, locale: locale).format(icu.values);",
    "  } catch (_) {",
    "    // A message `MessageFormat` genuinely rejects degrades rather than",
    "    // crashing a widget build: substitute the raw values and render what is",
    "    // left.  (The `, number` / `, date` arg-types it does not implement are",
    "    // already resolved by `_resolveFormats` above — they never reach here.)",
    "    return _substitute(message, values);",
    "  }",
    "}",
    "",
    "/// A message rewritten into what `MessageFormat` can render, plus the values",
    "/// to render it with — the originals plus one entry per pre-formatted hole.",
    "class _Icu {",
    "  const _Icu(this.message, this.values);",
    "  final String message;",
    "  final Map<String, Object> values;",
    "}",
    "",
    "/// `{name, number|date|time[, style]}` — the ICU arg-types `MessageFormat`",
    "/// does not implement.  The style is brace-free by construction (a skeleton or",
    "/// a pattern), which is what keeps this from matching a plural/select body.",
    "final RegExp _formatArg =",
    "    RegExp(r'\\{([A-Za-z_][A-Za-z0-9_]*)\\s*,\\s*(number|date|time)\\s*(?:,([^{}]*))?\\}');",
    "",
    "/// Format every `, number` / `, date` / `, time` hole through `intl` and swap",
    "/// it for a plain placeholder carrying the formatted text.  Handing",
    "/// `MessageFormat` a VALUE rather than splicing the text into the pattern keeps",
    "/// a formatted `{` or `#` out of the syntax it re-parses.  A hole whose value",
    "/// is missing or of the wrong runtime type degrades to a bare `{name}` — the",
    "/// raw value, which is what pre-i18n Flutter rendered.",
    "_Icu _resolveFormats(String message, Map<String, Object> values) {",
    "  if (!message.contains(',')) return _Icu(message, values);",
    "  final Map<String, Object> resolved = Map<String, Object>.of(values);",
    "  int next = 0;",
    "  final String rewritten = message.replaceAllMapped(_formatArg, (Match m) {",
    "    final String name = m[1]!;",
    "    final Object? value = values[name];",
    "    final String? text =",
    "        value == null ? null : _formatValue(m[2]!, (m[3] ?? '').trim(), value);",
    "    if (text == null) return '{$name}';",
    "    final String hole = 'loomFmt${next++}';",
    "    resolved[hole] = text;",
    "    return '{$hole}';",
    "  });",
    "  return _Icu(rewritten, resolved);",
    "}",
    "",
    "/// One formatted hole, or null when the value cannot be formatted that way",
    "/// (the caller then degrades the hole to its raw value).",
    "String? _formatValue(String type, String style, Object value) {",
    "  try {",
    "    if (type == 'number') {",
    "      final num? n = value is num ? value : num.tryParse(value.toString());",
    "      return n == null ? null : _numberFormat(style).format(n);",
    "    }",
    "    final DateTime? at =",
    "        value is DateTime ? value : DateTime.tryParse(value.toString());",
    "    if (at == null) return null;",
    "    return (type == 'date' ? _dateFormat(style) : _timeFormat(style)).format(at);",
    "  } catch (_) {",
    "    return null;",
    "  }",
    "}",
    "",
    "/// `NumberFormat` for an ICU number style: a skeleton (`::currency/USD`), one",
    "/// of the classic style keywords, or an explicit pattern (`#,##0.00`).",
    "NumberFormat _numberFormat(String style) {",
    "  if (style.startsWith('::')) return _numberSkeleton(style.substring(2).trim());",
    "  switch (style) {",
    "    case 'integer':",
    "      return _withFractionDigits(NumberFormat.decimalPattern(locale), 0, 0);",
    "    case 'percent':",
    "      return NumberFormat.percentPattern(locale);",
    "    case 'currency':",
    "      return NumberFormat.simpleCurrency(locale: locale);",
    "    case '':",
    "    case 'decimal':",
    "      return NumberFormat.decimalPattern(locale);",
    "    default:",
    "      return NumberFormat(style, locale);",
    "  }",
    "}",
    "",
    "/// The number-skeleton stems a `, number, ::…` hole uses.  An unrecognised",
    "/// stem is ignored rather than fatal — the number still renders",
    "/// locale-formatted.",
    "NumberFormat _numberSkeleton(String skeleton) {",
    "  NumberFormat? format;",
    "  int? minFraction;",
    "  int? maxFraction;",
    "  for (final String stem in skeleton.split(RegExp(r'\\s+'))) {",
    "    if (stem == 'currency') {",
    "      format = NumberFormat.simpleCurrency(locale: locale);",
    "    } else if (stem.startsWith('currency/')) {",
    "      format =",
    "          NumberFormat.simpleCurrency(locale: locale, name: stem.substring(9));",
    "    } else if (stem == 'percent') {",
    "      format = NumberFormat.percentPattern(locale);",
    "    } else if (stem == 'compact' || stem == 'compact-short') {",
    "      format = NumberFormat.compact(locale: locale);",
    "    } else if (stem == 'compact-long') {",
    "      format = NumberFormat.compactLong(locale: locale);",
    "    } else if (stem == 'integer' || stem == 'precision-integer') {",
    "      minFraction = 0;",
    "      maxFraction = 0;",
    "    } else if (RegExp(r'^\\.0*#*$').hasMatch(stem)) {",
    "      // `.00` → exactly two digits; `.0#` → one to two; `.##` → up to two.",
    "      minFraction = '0'.allMatches(stem).length;",
    "      maxFraction = stem.length - 1;",
    "    }",
    "  }",
    "  return _withFractionDigits(",
    "      format ?? NumberFormat.decimalPattern(locale), minFraction, maxFraction);",
    "}",
    "",
    "NumberFormat _withFractionDigits(NumberFormat format, int? min, int? max) {",
    "  if (max != null) format.maximumFractionDigits = max;",
    "  if (min != null) format.minimumFractionDigits = min;",
    "  return format;",
    "}",
    "",
    "/// `DateFormat` for an ICU date style — a skeleton (`::yMMMd`), one of the",
    "/// four classic widths, or an explicit pattern.",
    "DateFormat _dateFormat(String style) {",
    "  if (style.startsWith('::')) {",
    "    return _localizedDate((String? l) => DateFormat(style.substring(2).trim(), l));",
    "  }",
    "  switch (style) {",
    "    case 'short':",
    "      return _localizedDate(DateFormat.yMd);",
    "    case 'long':",
    "      return _localizedDate(DateFormat.yMMMMd);",
    "    case 'full':",
    "      return _localizedDate(DateFormat.yMMMMEEEEd);",
    "    case '':",
    "    case 'medium':",
    "      return _localizedDate(DateFormat.yMMMd);",
    "    default:",
    "      return _localizedDate((String? l) => DateFormat(style, l));",
    "  }",
    "}",
    "",
    "/// The `, time` twin of [_dateFormat].",
    "DateFormat _timeFormat(String style) {",
    "  if (style.startsWith('::')) {",
    "    return _localizedDate((String? l) => DateFormat(style.substring(2).trim(), l));",
    "  }",
    "  switch (style) {",
    "    case 'medium':",
    "    case 'long':",
    "    case 'full':",
    "      return _localizedDate(DateFormat.jms);",
    "    case '':",
    "    case 'short':",
    "      return _localizedDate(DateFormat.jm);",
    "    default:",
    "      return _localizedDate((String? l) => DateFormat(style, l));",
    "  }",
    "}",
    "",
    "/// Build a `DateFormat` in the active locale, falling back to the SDK default",
    "/// when that locale's date symbols were never initialized.  `intl` loads date",
    "/// data lazily (`initializeDateFormatting`) — unlike number symbols, which are",
    "/// compiled in — so a `, date` hole must not fail just because `main()` never",
    "/// initialized this locale.",
    "DateFormat _localizedDate(DateFormat Function(String?) build) {",
    "  try {",
    "    return build(locale);",
    "  } catch (_) {",
    "    return build(null);",
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
