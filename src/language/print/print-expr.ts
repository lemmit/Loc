import type { CallArg, Expression, PostfixChain, PostfixSuffix } from "../generated/ast.js";
import { isCallSuffix, isMemberSuffix } from "../generated/ast.js";

// ---------------------------------------------------------------------------
// AST → `.ddd` source printer for expressions.
//
// The Builders edit the model visually and write `.ddd` text back; this
// re-emits an expression sub-tree as source.  Because the input AST came from
// the parser, its nesting already reflects operator precedence and explicit
// `ParenExpr` nodes capture any grouping the author wrote — so flat structural
// printing re-parses to the identical tree.  The one lexer hazard is the
// `TRACE_ID` terminal (`x-1` lexes as one token), so binary operators are
// always surrounded by spaces.
//
// Statements (lambda block bodies) are printed by `print-stmt.ts`, which this
// module imports lazily through a setter to avoid an import cycle.
// ---------------------------------------------------------------------------

let printStatement: ((stmt: unknown) => string) | null = null;

/** Wired once by `print-stmt.ts` to break the expr↔stmt import cycle. */
export function registerStatementPrinter(fn: (stmt: unknown) => string): void {
  printStatement = fn;
}

export function printExpr(node: Expression): string {
  switch (node.$type) {
    case "StringLit":
      return JSON.stringify(node.value);
    case "TemplateStr": {
      // A6 — reassemble `` `seg0{hole0}seg1…` ``.  `strings` hold the
      // delimiter-stripped, unescaped segments (value converter), so re-escape
      // the template-significant chars on the way back out.
      let out = "`";
      for (let i = 0; i < node.strings.length; i++) {
        out += escapeTemplateSegment(node.strings[i] ?? "");
        const hole = node.holes[i];
        if (hole) out += `{${printExpr(hole)}}`;
      }
      return `${out}\``;
    }
    case "IntLit":
      return String(node.value);
    case "DecLit":
      return node.value;
    case "MoneyLit":
      return `money(${JSON.stringify(node.value ?? "0")})`;
    case "BoolLit":
      return node.value;
    case "NullLit":
      return "null";
    case "NowExpr":
      return "now()";
    case "ThisRef":
      return "this";
    case "IdRef":
      return "id";
    case "NameRef":
      return node.name;
    case "ParenExpr":
      return `(${printExpr(node.inner)})`;
    case "UnaryExpr":
      return `${node.op}${printExpr(node.operand)}`;
    case "AwaitExpr":
      return `await ${printExpr(node.inner)}`;
    case "BinaryChain":
      return printBinaryChain(node);
    case "TernaryExpr":
      return `${printExpr(node.cond)} ? ${printExpr(node.thenExpr)} : ${printExpr(node.elseExpr)}`;
    case "PostfixChain":
      return printPostfixChain(node);
    case "Lambda":
      return printLambda(node);
    case "BuilderCall":
      return `${node.type} {${printBuilderEntries(node.entries)}}`;
    case "ObjectLit":
      return `{${printObjectFields(node.fields)}}`;
    case "ListLit": {
      // An empty list prints as `[ ]` (spaced) — the bare `[]` token is lexed
      // as the array-type marker, so an adjacent form wouldn't re-parse.
      const elems = node.elements ?? [];
      return elems.length === 0 ? "[ ]" : `[${elems.map((e) => printExpr(e)).join(", ")}]`;
    }
    case "MatchExpr":
      return printMatch(node);
    case "RetrievalLiteral": {
      const path = (p: { segments: { name: string; collection?: boolean }[] }): string =>
        p.segments.map((s) => `${s.name}${s.collection ? "[]" : ""}`).join(".");
      const parts = [`where: ${printExpr(node.where)}`];
      if (node.sort.length > 0)
        parts.push(
          `sort: [${node.sort.map((s) => `${path(s.path)}${s.direction ? ` ${s.direction}` : ""}`).join(", ")}]`,
        );
      if (node.loads.length > 0) parts.push(`loads: [${node.loads.map(path).join(", ")}]`);
      return `retrieval { ${parts.join("  ")} }`;
    }
    case "PrimitiveConversion":
      // value is `Expression | undefined` in the generated AST (the
      // grammar's `value=Expression` doesn't force presence — a
      // parser error mid-construction yields undefined).  Render an
      // empty paren in that case; the validator will have surfaced
      // the parse error elsewhere.
      return node.value ? `${node.target}(${printExpr(node.value)})` : `${node.target}()`;
    default: {
      // Exhaustiveness guard — a new Expression node kind must be handled.
      const exhaustive: never = node;
      throw new Error(`printExpr: unhandled node ${(exhaustive as { $type: string }).$type}`);
    }
  }
}

