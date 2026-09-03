// Dart expression rendering for the Flutter frontend target.
//
// The frontend twin of the backend `ExprTarget` (src/generator/_expr/target.ts)
// and the sibling of Feliz's `FS_LEAVES` (src/generator/feliz/fs-expr.ts): a set
// of pure leaf formatters, one per divergent `ExprIR` arm, that receive
// already-rendered sub-expressions and spell them in Dart.  `flutterTarget`'s
// expr-leaf seam methods forward straight to these — there is NO JS fallback (the
// shared `emitExpr` dispatcher delegates every syntax arm to the target's leaf
// table, one table per embedded language).
//
// Flutter is structurally a Feliz clone (a non-JSX, function-call-tree target),
// so the shape mirrors `FS_LEAVES` exactly; only the syntax is Dart, not F#.

import type { ExprIR, LiteralKind, PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import { DURATION_UNIT_MS } from "../../util/temporal.js";
import { MONEY_WIRE_SCALE, MONEY_WIRE_ZERO } from "../money-scale.js";

/** The constructor parameter a component widget's `Slot { }` reads, and the one
 *  a call site fills with the children it passed.  `child` is Flutter's own name
 *  for a single-widget slot (`Card(child: …)`), so the generated widget reads
 *  the way a hand-written one would. */
export const FLUTTER_CHILD_PARAM = "child";

/** Dart single-quoted string literal.  Escapes the backslash, the quote, and
 *  `$` (Dart's string-interpolation sigil), plus the two structural whitespace
 *  escapes.  The order matters: the backslash must be escaped first. */
export function dartString(value: string): string {
  return `'${value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\$/g, "\\$")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}'`;
}

/** A `money` LITERAL as Dart source — a string literal carrying the wire's own
 *  digits (M-T1.21), never a numeric one.
 *
 *  `money` is a Dart `String` on this target, so `price := 12.5` has to emit
 *  `'12.5000'`: a bare `12.5` would not even type-check against the field, and
 *  routing it through a `double` on the way in would defeat the whole point of
 *  holding the string.  The scale is applied HERE, at compile time, by padding
 *  the literal's own digits — no float hop, no runtime call.
 *
 *  A literal already carrying MORE than `MONEY_WIRE_SCALE` fractional digits is
 *  passed through verbatim rather than rounded: the backend's request schema
 *  accepts any scale and quantizes at the column, and silently dropping digits
 *  the author wrote is the kind of loss this mission exists to remove. */
export function dartMoneyLiteral(value: string): string {
  const raw = value.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m) return dartString(raw);
  const sign = m[1] === "-" ? "-" : "";
  const whole = m[2] === "" ? "0" : m[2];
  const frac = m[3] ?? "";
  const padded = frac.length >= MONEY_WIRE_SCALE ? frac : frac.padEnd(MONEY_WIRE_SCALE, "0");
  return dartString(`${sign}${whole}.${padded}`);
}

/** Dart spelling of the `now()` literal — the current instant on the UTC clock.
 *  `DateTime.now()` alone is a LOCAL-time value, so `.toUtc()` normalizes it to
 *  the same clock the wire carries: `dart-types.ts` decodes a `datetime` with
 *  `DateTime.parse(...)`, and the datetime intrinsics (`dart-expr.ts`'s
 *  `datetime.startOfDay`) likewise `.toUtc()` before reading fields rather than
 *  trusting the parsed value's Kind.  Matches Feliz's `System.DateTime.UtcNow`
 *  and the .NET backend's spelling of the same literal. */
export const DART_NOW = "DateTime.now().toUtc()";

/** Pure Dart leaf formatters — one per divergent expression arm.  Sub-expressions
 *  arrive already rendered.  Signatures match the optional `WalkerTarget`
 *  expr-leaf seam so `flutterTarget` can forward straight to these. */
