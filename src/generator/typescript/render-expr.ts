import type { BinOp, ExprIR, TypeIR } from "../../ir/loom-ir.js";
import { camel } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Expression renderer for the TypeScript backend.
//
// Consumes fully-resolved Loom ExprIR — every name has a refKind / callKind
// tag, every member access has a receiver type, every collection op is
// flagged as such.  No further AST or scoping work is needed; this layer
// only deals with TypeScript-specific syntax.
// ---------------------------------------------------------------------------

export function renderTsExpr(e: ExprIR): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return "this";
    case "id":
      return "this._id";
    case "ref":
      return renderRef(e);
    case "member":
      return renderMember(e);
    case "method-call":
      return renderMethodCall(e);
    case "call":
      return renderCall(e);
    case "lambda":
      return `(${e.param}) => ${renderTsExpr(e.body)}`;
    case "new":
      return renderNew(e);
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderTsExpr(f.value)}`).join(", ")} })`;
    case "paren":
      return `(${renderTsExpr(e.inner)})`;
    case "unary":
      return `${e.op}${renderTsExpr(e.operand)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right);
    case "ternary":
      return `${renderTsExpr(e.cond)} ? ${renderTsExpr(e.then)} : ${renderTsExpr(e.otherwise)}`;
  }
}

function renderLiteral(lit: ExprIR & { kind: "literal" }["lit" extends never ? never : never] | string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date()";
  if (lit === "null") return "null";
  // int, decimal, bool — value stored as source-compatible string
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>): string {
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return e.name;
    case "this-prop":
      return `this._${e.name}`;
    case "this-vo-prop":
      return `this.${e.name}`;
    case "this-derived":
      return `this.${e.name}`;
    case "helper-fn":
      return `this.${camel(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    default:
      return e.name;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>): string {
  const recv = renderTsExpr(e.receiver);
  // String length stays as `.length`; arrays expose collection ops without
  // parentheses too — `lines.count` should compile to `.length`.
  if (e.receiverType.kind === "array" && e.member === "count") return `${recv}.length`;
  return `${recv}.${e.member}`;
}

function renderMethodCall(e: Extract<ExprIR, { kind: "method-call" }>): string {
  const recv = renderTsExpr(e.receiver);
  const args = e.args.map(renderTsExpr);
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args);
  }
  return `${recv}.${e.member}(${args.join(", ")})`;
}

function renderCollectionOp(recv: string, name: string, args: string[]): string {
  switch (name) {
    case "count":
      return `${recv}.length`;
    case "sum":
      if (args.length === 1) {
        return `${recv}.reduce((__acc, __x) => __acc + (${args[0]})(__x), 0)`;
      }
      return `${recv}.reduce((__acc, __x) => __acc + __x, 0)`;
    case "all":
      return `${recv}.every(${args[0] ?? "() => true"})`;
    case "any":
      return `${recv}.some(${args[0] ?? "() => true"})`;
    case "where":
      return `${recv}.filter(${args[0] ?? "() => true"})`;
    case "first":
      return `${recv}[0]`;
    case "firstOrNull":
      return `(${recv}[0] ?? null)`;
    default:
      return `${recv}.${name}(${args.join(", ")})`;
  }
}

function renderCall(e: Extract<ExprIR, { kind: "call" }>): string {
  const args = e.args.map(renderTsExpr).join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${e.name}(${args})`;
    case "function":
    case "private-operation":
      return `this.${camel(e.name)}(${args})`;
    case "free":
      return `${e.name}(${args})`;
  }
}

function renderNew(e: Extract<ExprIR, { kind: "new" }>): string {
  const inits = [
    `id: Ids.new${e.partName}Id()`,
    `parentId: this._id`,
    ...e.fields.map((f) => `${f.name}: ${renderTsExpr(f.value)}`),
  ];
  return `${e.partName}._create({ ${inits.join(", ")} })`;
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR): string {
  // Equality comparisons in TS: prefer === / !==
  const opPrint =
    op === "==" ? "===" : op === "!=" ? "!==" : op;
  return `${renderTsExpr(left)} ${opPrint} ${renderTsExpr(right)}`;
}

// ---------------------------------------------------------------------------
// Type printing — used by templates as well
// ---------------------------------------------------------------------------

export function renderTsType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        case "string":
        case "guid":
          return "string";
        case "bool":
          return "boolean";
        case "datetime":
          return "Date";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return `Ids.${t.targetName}Id`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `${renderTsType(t.element)}[]`;
    case "optional":
      return `${renderTsType(t.inner)} | null`;
  }
}
