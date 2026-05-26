import type { BuilderEntry, CallArg, Expression, ObjectFieldInit, Statement } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Editable expression tree for the structured expression editor — the shared
// recursive layer above the body/expression text surfaces.
//
// `seedExpr` decomposes a parsed Expression into an `EExpr` tree; `emitExpr`
// renders it back to `.ddd` source (mirroring `print-expr.ts`).  Structured:
// the operator tree (binary / unary / paren), literals, calls (`f(a, b)`),
// member access (`a.b`, `a.b(c)`), `match`, ternary, `new`, object literals,
// and lambdas — both expression-body (`p => expr`) and block-body
// (`p => { … }`, modelled as editable statement rows).  Everything still
// unmodelled is a `raw` leaf carrying its printed source verbatim —
// recognise-or-raw, exactly like the page builder.  Edits are validated by
// re-parsing the whole document at the call site, so a structural change or a
// re-typed leaf can never silently corrupt.
// ---------------------------------------------------------------------------

export type LitKind = "string" | "int" | "dec" | "bool" | "null";

export interface ECallArg {
  /** Named arg (`name: value`) or undefined for positional. */
  name?: string;
  value: EExpr;
}

export interface EObjField {
  name: string;
  value: EExpr;
}

export interface EMatchArm {
  cond: EExpr;
  value: EExpr;
}

// A statement inside a block-bodied lambda (`p => { … }`).  `let` and assignment
// (`target op value`) structure their value as a nested expression; every other
// statement kind (precondition / requires / emit / bare call) keeps its source
// verbatim in `src` so it round-trips untouched.
export type EStmt =
  | { kind: "let"; name: string; value: EExpr }
  | { kind: "assign"; target: string; op: string; value: EExpr }
  | { kind: "raw"; src: string };

export const ASSIGN_OPS = [":=", "+=", "-="];

export type EExpr =
  | { kind: "binary"; op: string; left: EExpr; right: EExpr }
  | { kind: "unary"; op: string; operand: EExpr }
  | { kind: "paren"; inner: EExpr }
  | { kind: "lit"; lit: LitKind; value: string }
  | { kind: "call"; callee: EExpr; args: ECallArg[] }
  | { kind: "member"; receiver: EExpr; member: string; call: boolean; args: ECallArg[] }
  | { kind: "lambda"; param: string; body: EExpr }
  | { kind: "blockLambda"; param: string; stmts: EStmt[] }
  | { kind: "ternary"; cond: EExpr; then: EExpr; else: EExpr }
  | { kind: "match"; arms: EMatchArm[]; else?: EExpr }
  | { kind: "builder"; type: string; entries: ECallArg[] }
  | { kind: "object"; fields: EObjField[] }
  | { kind: "raw"; text: string };

// BinaryExpr.op covers comparison, logical and arithmetic operators.
export const BINARY_OPS = ["==", "!=", "<", "<=", ">", ">=", "&&", "||", "+", "-", "*", "/", "%"];
export const UNARY_OPS = ["!", "-"];

export function seedExpr(node: Expression): EExpr {
  switch (node.$type) {
    case "BinaryChain":
      return seedBinaryChain(node);
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
    case "PostfixChain":
      return seedPostfixChain(node);
    case "Lambda":
      // Expression-body lambdas structure (`p => expr`); block-body lambdas
      // (`p => { … }`) seed editable statement rows.
      return node.body
        ? { kind: "lambda", param: node.param, body: seedExpr(node.body) }
        : { kind: "blockLambda", param: node.param, stmts: node.stmts.map(seedStmt) };
    case "TernaryExpr":
      return { kind: "ternary", cond: seedExpr(node.cond), then: seedExpr(node.thenExpr), else: seedExpr(node.elseExpr) };
    case "MatchExpr":
      return {
        kind: "match",
        arms: node.arms.map((a) => ({ cond: seedExpr(a.cond), value: seedExpr(a.value) })),
        else: node.elseExpr ? seedExpr(node.elseExpr) : undefined,
      };
    case "BuilderCall":
      return { kind: "builder", type: node.type, entries: node.entries.map(seedEntry) };
    case "ObjectLit":
      return { kind: "object", fields: node.fields.map(seedField) };
    default:
      return { kind: "raw", text: printExpr(node) };
  }
}