export const DART_LEAVES = {
  literal(lit: LiteralKind, value: string): string {
    if (lit === "string") return dartString(value);
    if (lit === "bool") return value; // true / false spelled identically
    if (lit === "null") return "null";
    // `now()` is a LITERAL kind whose `value` is the word "now", not a number,
    // so the numeric-verbatim fallthrough below emitted a bare `now` — an
    // unbound Dart identifier, and the only literal kind on this target that is
    // not already valid Dart text.
    if (lit === "now") return DART_NOW;
    // A MONEY literal (`money("12.50")`, and a money-typed `state` seed) is the
    // wire STRING on this target — `dart-types.ts` spells `money` as `String`.
    // Emitting the bare number here produced a `double` where a `String` was
    // required (M-T1.21).
    if (lit === "money") return dartMoneyLiteral(value);
    // int / long / decimal → numeric literal verbatim.
    return value;
  },
  binary(left: string, right: string, op: string): string {
    // Loom's operators are spelled identically in Dart — including `==` / `!=`
    // (unlike JS's strict `===` or F#'s `=` / `<>`).
    return `(${left} ${op} ${right})`;
  },
  unary(op: string, operand: string): string {
    // `!x` and `-x` are both valid Dart unary forms.
    return `(${op}${operand})`;
  },
  ternary(cond: string, then: string, otherwise: string): string {
    return `(${cond} ? ${then} : ${otherwise})`;
  },
  convert(value: string, target: string, from: string | undefined): string {
    // `money` is a Dart String holding the wire's digits, so every conversion
    // that touches it goes through the runtime rather than through `double`
    // (M-T1.21).  A money SOURCE is already a String — `.toString()` on it is
    // a no-op, and `int.parse('12.5000')` would throw.
    if (target === "string") return from === "money" ? value : `${value}.toString()`;
    if (target === "money") {
      return from === "string" || from === "money"
        ? `LoomMoney.normalize(${value})`
        : `LoomMoney.fromNum(${value})`;
    }
    if (target === "int" || target === "long") {
      if (from === "money") return `LoomMoney.toNum(${value}).toInt()`;
      return from === "string" ? `int.parse(${value})` : `(${value}).toInt()`;
    }
    if (target === "decimal") {
      if (from === "money") return `LoomMoney.toNum(${value}).toDouble()`;
      return from === "string" ? `double.parse(${value})` : `(${value}).toDouble()`;
    }
    return value;
  },
  list(elements: string[]): string {
    return `[${elements.join(", ")}]`;
  },
  object(fields: ReadonlyArray<{ name: string; value: string }>): string {
    // Dart map literal — the closest analogue of a JS object literal (the wire
    // model classes are Track A's concern; a bare object here is a `Map`).
    return `{${fields.map((f) => `${dartString(f.name)}: ${f.value}`).join(", ")}}`;
  },
  /** `days(7)` — a Dart `Duration`, NOT the bare millisecond number the JS
   *  frontends use: Dart's `DateTime` has no `+` operator at all, so a number
   *  here does not even parse as datetime arithmetic.  The SPAN still comes
   *  from `DURATION_UNIT_MS`, so `7 days` is the same length of time here as
   *  on the wire and on every backend.  (Dart's `int` is 64-bit, so the
   *  millisecond product needs no widening.) */
  duration(unit: keyof typeof DURATION_UNIT_MS, amount: string): string {
    return `Duration(milliseconds: ((${amount}) * ${DURATION_UNIT_MS[unit]}))`;
  },
};

/** The datetime-involving `+`/`-` arms, or `null` to fall through to the plain
 *  operator leaf.  Dart's `DateTime` defines NO arithmetic operators, so every
 *  arm here is a method call — without them `until + days(7)` emits an
 *  `operator +` that does not exist:
 *
 *    datetime + duration → datetime   ⇒ `(l).add(r)`
 *    datetime − duration → datetime   ⇒ `(l).subtract(r)`
 *    duration + datetime → datetime   ⇒ `(r).add(l)`        (commuted form)
 *    datetime − datetime → duration   ⇒ `(l).difference(r)`
 *
 *  Dispatch is type-driven off the lowering's `leftType`/`rightType` stamps,
 *  exactly as the TypeScript backend's `renderTemporalBinary` does. */
export function dartTemporalBinary(
  left: string,
  right: string,
  e: Extract<ExprIR, { kind: "binary" }>,
): string | null {
  if (e.op !== "+" && e.op !== "-") return null;
  const prim = (t: TypeIR | undefined): string | undefined =>
    t?.kind === "primitive" ? t.name : undefined;
  const lt = prim(e.leftType);
  const rt = prim(e.rightType);
  if (lt === "datetime" && rt === "duration") {
    return `(${left}).${e.op === "+" ? "add" : "subtract"}(${right})`;
  }
  if (lt === "duration" && rt === "datetime" && e.op === "+") {
    return `(${right}).add(${left})`;
  }
  if (lt === "datetime" && rt === "datetime" && e.op === "-") {
    return `(${left}).difference(${right})`;
  }
  return null;
}

