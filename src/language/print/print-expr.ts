import type { CallArg, Expression, MemberAccess } from "../generated/ast.js";

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
    case "BinaryExpr":
      return `${printExpr(node.left)} ${node.op} ${printExpr(node.right)}`;
    case "TernaryExpr":
      return `${printExpr(node.condition)} ? ${printExpr(node.thenExpr)} : ${printExpr(node.elseExpr)}`;
    case "MemberAccess":
      return printMemberAccess(node);
    case "CallExpr":
      return `${printExpr(node.callee)}(${printArgs(node.args)})`;
    case "Lambda":
      return printLambda(node);
    case "BuilderCall":
      return `${node.type} {${printBuilderEntries(node.entries)}}`;
    case "ObjectLit":
      return `{${printObjectFields(node.fields)}}`;
    case "MatchExpr":
      return printMatch(node);
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

function printMemberAccess(node: MemberAccess): string {
  const base = `${printExpr(node.receiver)}.${node.member}`;
  return node.call ? `${base}(${printArgs(node.args)})` : base;
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
  const arms = node.arms.map((arm) => `${printExpr(arm.cond)} => ${printExpr(arm.value)}`);
  if (node.elseExpr) arms.push(`else => ${printExpr(node.elseExpr)}`);
  // Comma-separate arms: without separators a match-arm value expression
  // greedily consumes the next arm's condition (e.g. `... + name` followed
  // by `(visibility == ...)` parses as a call), so the printed form would
  // not round-trip.  The grammar accepts an optional comma between arms.
  return `match {\n${arms.join(",\n")}\n}`;
}
