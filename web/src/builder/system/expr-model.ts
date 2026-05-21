import type { Expression } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Editable expression tree for the structured expression editor — the shared
// recursive layer above the body/expression text surfaces.
//
// `seedExpr` decomposes a parsed Expression into an `EExpr` tree; `emitExpr`
// renders it back to `.ddd` source (mirroring `print-expr.ts`).  v1 structures
// the operator tree (binary / unary / paren) and literals; every other form
// (names, member access, calls, match, lambda, new, …) is a `raw` leaf carrying
// its printed source verbatim — recognise-or-raw, exactly like the page
// builder.  Edits are validated by re-parsing the whole document at the call
// site, so an operator swap or a re-typed leaf can never silently corrupt.
// ---------------------------------------------------------------------------

export type LitKind = "string" | "int" | "dec" | "bool" | "null";

export type EExpr =
  | { kind: "binary"; op: string; left: EExpr; right: EExpr }
  | { kind: "unary"; op: string; operand: EExpr }
  | { kind: "paren"; inner: EExpr }
  | { kind: "lit"; lit: LitKind; value: string }
  | { kind: "raw"; text: string };

// BinaryExpr.op covers comparison, logical and arithmetic operators.
export const BINARY_OPS = ["==", "!=", "<", "<=", ">", ">=", "&&", "||", "+", "-", "*", "/", "%"];
export const UNARY_OPS = ["!", "-"];

export function seedExpr(node: Expression): EExpr {
  switch (node.$type) {
    case "BinaryExpr":
      return { kind: "binary", op: node.op, left: seedExpr(node.left), right: seedExpr(node.right) };
    case "UnaryExpr":
      return { kind: "unary", op: node.op, operand: seedExpr(node.operand) };
    case "ParenExpr":
      return { kind: "paren", inner: seedExpr(node.inner) };
    case "StringLit":
      return { kind: "lit", lit: "string", value: node.value };
    case "IntLit":
      return { kind: "lit", lit: "int", value: String(node.value) };
    case "DecLit":
      return { kind: "lit", lit: "dec", value: node.value };
    case "BoolLit":
      return { kind: "lit", lit: "bool", value: node.value };
    case "NullLit":
      return { kind: "lit", lit: "null", value: "null" };
    default:
      return { kind: "raw", text: printExpr(node) };
  }
}

export function emitExpr(e: EExpr): string {
  switch (e.kind) {
    case "binary":
      return `${emitExpr(e.left)} ${e.op} ${emitExpr(e.right)}`;
    case "unary":
      return `${e.op}${emitExpr(e.operand)}`;
    case "paren":
      return `(${emitExpr(e.inner)})`;
    case "lit":
      // `StringLit.value` is delimiter-stripped — re-quote on emit.
      return e.lit === "string" ? JSON.stringify(e.value) : e.value;
    case "raw":
      return e.text;
  }
}
