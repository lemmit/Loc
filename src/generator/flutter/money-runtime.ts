// The `money` runtime for the Flutter frontend — `lib/money.dart` (M-T1.21).
//
// WHY THIS FILE EXISTS.  `money` rides Loom's wire as a fixed-scale decimal
// STRING (`"12.5000"` — `money-scale.ts`, RS-12) because it persists as
// `NUMERIC(19,4)`: 19 significant digits, exactly.  Dart's only built-in
// numeric types are `int` (64-bit) and `double` (a binary float with ~15–17
// significant digits and no exact representation of `0.1`), so a money value
// CANNOT live in a Dart number without either losing digits at the top end or
// drifting at the bottom.  `dart-types.ts` therefore spells `money` as
// `String` — the wire's own digits, held verbatim — and every operation on it
// routes through this generated helper.
//
// That mirrors what the other frontends already do: `decimal.js`'s `Decimal` on
// React/Vue/Svelte/Angular, `System.Decimal` on Feliz.  Flutter has no such
// type in its SDK, and the mission's design deliberately adds no pub dependency
// (`package:decimal`), so the exact core is BigInt scaled units — the same
// representation `NUMERIC(19,4)` is, and one Dart ships in its core library.
//
// EXACTNESS CONTRACT, stated here and in the emitted header:
//
//   exact   `add` `sub` `neg` `compare` `abs` `min` `max` `floor` `ceil`
//           `round` `normalize`, and `mul` by an INTEGER factor — all pure
//           BigInt arithmetic on scaled units.
//   lossy   `mul` by a fractional factor and `div` — mediated through `double`
//           and re-quantized to the wire scale, because an exact result would
//           need arbitrary-precision division this runtime deliberately does
//           not carry.  Both are documented in the emitted source too, so the
//           reader of the generated app sees the same contract.
//   display `toNum` — the ONE place a money value becomes a Dart number, for
//           formatting (`NumberFormat`) and chart geometry only.  It never
//           feeds back into a stored value.
//
// Emitted ON DEMAND, like `lib/chart.dart` / `lib/modal.dart`: `index.ts` scans
// the rendered sources for the `LoomMoney.` marker and emits both the file and
// the matching per-file import, so neither can dangle (an unused Dart import is
// an analyzer warning, and `flutter analyze` is a per-PR gate).

import { lines } from "../../util/code-builder.js";
import { MONEY_WIRE_SCALE, MONEY_WIRE_ZERO } from "../money-scale.js";

/** The marker `index.ts` / the component + store emitters scan for to decide
 *  whether a file needs `import '…money.dart';` (and whether the runtime file
 *  is emitted at all).  Same use-driven discipline as `LoomChart(`. */
export const LOOM_MONEY_MARKER = "LoomMoney.";

/** True when rendered Dart references the money runtime. */
export function usesMoney(dart: string): boolean {
  return dart.includes(LOOM_MONEY_MARKER);
}