/** Left-fold a `BinaryChain` into the EExpr binary tree the editor uses.
 *  Each step of the chain becomes a binary node with the running fold as
 *  its lhs and the next rhs as its right.  Mirrors the lowering layer's
 *  left-associative semantics. */
function seedBinaryChain(node: import("../../../../src/language/generated/ast.js").BinaryChain): EExpr {
  let acc: EExpr = seedExpr(node.head);
  for (let i = 0; i < node.ops.length; i++) {
    acc = { kind: "binary", op: node.ops[i]!, left: acc, right: seedExpr(node.rest[i]!) };
  }
  return acc;
}

/** Walk a `PostfixChain` left-to-right, building the editor's nested
 *  `member` / `call` tree (matching the legacy MemberAccess / CallExpr
 *  shape the editor consumes). */
function seedPostfixChain(node: import("../../../../src/language/generated/ast.js").PostfixChain): EExpr {
  let acc: EExpr = seedExpr(node.head);
  for (const s of node.suffixes) {
    if (s.$type === "CallSuffix") {
      acc = { kind: "call", callee: acc, args: s.args.map(seedArg) };
    } else {
      // MemberSuffix
      acc = {
        kind: "member",
        receiver: acc,
        member: s.member,
        call: !!s.call,
        args: s.args.map(seedArg),
      };
    }
  }
  return acc;
}

function seedStmt(s: Statement): EStmt {
  if (s.$type === "LetStmt") return { kind: "let", name: s.name, value: seedExpr(s.expr) };
  if (s.$type === "AssignOrCallStmt" && s.op && s.value) {
    return { kind: "assign", target: s.target.$cstNode?.text?.trim() ?? "", op: s.op, value: seedExpr(s.value) };
  }
  return { kind: "raw", src: s.$cstNode?.text?.trim() ?? "" };
}

export function emitStmt(s: EStmt): string {
  if (s.kind === "let") return `let ${s.name} = ${emitExpr(s.value)}`;
  if (s.kind === "assign") return `${s.target} ${s.op} ${emitExpr(s.value)}`;
  return s.src;
}

function seedArg(a: CallArg): ECallArg {
  return { name: a.name || undefined, value: seedExpr(a.value) };
}

function emitArg(a: ECallArg): string {
  return a.name ? `${a.name}: ${emitExpr(a.value)}` : emitExpr(a.value);
}

function seedField(f: ObjectFieldInit): EObjField {
  return { name: f.name, value: seedExpr(f.value) };
}

function seedEntry(e: BuilderEntry): ECallArg {
  return { name: e.name || undefined, value: seedExpr(e.value) };
}

function emitEntries(entries: ECallArg[]): string {
  if (entries.length === 0) return "";
  return ` ${entries.map(emitArg).join(", ")} `;
}

// Matches `printObjectFields`: empty → "", else surrounded by single spaces.
function emitFields(fields: EObjField[]): string {
  if (fields.length === 0) return "";
  return ` ${fields.map((f) => `${f.name}: ${emitExpr(f.value)}`).join(", ")} `;
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
    case "blockLambda": {
      const rows = e.stmts.map(emitStmt).filter((l) => l.trim() !== "");
      return `${e.param} => {\n${rows.map((l) => `  ${l}`).join("\n")}\n}`;
    }
    case "ternary":
      return `${emitExpr(e.cond)} ? ${emitExpr(e.then)} : ${emitExpr(e.else)}`;
    case "match": {
      // Mirrors printMatch: arms newline-joined, optional `else` last.
      const arms = e.arms.map((a) => `${emitExpr(a.cond)} => ${emitExpr(a.value)}`);
      if (e.else !== undefined) arms.push(`else => ${emitExpr(e.else)}`);
      return `match {\n${arms.join("\n")}\n}`;
    }
    case "builder":
      return `${e.type} {${emitEntries(e.entries)}}`;
    case "object":
      return `{${emitFields(e.fields)}}`;
    case "raw":
      return e.text;
  }
}