/** Re-escape a template segment's literal text for backtick-source output —
 *  the inverse of `DddValueConverter`'s unescape.  Backtick / `{` / `}` /
 *  backslash are template-significant; control chars print as escapes for
 *  readability (they round-trip either way). */
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
      case "\t":
        return "\\t";
      default:
        return c;
    }
  });
}

function printBinaryChain(node: Extract<Expression, { $type: "BinaryChain" }>): string {
  let out = printExpr(node.head);
  for (let i = 0; i < node.ops.length; i++) {
    out = `${out} ${node.ops[i]} ${printExpr(node.rest[i]!)}`;
  }
  return out;
}

function printPostfixChain(node: PostfixChain): string {
  let out = printExpr(node.head);
  for (const s of node.suffixes) {
    out = appendSuffix(out, s);
  }
  // Trailing `ignoring` filter-bypass clause (named-filter-bypass.md §11) on an
  // inline read (`Repo.findAll(...) ignoring softDeletable` / `... ignoring *`).
  if (node.bypassAll) out += " ignoring *";
  else if (node.bypass.length > 0) out += ` ignoring ${node.bypass.join(", ")}`;
  return out;
}

function appendSuffix(base: string, s: PostfixSuffix): string {
  if (isMemberSuffix(s)) {
    const head = `${base}.${s.member}`;
    return s.call ? `${head}(${printArgs(s.args)})` : head;
  }
  if (isCallSuffix(s)) {
    return `${base}(${printArgs(s.args)})`;
  }
  return base;
}

function printArgs(args: CallArg[]): string {
  return args
    .map((a) => (a.name ? `${a.name}: ${printExpr(a.value)}` : printExpr(a.value)))
    .join(", ");
}

function printObjectFields(fields: { name: string; value: Expression }[]): string {
  if (fields.length === 0) return "";
  const inner = fields.map((f) => `${f.name}: ${printExpr(f.value)}`).join(", ");
  return ` ${inner} `;
}

function printBuilderEntries(entries: { name?: string; value: Expression }[]): string {
  if (entries.length === 0) return "";
  const inner = entries
    .map((e) => (e.name ? `${e.name}: ${printExpr(e.value)}` : printExpr(e.value)))
    .join(", ");
  return ` ${inner} `;
}

function printLambda(node: Extract<Expression, { $type: "Lambda" }>): string {
  if (node.body) return `${node.param} => ${printExpr(node.body)}`;
  if (!printStatement) {
    throw new Error("printExpr: statement printer not registered for lambda block body");
  }
  const body = node.stmts.map((s) => printStatement!(s)).join("\n");
  return node.stmts.length === 0 ? `${node.param} => {}` : `${node.param} => {\n${body}\n}`;
}

function printMatch(node: Extract<Expression, { $type: "MatchExpr" }>): string {
  // Variant form (variant-match.md): a subject present ⇒ the arms are
  // `VariantType binding => value` rows over `node.varArms`.
  if (node.subject) {
    const arms = node.varArms.map((arm) => {
      const bind = arm.binding ? ` ${arm.binding}` : "";
      return `${printTypeAtomLite(arm.varType)}${bind} => ${printExpr(arm.value)}`;
    });
    if (node.elseExpr) arms.push(`else => ${printExpr(node.elseExpr)}`);
    return `match ${printExpr(node.subject)} {\n${arms.join(",\n")}\n}`;
  }
  const arms = node.arms.map((arm) => `${printExpr(arm.cond)} => ${printExpr(arm.value)}`);
  if (node.elseExpr) arms.push(`else => ${printExpr(node.elseExpr)}`);
  // Comma-separate arms: without separators a match-arm value expression
  // greedily consumes the next arm's condition (e.g. `... + name` followed
  // by `(visibility == ...)` parses as a call), so the printed form would
  // not round-trip.  The grammar accepts an optional comma between arms.
  return `match {\n${arms.join(",\n")}\n}`;
}

/** Minimal `TypeAtom` printer for a variant-match arm's type — inlined here
 *  (rather than imported from print-structural) to avoid an import cycle.
 *  Variant atoms are named carriers / id refs / primitives plus the postfix
 *  ctor / array / optional markers, which is all a union variant may be. */
export function printTypeAtomLite(node: import("../generated/ast.js").TypeAtom): string {
  const base = node.base;
  let s: string;
  switch (base.$type) {
    case "PrimitiveType":
      s = base.name;
      break;
    case "SlotType":
      s = "slot";
      break;
    case "ActionType":
      s = "action";
      break;
    case "SelfType":
      s = "Self id";
      break;
    case "IdType":
      s = `${base.target.$refText} id`;
      break;
    case "NamedType":
      s = base.target.$refText;
      break;
    default:
      s = "";
  }
  for (const c of node.ctors ?? []) s = `${s} ${c}`;
  if (node.array) s = `${s}[]`;
  if (node.optional) s = `${s}?`;
  return s;
}
