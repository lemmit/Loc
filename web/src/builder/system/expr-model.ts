import type { BuilderEntry, CallArg, Expression, ObjectFieldInit, Statement } from "../../../../src/language/generated/ast.js";
import { printExpr } from "../../../../src/language/print/index.js";

// ---------------------------------------------------------------------------
// Editable expression tree for the structured expression editor — the shared
// recursive layer above the body/expression text surfaces.
//
// `seedExpr` decomposes a parsed Expression into an `EExpr` tree; `emitExpr`
// renders it back to `.ddd` source (mirroring `print-expr.ts`).  Structured:
// the operator tree (binary / unary / paren), literals, calls (`f(a, b)`),
// member access (`a.b`, `a.b(c)`), `match`, ternary, builder calls (`T { … }`,
// the v2 canonical form for value-object / entity-part construction), object literals,
// list literals (`[a, b]`), backtick template strings (`` `text {hole}` ``),
// `money("…")`, `now()`, primitive conversions (`string(x)`),
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

/** `PrimitiveConversion.target` — the infallible conversion vocabulary
 *  (`string(x)` / `long(x)` / `decimal(x)` / `money(x)`). */
export type ConvertTarget = "string" | "long" | "decimal" | "money";

export const CONVERT_TARGETS: ConvertTarget[] = ["string", "long", "decimal", "money"];

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
  | { kind: "list"; elements: EExpr[] }
  // Backtick template — `segments` are the N+1 literal texts (unescaped, as
  // the value converter hands them over) interleaved with the N hole
  // expressions: seg0 {hole0} seg1 {hole1} … segN.  A no-hole template is one
  // segment and no holes (the `TEMPLATE_FULL` shape).
  | { kind: "template"; segments: string[]; holes: EExpr[] }
  | { kind: "money"; amount: string }
  | { kind: "now" }
  | { kind: "convert"; target: ConvertTarget; inner: EExpr }
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
    case "ListLit":
      return { kind: "list", elements: node.elements.map(seedExpr) };
    case "TemplateStr":
      // `strings` carries N+1 delimiter-stripped, unescaped segments for N
      // holes.  A hole is now a `TemplateHole` (an expression `value` plus an
      // optional raw ICU `format` suffix, M-T1.11).  Structure a plain template
      // over the hole `value`s; a mismatched segment/hole pair (mid-edit parse
      // error) OR a formatted hole (no structured format editor yet) falls back
      // to a lossless `raw` leaf — printExpr re-emits `{value, format}` verbatim.
      return node.strings.length === node.holes.length + 1 && node.holes.every((h) => !h.format)
        ? {
            kind: "template",
            segments: [...node.strings],
            holes: node.holes.map((h) => seedExpr(h.value)),
          }
        : { kind: "raw", text: printExpr(node) };
    case "MoneyLit":
      // Mirrors printMoney's `?? "0"` fallback for a half-typed literal.
      return { kind: "money", amount: node.value ?? "0" };
    case "NowExpr":
      return { kind: "now" };
    case "PrimitiveConversion":
      // `target` / `value` are optional in the generated AST (a parse error
      // mid-construction leaves them unset) — that shape stays a raw leaf.
      return node.target && node.value
        ? { kind: "convert", target: node.target, inner: seedExpr(node.value) }
        : { kind: "raw", text: printExpr(node) };
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

// Mirrors `escapeTemplateSegment` in print-expr.ts — segments are held
// unescaped (the `TEMPLATE_*` value converter strips the delimiters and
// resolves `\.`), so the template-significant chars are re-escaped on the way
// back out.  Duplicated rather than imported: the printer keeps it private.
function escapeTemplateSegment(s: string): string {
  return s.replace(/[\\`{}\n\r\t]/g, (c) => {
    switch (c) {
      case "\\":
        return "\\\\";
      case "`":
        return "\\`";
      case "{":
        return "\\{";
      case "}":
        return "\\}";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      default:
        return "\\t";
    }
  });
}

/** Append a trailing `{hole}` to a template (a new empty segment closes it).
 *  Keeps the `segments.length === holes.length + 1` invariant. */
export function addTemplateHole(t: Extract<EExpr, { kind: "template" }>, hole: EExpr): EExpr {
  return { ...t, segments: [...t.segments, ""], holes: [...t.holes, hole] };
}

/** Drop hole `i`, splicing the literal segments that surrounded it back
 *  together so the rendered text is unchanged apart from the hole. */
