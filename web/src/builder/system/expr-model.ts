import type { CallArg, Expression } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Editable expression tree for the structured expression editor — the shared
// recursive layer above the body/expression text surfaces.
//
// `seedExpr` decomposes a parsed Expression into an `EExpr` tree; `emitExpr`
// renders it back to `.ddd` source (mirroring `print-expr.ts`).  Structured:
// the operator tree (binary / unary / paren), literals, calls (`f(a, b)`) and
// member access (`a.b`, `a.b(c)`).  Everything still unmodelled (lambdas,
// `match`, `new`, ternary, object literals) is a `raw` leaf carrying its printed
// source verbatim — recognise-or-raw, exactly like the page builder.  Edits are
// validated by re-parsing the whole document at the call site, so a structural
// change or a re-typed leaf can never silently corrupt.
// ---------------------------------------------------------------------------

export type LitKind = "string" | "int" | "dec" | "bool" | "null";

export interface ECallArg {
  /** Named arg (`name: value`) or undefined for positional. */
  name?: string;
  value: EExpr;
}

export type EExpr =
  | { kind: "binary"; op: string; left: EExpr; right: EExpr }
  | { kind: "unary"; op: string; operand: EExpr }
  | { kind: "paren"; inner: EExpr }
  | { kind: "lit"; lit: LitKind; value: string }
  | { kind: "call"; callee: EExpr; args: ECallArg[] }
  | { kind: "member"; receiver: EExpr; member: string; call: boolean; args: ECallArg[] }
  | { kind: "lambda"; param: string; body: EExpr }
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
    case "CallExpr":
      return { kind: "call", callee: seedExpr(node.callee), args: node.args.map(seedArg) };
    case "MemberAccess":
      return {
        kind: "member",
        receiver: seedExpr(node.receiver),
        member: node.member,
        call: !!node.call,
        args: node.args.map(seedArg),
      };
    case "Lambda":
      // Expression-body lambdas structure (`p => expr`); block-body lambdas
      // (`p => { … }` — imperative statements) stay raw.
      return node.body ? { kind: "lambda", param: node.param, body: seedExpr(node.body) } : { kind: "raw", text: printExpr(node) };
    default:
      return { kind: "raw", text: printExpr(node) };
  }
}

function seedArg(a: CallArg): ECallArg {
  return { name: a.name || undefined, value: seedExpr(a.value) };
}

function emitArg(a: ECallArg): string {
  return a.name ? `${a.name}: ${emitExpr(a.value)}` : emitExpr(a.value);
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
    case "call":
      return `${emitExpr(e.callee)}(${e.args.map(emitArg).join(", ")})`;
    case "member": {
      const base = `${emitExpr(e.receiver)}.${e.member}`;
      return e.call ? `${base}(${e.args.map(emitArg).join(", ")})` : base;
    }
    case "lambda":
      return `${e.param} => ${emitExpr(e.body)}`;
    case "raw":
      return e.text;
  }
}
