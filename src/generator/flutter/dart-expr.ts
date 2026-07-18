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

import type { LiteralKind, PrimitiveName, TypeIR } from "../../ir/types/loom-ir.js";

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

/** Pure Dart leaf formatters — one per divergent expression arm.  Sub-expressions
 *  arrive already rendered.  Signatures match the optional `WalkerTarget`
 *  expr-leaf seam so `flutterTarget` can forward straight to these. */
export const DART_LEAVES = {
  literal(lit: LiteralKind, value: string): string {
    if (lit === "string") return dartString(value);
    if (lit === "bool") return value; // true / false spelled identically
    if (lit === "null") return "null";
    // int / long / decimal / money / now → numeric literal verbatim.
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
    if (target === "string") return `${value}.toString()`;
    if (target === "int" || target === "long") {
      return from === "string" ? `int.parse(${value})` : `(${value}).toInt()`;
    }
    if (target === "decimal" || target === "money") {
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
};

/** Dart zero value for a primitive — used by `dartZeroValue`. */
function dartPrimitiveZero(name: PrimitiveName): string {
  switch (name) {
    case "int":
    case "long":
      return "0";
    case "decimal":
    case "money":
      return "0.0";
    case "bool":
      return "false";
    case "datetime":
      return "null";
    default:
      return "''"; // string, guid, json, duration → empty string default
  }
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