export function removeTemplateHole(t: Extract<EExpr, { kind: "template" }>, i: number): EExpr {
  const segments = t.segments.slice();
  segments.splice(i, 2, `${segments[i] ?? ""}${segments[i + 1] ?? ""}`);
  return { ...t, segments, holes: t.holes.filter((_, j) => j !== i) };
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
    case "list":
      // Mirrors printExpr's ListLit arm: an empty list prints `[ ]` (spaced) —
      // the bare `[]` token lexes as the array-type marker and wouldn't re-parse.
      return e.elements.length === 0 ? "[ ]" : `[${e.elements.map(emitExpr).join(", ")}]`;
    case "template": {
      // Mirrors printExpr's TemplateStr arm: seg0 {hole0} seg1 … , re-escaped.
      let out = "`";
      for (let i = 0; i < e.segments.length; i++) {
        out += escapeTemplateSegment(e.segments[i] ?? "");
        const hole = e.holes[i];
        if (hole) out += `{${emitExpr(hole)}}`;
      }
      return `${out}\``;
    }
    case "money":
      return `money(${JSON.stringify(e.amount)})`;
    case "now":
      return "now()";
    case "convert":
      return `${e.target}(${emitExpr(e.inner)})`;
    case "raw":
      return e.text;
  }
}

/** The neutral placeholder a fresh slot starts as — `null` keeps the emitted
 *  source parseable until it is edited (the same node the argument / field
 *  "+" buttons append). */
export function blankExpr(): EExpr {
  return { kind: "lit", lit: "null", value: "null" };
}

/** Insert-menu catalogue — every expression form the editor can build from
 *  scratch, in the order the leaf "▾" menu offers them.  `make()` returns a
 *  blank node of that form whose emitted source already parses, so picking one
 *  never breaks the commit round-trip. */
export const NEW_EXPR_FORMS: { id: string; label: string; make: () => EExpr }[] = [
  { id: "raw", label: "name / reference", make: () => ({ kind: "raw", text: "value" }) },
  { id: "string", label: '"string"', make: () => ({ kind: "lit", lit: "string", value: "" }) },
  { id: "int", label: "number", make: () => ({ kind: "lit", lit: "int", value: "0" }) },
  { id: "bool", label: "true / false", make: () => ({ kind: "lit", lit: "bool", value: "true" }) },
  { id: "null", label: "null", make: blankExpr },
  { id: "template", label: "`template {…}`", make: () => ({ kind: "template", segments: ["text"], holes: [] }) },
  { id: "list", label: "[ list ]", make: () => ({ kind: "list", elements: [] }) },
  { id: "money", label: 'money("…")', make: () => ({ kind: "money", amount: "0.00" }) },
  { id: "now", label: "now()", make: () => ({ kind: "now" }) },
  { id: "convert", label: "string(…) — convert", make: () => ({ kind: "convert", target: "string", inner: blankExpr() }) },
  { id: "binary", label: "a == b", make: () => ({ kind: "binary", op: "==", left: { kind: "raw", text: "a" }, right: blankExpr() }) },
  { id: "unary", label: "!a", make: () => ({ kind: "unary", op: "!", operand: { kind: "raw", text: "a" } }) },
  { id: "paren", label: "( … )", make: () => ({ kind: "paren", inner: blankExpr() }) },
  { id: "call", label: "f(…)", make: () => ({ kind: "call", callee: { kind: "raw", text: "f" }, args: [] }) },
  { id: "member", label: "a.b", make: () => ({ kind: "member", receiver: { kind: "raw", text: "a" }, member: "b", call: false, args: [] }) },
  { id: "lambda", label: "p => …", make: () => ({ kind: "lambda", param: "p", body: blankExpr() }) },
  { id: "ternary", label: "a ? b : c", make: () => ({ kind: "ternary", cond: { kind: "lit", lit: "bool", value: "true" }, then: blankExpr(), else: blankExpr() }) },
  { id: "match", label: "match { … }", make: () => ({ kind: "match", arms: [{ cond: { kind: "lit", lit: "bool", value: "true" }, value: blankExpr() }] }) },
  { id: "builder", label: "T { … }", make: () => ({ kind: "builder", type: "Type", entries: [] }) },
  { id: "object", label: "{ field: … }", make: () => ({ kind: "object", fields: [{ name: "field", value: blankExpr() }] }) },
];
