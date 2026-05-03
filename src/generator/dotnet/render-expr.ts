import type { BinOp, ExprIR, TypeIR } from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Expression renderer for the .NET / C# backend.
//
// Same shape as the TypeScript renderer — consumes fully-resolved Loom
// ExprIR.  Output is idiomatic C# 12.
// ---------------------------------------------------------------------------

export function renderCsExpr(e: ExprIR): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return "this";
    case "id":
      return "this.Id";
    case "ref":
      return renderRef(e);
    case "member":
      return renderMember(e);
    case "method-call":
      return renderMethodCall(e);
    case "call":
      return renderCall(e);
    case "lambda":
      return `${e.param} => ${renderCsExpr(e.body)}`;
    case "new":
      return renderNew(e);
    case "paren":
      return `(${renderCsExpr(e.inner)})`;
    case "unary":
      return `${e.op}${renderCsExpr(e.operand)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right);
    case "ternary":
      return `${renderCsExpr(e.cond)} ? ${renderCsExpr(e.then)} : ${renderCsExpr(e.otherwise)}`;
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "DateTime.UtcNow";
  if (lit === "null") return "null";
  if (lit === "decimal") return `${value}m`;
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>): string {
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return e.name;
    case "this-prop":
    case "this-vo-prop":
    case "this-derived":
      return `this.${pascal(e.name)}`;
    case "helper-fn":
      return `this.${pascal(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    default:
      return e.name;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>): string {
  const recv = renderCsExpr(e.receiver);
  if (e.receiverType.kind === "array" && e.member === "count") return `${recv}.Count`;
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return `${recv}.Length`;
  }
  return `${recv}.${pascal(e.member)}`;
}

function renderMethodCall(e: Extract<ExprIR, { kind: "method-call" }>): string {
  const recv = renderCsExpr(e.receiver);
  const args = e.args.map(renderCsExpr);
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args);
  }
  return `${recv}.${pascal(e.member)}(${args.join(", ")})`;
}

function renderCollectionOp(recv: string, name: string, args: string[]): string {
  switch (name) {
    case "count":
      return `${recv}.Count()`;
    case "sum":
      return args.length === 1 ? `${recv}.Sum(${args[0]})` : `${recv}.Sum()`;
    case "all":
      return `${recv}.All(${args[0] ?? "_ => true"})`;
    case "any":
      return `${recv}.Any(${args[0] ?? "_ => true"})`;
    case "where":
      return `${recv}.Where(${args[0] ?? "_ => true"}).ToList()`;
    case "first":
      return `${recv}.First()`;
    case "firstOrNull":
      return `${recv}.FirstOrDefault()`;
    default:
      return `${recv}.${pascal(name)}(${args.join(", ")})`;
  }
}

function renderCall(e: Extract<ExprIR, { kind: "call" }>): string {
  const args = e.args.map(renderCsExpr).join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${pascal(e.name)}(${args})`;
    case "function":
    case "private-operation":
      return `this.${pascal(e.name)}(${args})`;
    case "free":
      return `${pascal(e.name)}(${args})`;
  }
}

function renderNew(e: Extract<ExprIR, { kind: "new" }>): string {
  const inits = [
    `Id = ${e.partName}Id.New()`,
    `ParentId = this.Id`,
    ...e.fields.map((f) => `${pascal(f.name)} = ${renderCsExpr(f.value)}`),
  ];
  return `${e.partName}._Create(new ${e.partName}.State { ${inits.join(", ")} })`;
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR): string {
  return `${renderCsExpr(left)} ${op} ${renderCsExpr(right)}`;
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

export function renderCsType(t: TypeIR): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
          return "int";
        case "long":
          return "long";
        case "decimal":
          return "decimal";
        case "string":
          return "string";
        case "bool":
          return "bool";
        case "datetime":
          return "DateTime";
        case "guid":
          return "Guid";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return `${t.targetName}Id`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `List<${renderCsType(t.element)}>`;
    case "optional":
      return `${renderCsType(t.inner)}?`;
  }
}

export function csValueTypeForId(idValueType: string): string {
  switch (idValueType) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "string";
    default:
      return "Guid";
  }
}

export function csNewIdValue(idValueType: string): string {
  switch (idValueType) {
    case "int":
    case "long":
      return "0";
    case "string":
      return "Guid.NewGuid().ToString()";
    default:
      return "Guid.NewGuid()";
  }
}