/** `lib/money.dart` — emitted only for a ui whose Dart references `LoomMoney`. */
export function renderFlutterMoneyRuntime(): string {
  return `${lines(
    "// Auto-generated.  Do not edit by hand.",
    "",
    "/// Exact decimal arithmetic over Loom's `money` wire representation.",
    "///",
    "/// A `money` value is the wire STRING — `'12.5000'`, a decimal at exactly",
    `/// [scale] fractional digits, the shape every Loom backend serves and`,
    "/// validates.  It is NOT a `double`: money persists as `NUMERIC(19,4)`",
    "/// (19 significant digits), and a Dart `double` is a binary float with",
    "/// ~15-17 — so a large amount loses digits and a small one drifts",
    "/// (`0.1 + 0.2 != 0.3`).  Holding the string keeps the value the backend",
    "/// sent, byte for byte, and these helpers do the arithmetic on scaled",
    "/// `BigInt` units instead of on a float.",
    "///",
    "/// EXACT: add, sub, neg, compare, abs, min, max, floor, ceil, round,",
    "/// normalize, and mul by a whole-number factor.",
    "/// APPROXIMATE (documented, not accidental): mul by a fractional factor",
    "/// and div, which go through `double` and are re-quantized to [scale].",
    "/// [toNum] is for DISPLAY only (formatting, chart geometry).",
    "///",
    "/// Every method is total: junk or null in yields zero rather than throwing,",
    "/// so a hand-rolled `extern` endpoint outside the generated contract cannot",
    "/// crash a page that merely renders a number.",
    "class LoomMoney {",
    "  const LoomMoney._();",
    "",
    "  /// Fractional digits money carries on the wire (and in `NUMERIC(19,4)`).",
    `  static const int scale = ${MONEY_WIRE_SCALE};`,
    "",
    "  /// Money zero ON THE WIRE — the fixed scale, not a bare `'0'`.",
    `  static const String zero = '${MONEY_WIRE_ZERO}';`,
    "",
    "  static final BigInt _ten = BigInt.from(10);",
    "  static final BigInt _unit = _ten.pow(scale);",
    "",
    "  /// The value as a Dart number — for FORMATTING and chart geometry only.",
    "  /// Total over both shapes a value can arrive in: the money string this",
    "  /// runtime holds, and a bare JSON number from an ungenerated endpoint.",
    "  static num toNum(Object? v) {",
    "    if (v is num) return v;",
    "    return double.tryParse(_text(v)) ?? 0;",
    "  }",
    "",
    "  /// A Dart number as a money string at the wire scale.",
    "  static String fromNum(num v) =>",
    "      v.isFinite ? _fromUnits(_unitsOfNum(v)) : zero;",
    "",
    "  /// Any money-ish value re-spelled at exactly [scale] fractional digits.",
    "  static String normalize(Object? v) => _fromUnits(units(v));",
    "",
    "  // ---- exact core ---------------------------------------------------",
    "",
    "  /// The value in scaled integer units (`'1.2345'` -> `12345`).  Digits",
    "  /// beyond [scale] round half-away-from-zero, the money-safe mode Loom's",
    "  /// intrinsic catalogue specifies.",
    "  static BigInt units(Object? v) {",
    "    if (v is num) return _unitsOfNum(v);",
    "    final s = _text(v).replaceAll(',', '');",
    "    if (s.isEmpty) return BigInt.zero;",
    "    final m = RegExp(r'^([+-]?)(\\d*)(?:\\.(\\d*))?$').firstMatch(s);",
    "    if (m == null) {",
    "      // Exponent notation or junk — fall back to the numeric reading",
    "      // rather than throwing (this runtime is total by contract).",
    "      final d = double.tryParse(s);",
    "      return d == null ? BigInt.zero : _unitsOfNum(d);",
    "    }",
    "    final whole = m.group(2) ?? '';",
    "    final frac = m.group(3) ?? '';",
    "    final kept = frac.length > scale ? frac.substring(0, scale) : frac.padRight(scale, '0');",
    "    var u = BigInt.parse((whole.isEmpty ? '0' : whole) + (kept.isEmpty ? '' : kept));",
    "    if (frac.length > scale) {",
    "      // Half-away-from-zero on the first dropped digit.",
    "      final next = frac.codeUnitAt(scale) - 0x30;",
    "      if (next >= 5) u += BigInt.one;",
    "    }",
    "    return m.group(1) == '-' ? -u : u;",
    "  }",
    "",
    "  /// Scaled units back to the wire spelling (always [scale] digits).",
    "  static String _fromUnits(BigInt u) {",
    "    final neg = u.isNegative;",
    "    final digits = u.abs().toString().padLeft(scale + 1, '0');",
    "    final cut = digits.length - scale;",
    "    final body = '${digits.substring(0, cut)}.${digits.substring(cut)}';",
    "    return neg ? '-$body' : body;",
    "  }",
    "",
    "  static BigInt _unitsOfNum(num v) {",
    "    if (v is int) return BigInt.from(v) * _unit;",
    "    final d = v.toDouble();",
    "    if (!d.isFinite) return BigInt.zero;",
    "    // `toStringAsFixed` is the shortest decimal at the target scale, which",
    "    // is exactly the quantization a double-sourced value can honestly claim.",
    "    return units(d.toStringAsFixed(scale));",
    "  }",
    "",
    "  static String _text(Object? v) => v == null ? '' : v.toString().trim();",
    "",
    "  // ---- arithmetic -----------------------------------------------------",
    "",
    "  static String add(Object? a, Object? b) => _fromUnits(units(a) + units(b));",
    "",
    "  static String sub(Object? a, Object? b) => _fromUnits(units(a) - units(b));",
    "",
    "  static String neg(Object? a) => _fromUnits(-units(a));",
    "",
    "  /// Exact for a whole-number factor (`price * qty` — the common case);",
    "  /// otherwise through `double` and re-quantized to [scale].",
    "  static String mul(Object? a, Object? b) {",
    "    final f = _wholeFactor(b);",
    "    if (f != null) return _fromUnits(units(a) * f);",
    "    final g = _wholeFactor(a);",
    "    if (g != null) return _fromUnits(units(b) * g);",
    "    return fromNum(toNum(a) * toNum(b));",
    "  }",
    "",
    "  /// Through `double` and re-quantized — an exact decimal division needs",
    "  /// unbounded precision.  Division by zero yields [zero] rather than",
    "  /// `Infinity`/`NaN`, which no money field can hold.",
    "  static String div(Object? a, Object? b) {",
    "    final d = toNum(b);",
    "    if (d == 0) return zero;",
    "    return fromNum(toNum(a) / d);",
    "  }",
    "",
    "  /// The whole-number value of a factor, or null when it has a fraction.",
    "  static BigInt? _wholeFactor(Object? v) {",
    "    if (v is int) return BigInt.from(v);",
    "    final u = units(v);",
    "    return u % _unit == BigInt.zero ? u ~/ _unit : null;",
    "  }",
    "",
    "  // ---- comparison ------------------------------------------------------",
    "",
    "  /// `<0`, `0`, `>0` — the ordering `<`/`<=`/`>`/`>=`/`==` on money route",
    "  /// through, so `'9.0000'` and `'10.0000'` compare NUMERICALLY (a raw",
    "  /// string comparison would put 10 before 9).",
    "  static int compare(Object? a, Object? b) => units(a).compareTo(units(b));",
    "",
    "  // ---- intrinsics (src/util/intrinsics.ts) ------------------------------",
    "",
    "  static String abs(Object? a) => _fromUnits(units(a).abs());",
    "",
    "  static String min(Object? a, Object? b) => compare(a, b) <= 0 ? normalize(a) : normalize(b);",
    "",
    "  static String max(Object? a, Object? b) => compare(a, b) >= 0 ? normalize(a) : normalize(b);",
    "",
    "  /// HALF-AWAY-FROM-ZERO at [places] decimals (the catalogue's money-safe",
    "  /// mode, not banker's rounding).  `places` defaults to 0.",
    "  static String round(Object? a, [int places = 0]) {",
    "    final drop = scale - places;",
    "    if (drop <= 0) return normalize(a);",
    "    final p = _ten.pow(drop);",
    "    final u = units(a);",
    "    final q = u.abs() ~/ p;",
    "    final r = u.abs() % p;",
    "    final up = r * BigInt.two >= p ? q + BigInt.one : q;",
    "    final res = up * p;",
    "    return _fromUnits(u.isNegative ? -res : res);",
    "  }",
    "",
    "  /// Toward NEGATIVE infinity, keeping the money type (a whole-valued",
    "  /// money, not an int) — the catalogue contract.",
    "  static String floor(Object? a) {",
    "    final u = units(a);",
    "    final q = _floorDiv(u, _unit);",
    "    return _fromUnits(q * _unit);",
    "  }",
    "",
    "  /// Toward POSITIVE infinity, keeping the money type.",
    "  static String ceil(Object? a) {",
    "    final u = units(a);",
    "    final q = _floorDiv(u, _unit);",
    "    final exact = q * _unit == u;",
    "    return _fromUnits((exact ? q : q + BigInt.one) * _unit);",
    "  }",
    "",
    "  /// BigInt's `~/` truncates toward zero; floor/ceil need the flooring form.",
    "  static BigInt _floorDiv(BigInt a, BigInt b) {",
    "    final q = a ~/ b;",
    "    return (a.isNegative && q * b != a) ? q - BigInt.one : q;",
    "  }",
    "}",
  )}\n`;
}
