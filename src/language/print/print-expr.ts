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

// A scaffolded page `body:` is a deeply nested tree of `BuilderCall`/call
// arguments (widgets calling widgets) — printed flat, it collapses onto one
// illegibly long line. Past `LINE_WIDTH`, `wrapArgList` breaks the argument
// list onto its own indented, comma-joined lines (mirroring
// `print-structural.ts`'s `block`/`indent`, duplicated here rather than
// imported to avoid an import cycle with that module).
const LINE_WIDTH = 100;
const INDENT = "  ";

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => (l.length > 0 ? INDENT + l : l))
    .join("\n");
}

/** Indent EVERY line of a nested block by one level.  Exported so
 *  `print-stmt.ts` shares the one implementation — a first-line-only `"  " + …`
 *  prefix leaves a multi-line child's continuation lines and closing brace at
 *  the parent's depth, which is the bug this replaces. */
export const indentBlock = indent;

// ---------------------------------------------------------------------------
// The ambient print column.
//
// `wrapArgList` used to measure the one-line form from column 0, but its result
// is then indented — by `print-structural.ts`'s `block`, by an enclosing
// wrapped call, and again by the unfold code action's `memberIndent`.  A widget
// call that measured 95 columns therefore landed at 105 (2026-07 unfold review,
// defect 5).  Tracking the column ambiently rather than threading it through
// ~60 printer signatures keeps the call sites readable; the printers are pure
// and single-threaded, and every mutation is `finally`-restored.
//
// The budget is exact, not a guess.  A nested item is always printed at
// `currentCol + 2` — the position it occupies IF its parent wraps.  If the item
// came back multi-line the parent is forced to wrap (the `includes("\n")`
// rule), so that is where it really lands; if it came back single-line the
// parent's own check bounds the whole line.  Either way no line exceeds the
// budget.
let currentCol = 0;

/** Print `fn`'s output as if it sat `delta` columns further right. */
export function withColumn<T>(delta: number, fn: () => T): T {
  currentCol += delta;
  try {
    return fn();
  } finally {
    currentCol -= delta;
  }
}

/** Print `fn`'s output one indent level deeper — the nested-item case. */
export function withIndent<T>(fn: () => T): T {
  return withColumn(INDENT.length, fn);
}

/** Print `fn`'s output as if the whole sub-tree started at column `col`.  The
 *  entry point for a caller that splices printed text in at a known indent
 *  (the unfold code action). */
export function atColumn<T>(col: number, fn: () => T): T {
  const prev = currentCol;
  currentCol = col;
  try {
    return fn();
  } finally {
    currentCol = prev;
  }
}

/** True when `oneLine` still fits at the current print column. */
function fitsOnOneLine(oneLine: string): boolean {
  return !oneLine.includes("\n") && currentCol + oneLine.length <= LINE_WIDTH;
}

/** `<prefix><open><items, comma-joined><close>`, wrapped onto indented lines
 *  once the one-line form would exceed `LINE_WIDTH` *at the current print
 *  column* or an item already spans multiple lines (an inner call already
 *  wrapped). `<prefix><open><close>` when there are no items. Exported so
 *  `print-stmt.ts` can wrap `LValue` call args / `emit` fields the same way —
 *  the flat single-line join is the same bug for any argument list, not just
 *  expression call chains. */
export function wrapArgList(prefix: string, open: string, close: string, items: string[]): string {
  if (items.length === 0) return `${prefix}${open}${close}`;
  const oneLine = `${prefix}${open}${items.join(", ")}${close}`;
  if (fitsOnOneLine(oneLine)) return oneLine;
  return `${prefix}${open}\n${indent(items.join(",\n"))}\n${close}`;
}

/** `<prefix>{ <items, comma-joined> }`, spaced-brace form (builder calls,
 *  object literals, `emit` field lists) — wrapped onto indented lines under
 *  the same rule as `wrapArgList`. `<prefix>{}` when there are no items. */
export function wrapBraced(prefix: string, items: string[]): string {
  if (items.length === 0) return `${prefix}{}`;
  const oneLine = `${prefix}{ ${items.join(", ")} }`;
  if (fitsOnOneLine(oneLine)) return oneLine;
  return `${prefix}{\n${indent(items.join(",\n"))}\n}`;
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
      return printBuilderCall(node.type, node.entries);
    case "ObjectLit":
      return wrapBraced(
        "",
        withIndent(() => node.fields.map((f) => `${f.name}: ${printExpr(f.value)}`)),
      );
    case "ListLit": {
      // An empty list prints as `[ ]` (spaced) — the bare `[]` token is lexed
      // as the array-type marker, so an adjacent form wouldn't re-parse.
      const elems = node.elements ?? [];
      if (elems.length === 0) return "[ ]";
      return `[${withIndent(() => elems.map((e) => printExpr(e))).join(", ")}]`;
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
    return s.call ? printCall(head, s.args) : head;
  }
  if (isCallSuffix(s)) {
    return printCall(base, s.args);
  }
  return base;
}

function printCall(prefix: string, args: CallArg[]): string {
  const items = withIndent(() =>
    args.map((a) => (a.name ? `${a.name}: ${printExpr(a.value)}` : printExpr(a.value))),
  );
  return wrapArgList(prefix, "(", ")", items);
}

function printBuilderCall(type: string, entries: { name?: string; value: Expression }[]): string {
  const items = withIndent(() =>
    entries.map((e) => (e.name ? `${e.name}: ${printExpr(e.value)}` : printExpr(e.value))),
  );
  return wrapBraced(`${type} `, items);
}

function printLambda(node: Extract<Expression, { $type: "Lambda" }>): string {
  if (node.body) return `${node.param} => ${printExpr(node.body)}`;
  if (!printStatement) {
    throw new Error("printExpr: statement printer not registered for lambda block body");
  }
  if (node.stmts.length === 0) return `${node.param} => {}`;
  const body = indent(withIndent(() => node.stmts.map((s) => printStatement!(s))).join("\n"));
  return `${node.param} => {\n${body}\n}`;
}

function printMatch(node: Extract<Expression, { $type: "MatchExpr" }>): string {
  // Variant form (variant-match.md): a subject present ⇒ the arms are
  // `VariantType binding => value` rows over `node.varArms`.
  if (node.subject) {
    const arms = withIndent(() => {
      const rows = node.varArms.map((arm) => {
        const bind = arm.binding ? ` ${arm.binding}` : "";
        return `${printTypeAtomLite(arm.varType)}${bind} => ${printExpr(arm.value)}`;
      });
      if (node.elseExpr) rows.push(`else => ${printExpr(node.elseExpr)}`);
      return rows;
    });
    return `match ${printExpr(node.subject)} {\n${indent(arms.join(",\n"))}\n}`;
  }
  const arms = withIndent(() => {
    const rows = node.arms.map((arm) => `${printExpr(arm.cond)} => ${printExpr(arm.value)}`);
    if (node.elseExpr) rows.push(`else => ${printExpr(node.elseExpr)}`);
    return rows;
  });
  // Comma-separate arms: without separators a match-arm value expression
  // greedily consumes the next arm's condition (e.g. `... + name` followed
  // by `(visibility == ...)` parses as a call), so the printed form would
  // not round-trip.  The grammar accepts an optional comma between arms.
  return `match {\n${indent(arms.join(",\n"))}\n}`;
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