/** The money-involving binary arms, or `null` to fall through to the plain
 *  operator leaf.
 *
 *  `money` is a Dart `String` on this target (`dart-types.ts` — it holds the
 *  wire's own digits, M-T1.21), and Dart's operators on a `String` mean
 *  something else entirely: `a + b` CONCATENATES (`'10.0000' + '2.0000'` →
 *  `'10.00002.0000'`), `a < b` does not compile, and `==` is exact text
 *  equality, so `'1.5'` and `'1.5000'` — the same amount — compare unequal.
 *  Every one of those is silently wrong rather than loudly broken, which is
 *  exactly why this dispatch exists.
 *
 *  Dispatch is type-driven off the lowering's `leftType`/`rightType` stamps,
 *  the same way `dartTemporalBinary` above dispatches.  Either side being money
 *  is enough: `LoomMoney` coerces both operands through `units`, so a
 *  `money * int` and an `int * money` are both exact. */
export function dartMoneyBinary(
  left: string,
  right: string,
  e: Extract<ExprIR, { kind: "binary" }>,
): string | null {
  const prim = (t: TypeIR | undefined): string | undefined =>
    t?.kind === "primitive"
      ? t.name
      : t?.kind === "optional" && t.inner.kind === "primitive"
        ? t.inner.name
        : undefined;
  if (prim(e.leftType) !== "money" && prim(e.rightType) !== "money") return null;
  switch (e.op) {
    case "+":
      return `LoomMoney.add(${left}, ${right})`;
    case "-":
      return `LoomMoney.sub(${left}, ${right})`;
    case "*":
      return `LoomMoney.mul(${left}, ${right})`;
    case "/":
      return `LoomMoney.div(${left}, ${right})`;
    case "<":
    case "<=":
    case ">":
    case ">=":
      return `(LoomMoney.compare(${left}, ${right}) ${e.op} 0)`;
    case "==":
      return `(LoomMoney.compare(${left}, ${right}) == 0)`;
    case "!=":
      return `(LoomMoney.compare(${left}, ${right}) != 0)`;
    default:
      // Logical/other operators never take a money operand; fall through.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Scalar-intrinsic snippet table for Dart / Flutter — the sibling of
// `_expr/js-intrinsics.ts` (JS family), `dotnet/render-expr.ts`'s
// `CS_INTRINSIC_RENDERERS` (C#), and `feliz/fs-expr.ts`'s
// `FS_INTRINSIC_RENDERERS` (F#).  One arm per `INTRINSIC_SIGNATURES` row,
// keyed `<receiver>.<name>` via `intrinsicKey`.
//
// Flutter is structurally a Feliz clone (walker-core dispatches through ONE
// `WalkerTarget` seam, `renderIntrinsic`), but unlike Feliz it has no SECOND,
// hand-rolled dispatch for action/Notifier bodies — `riverpod-emit.ts`'s
// `renderNotifierStmt` calls the SAME shared `emitExpr`/`walkBody` the page
// view uses (see that file's header).  So there is only one place for this
// table to be missing, and it was: without it, `emitExpr`'s `method-call`
// fallthrough emitted Loom's own spelling VERBATIM — a compile error wherever
// Dart spells the op differently (`toUpper` vs `toUpperCase`), and SILENTLY
// WRONG wherever it spells it the same but means something else
// (`substring`, whose Dart form takes start+END and THROWS out of range
// rather than Loom's start+LENGTH, CLAMPING contract).
//
// Representation on this target (`dart-types.ts`): `int`/`long` → Dart `int`,
// `decimal`/`money` → Dart `double` (money is a bare precise scalar, no
// currency), `datetime` → Dart `DateTime`, and a Loom `T[]` is a Dart `List`.
//
// Flutter's coincidence surface is wider than Feliz's or JS's — `contains`,
// `startsWith`, `endsWith`, `replaceAll`, `split`, `abs()` are already
// spelled the way the catalogue needs — which is exactly why this table
// exists as a DECLARED set rather than an assumed one: a confirmation is
// still a claim, and the plan this table closes out is about not assuming.

/** `dart:math`'s `min`/`max`/`pow` are used by three arms below (`min`, `max`,
 *  `round`).  The emitter injects `import 'dart:math' as math;` structurally —
 *  by scanning the rendered page/component source for the literal `"math."`
 *  substring, the same technique `usesIntl`/`usesI18n` already use for their
 *  own on-demand imports (`src/generator/flutter/index.ts`,
 *  `component-emit.ts`) — so a page that never calls one of these three never
 *  carries an unused import under `flutter analyze`. */
export const DART_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `(${recv}.trim())`,
  "string.toUpper": (recv) => `(${recv}.toUpperCase())`,
  "string.toLower": (recv) => `(${recv}.toLowerCase())`,
  // 0-based CLAMPING semantics (JS `slice` — the catalogue contract).  Dart's
  // `substring(start, [end])` takes start+END (not start+LENGTH) and THROWS
  // a RangeError on an out-of-range start or end, so both the arg-shape and
  // the clamping are bridged here.  Receiver/arg duplication is safe — Loom
  // expressions are pure.
  "string.substring": (recv, args) =>
    args.length > 1
      ? `(${args[0]} >= ${recv}.length ? '' : ${recv}.substring(${args[0]}, math.min((${args[0]}) + (${args[1]}), ${recv}.length)))`
      : `(${args[0]} >= ${recv}.length ? '' : ${recv}.substring(${args[0]}))`,
  // Ordinal (culture-free) comparison, exactly as `String.startsWith` /
  // `endsWith` / `contains` already are in Dart — no wrapper needed.
  "string.startsWith": (recv, args) => `(${recv}.startsWith(${args[0]}))`,
  "string.endsWith": (recv, args) => `(${recv}.endsWith(${args[0]}))`,
  "string.contains": (recv, args) => `(${recv}.contains(${args[0]}))`,
  // `replaceAll` already replaces ALL occurrences — the Loom contract; bare
  // `.replace(...)` does not exist on Dart's `String`.
  "string.replace": (recv, args) => `(${recv}.replaceAll(${args[0]}, ${args[1]}))`,
  // Dart's `split` already keeps empty segments (including a trailing one) —
  // the catalogue contract — with no wrapper needed.
  "string.split": (recv, args) => `(${recv}.split(${args[0]}))`,
  // ---- numerics -----------------------------------------------------------
  "int.abs": (recv) => `(${recv}.abs())`,
  "long.abs": (recv) => `(${recv}.abs())`,
  "decimal.abs": (recv) => `(${recv}.abs())`,
  // ---- money: the wire STRING, so every arm routes through `LoomMoney`
  // (`money-runtime.ts`) rather than through Dart's `num` methods, which a
  // `String` does not have (M-T1.21).  The `decimal` arms above are untouched
  // — `decimal` really is a Dart `double`.
  "money.abs": (recv) => `LoomMoney.abs(${recv})`,
  // Dart's `~/` is documented as truncating TOWARD ZERO (num.operator~/),
  // matching the catalogue contract directly — unlike Python's floor-only `//`.
  "int.divTrunc": (recv, args) => `(${recv} ~/ ${args[0]})`,
  "long.divTrunc": (recv, args) => `(${recv} ~/ ${args[0]})`,
  // Two-value LEAST/GREATEST (the catalogue contract), not an aggregate.
  "int.min": (recv, args) => `(math.min(${recv}, ${args[0]}))`,
  "long.min": (recv, args) => `(math.min(${recv}, ${args[0]}))`,
  "decimal.min": (recv, args) => `(math.min(${recv}, ${args[0]}))`,
  "money.min": (recv, args) => `LoomMoney.min(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `(math.max(${recv}, ${args[0]}))`,
  "long.max": (recv, args) => `(math.max(${recv}, ${args[0]}))`,
  "decimal.max": (recv, args) => `(math.max(${recv}, ${args[0]}))`,
  "money.max": (recv, args) => `LoomMoney.max(${recv}, ${args[0]})`,
  // HALF-AWAY-FROM-ZERO ("commercial") rounding per the catalogue — Dart's
  // native `.round()` rounds `.5` toward POSITIVE INFINITY (`-0.5` → `0`,
  // not `-1`), so the mode is forced via sign/abs, exactly as the JS and F#
  // tables do for the same reason.  `places` defaults to 0.
  "decimal.round": (recv, args) =>
    args.length > 0
      ? `(${recv}.sign * (((${recv}).abs() * math.pow(10, ${args[0]})).round() / math.pow(10, ${args[0]})))`
      : `(${recv}.sign * ((${recv}).abs()).round())`,
  // HALF-AWAY-FROM-ZERO is the runtime's own rounding mode (BigInt units), so
  // the sign/abs dance the `double` arms need does not apply here.
  "money.round": (recv, args) =>
    args.length > 0 ? `LoomMoney.round(${recv}, ${args[0]})` : `LoomMoney.round(${recv})`,
  // floor/ceil KEEP the receiver type (a whole-valued double, not an int) —
  // `floorToDouble`/`ceilToDouble` do exactly that (bare `.floor()`/`.ceil()`
  // on a Dart `double` return `int`, which would silently narrow the type).
  "decimal.floor": (recv) => `(${recv}.floorToDouble())`,
  "money.floor": (recv) => `LoomMoney.floor(${recv})`,
  "decimal.ceil": (recv) => `(${recv}.ceilToDouble())`,
  "money.ceil": (recv) => `LoomMoney.ceil(${recv})`,
  // ---- datetime -------------------------------------------------------------
  // MIDNIGHT UTC of the receiver's day (the catalogue contract).  `DateTime`'s
  // plain constructor builds a LOCAL-time value even when every field is read
  // off a UTC instant, so `DateTime.utc(...)` is required to stamp the Kind —
  // and `.toUtc()` first normalizes a receiver that isn't already UTC, the
  // same defensive read the JS (`getUTC*`) and F# (`ToUniversalTime()`) tables
  // take rather than trusting the wire's Kind.
  "datetime.startOfDay": (recv) =>
    `(DateTime.utc((${recv}).toUtc().year, (${recv}).toUtc().month, (${recv}).toUtc().day))`,
};

/**
 * Render a scalar intrinsic to Dart, or `undefined` when this member is not a
 * catalogue intrinsic on this receiver — the caller then falls through to its
 * ordinary member/method-call emission.
 *
 * Mirrors `renderJsIntrinsic`/`renderFsIntrinsic`: intrinsics are
 * RECEIVER-QUALIFIED, so a `string.contains` (substring test) and a
 * `T[].contains` (collection membership) never collide — lowering keys
 * `isCollectionOp` off the receiver type, and a primitive receiver is never
 * flagged as one.
 */
export function renderDartIntrinsic(
  receiverType: TypeIR,
  member: string,
  recv: string,
  args: readonly string[],
): string | undefined {
  if (receiverType.kind !== "primitive") return undefined;
  if (!intrinsicFor(receiverType.name, member)) return undefined;
  const render = DART_INTRINSIC_RENDERERS[intrinsicKey(receiverType.name, member)];
  return render ? render(recv, [...args]) : undefined;
}

/** Dart zero value for a primitive — used by `dartZeroValue`. */
function dartPrimitiveZero(name: PrimitiveName): string {
  switch (name) {
    case "int":
    case "long":
      return "0";
    case "decimal":
      return "0.0";
    case "money":
      // Money's zero is the WIRE zero — `'0.0000'`, a String at the fixed
      // scale, not a `double` (M-T1.21).  A bare `0.0` here would not even
      // type-check against the `String` cell the state class declares.
      return `'${MONEY_WIRE_ZERO}'`;
    case "bool":
      return "false";
    case "datetime":
      return "null";
    case "File":
      // A `FileRef` starts unset — a FileUpload binds a `File?` state cell.
      return "null";
    default:
      return "''"; // string, guid, json, duration → empty string default
  }
}

/** True when `t` is (optionally) the `money` primitive. */
export function isMoneyType(t: TypeIR): boolean {
  const base = t.kind === "optional" ? t.inner : t;
  return base.kind === "primitive" && base.name === "money";
}

/** A `state {}` field's rendered initial value, coerced to the money WIRE
 *  STRING when the field is money-typed and the init rendered as a number.
 *
 *  The Dart twin of `coerceMoneyStateInit` (`_expr/js-intrinsics.ts`), and it
 *  exists for the same reason: `m: money = 1.50` lowers as a DECIMAL literal
 *  (`lit: "decimal"`), which renders as the bare `1.50` — a `double` seeded
 *  into a `String` cell, which does not compile.  Keyed on the DECLARED TYPE
 *  rather than on the literal kind, because that is the fact that makes the
 *  coercion necessary.  A `money(…)` conversion form already renders through
 *  `LoomMoney`, and any other expression is already a money String, so both
 *  pass through untouched. */
export function coerceDartMoneyInit(t: TypeIR, rendered: string): string {
  if (!isMoneyType(t)) return rendered;
  const raw = rendered.trim();
  return /^[+-]?\d+(\.\d+)?$/.test(raw) ? dartMoneyLiteral(raw) : rendered;
}

/** Dart initial value for a `state {}` field whose declaration omits `= <init>`.
 *  The Dart analogue of Feliz's `fsZeroValue`. */
export function dartZeroValue(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      return dartPrimitiveZero(t.name);
    case "array":
      return "const []";
    case "optional":
    case "none":
      return "null";
    default:
      return "null";
  }
}
