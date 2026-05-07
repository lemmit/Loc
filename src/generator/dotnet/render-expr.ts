import type { BinOp, ExprIR, TypeIR } from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Expression renderer for the .NET / C# backend.
//
// Same shape as the TypeScript renderer — consumes fully-resolved Loom
// ExprIR.  Output is idiomatic C# 12.
//
// `renderCsExpr` accepts an optional context that controls how `this`-rooted
// references are printed.  Default emits `this.Foo`.  In LINQ predicate
// contexts (`.Where(x => …)`), pass `{ thisName: "x" }` so the same
// expression IR renders against the lambda parameter without textual
// rewrites.
// ---------------------------------------------------------------------------

export interface CsRenderContext {
  /** Rendered name for the implicit receiver (`this` by default). */
  thisName: string;
}

const DEFAULT: CsRenderContext = { thisName: "this" };

export function renderCsExpr(e: ExprIR, ctx: CsRenderContext = DEFAULT): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return ctx.thisName;
    case "id":
      return `${ctx.thisName}.Id`;
    case "ref":
      return renderRef(e, ctx);
    case "member":
      return renderMember(e, ctx);
    case "method-call":
      return renderMethodCall(e, ctx);
    case "call":
      return renderCall(e, ctx);
    case "lambda":
      // Lambdas always introduce their own parameter; the body is
      // rendered with the outer `this` still pointing at the same
      // receiver (lambdas in DSL are pure expressions).
      return `${e.param} => ${renderCsExpr(e.body, ctx)}`;
    case "new":
      return renderNew(e, ctx);
    case "object":
      // Bare object literals only appear in e2e contexts; in operation
      // bodies this branch is unreachable (the validator rejects them).
      return `new { ${e.fields.map((f) => `${pascal(f.name)} = ${renderCsExpr(f.value, ctx)}`).join(", ")} }`;
    case "paren":
      return `(${renderCsExpr(e.inner, ctx)})`;
    case "unary":
      return `${e.op}${renderCsExpr(e.operand, ctx)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right, ctx);
    case "ternary":
      return `${renderCsExpr(e.cond, ctx)} ? ${renderCsExpr(e.then, ctx)} : ${renderCsExpr(e.otherwise, ctx)}`;
  }
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "DateTime.UtcNow";
  if (lit === "null") return "null";
  if (lit === "decimal") return `${value}m`;
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>, ctx: CsRenderContext): string {
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return e.name;
    case "this-prop":
    case "this-vo-prop":
    case "this-derived":
      return `${ctx.thisName}.${pascal(e.name)}`;
    case "helper-fn":
      return `${ctx.thisName}.${pascal(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      // Magic identifier for the system's `user { ... }` shape.  The
      // emitter for each per-request context (operation, workflow,
      // view bind) materialises a local / parameter named
      // `currentUser` typed as `User`; this rendering keeps member
      // access (`currentUser.role`) idiomatic on both backends.
      return "currentUser";
    default:
      return e.name;
  }
}

function renderMember(
  e: Extract<ExprIR, { kind: "member" }>,
  ctx: CsRenderContext,
): string {
  const recv = renderCsExpr(e.receiver, ctx);
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

function renderMethodCall(
  e: Extract<ExprIR, { kind: "method-call" }>,
  ctx: CsRenderContext,
): string {
  const recv = renderCsExpr(e.receiver, ctx);
  const args = e.args.map((a) => renderCsExpr(a, ctx));
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
    case "contains":
      // Membership: maps to LINQ's `Contains(value)` overload.  The
      // single arg is the candidate value (rendered already).
      return `${recv}.Contains(${args[0] ?? "default!"})`;
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

function renderCall(
  e: Extract<ExprIR, { kind: "call" }>,
  ctx: CsRenderContext,
): string {
  const args = e.args.map((a) => renderCsExpr(a, ctx)).join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${pascal(e.name)}(${args})`;
    case "function":
    case "private-operation":
      return `${ctx.thisName}.${pascal(e.name)}(${args})`;
    case "free":
      return `${pascal(e.name)}(${args})`;
  }
}

function renderNew(
  e: Extract<ExprIR, { kind: "new" }>,
  ctx: CsRenderContext,
): string {
  const inits = [
    `Id = ${e.partName}Id.New()`,
    `ParentId = ${ctx.thisName}.Id`,
    ...e.fields.map((f) => `${pascal(f.name)} = ${renderCsExpr(f.value, ctx)}`),
  ];
  return `${e.partName}._Create(new ${e.partName}.State { ${inits.join(", ")} })`;
}

function renderBinary(
  op: BinOp,
  left: ExprIR,
  right: ExprIR,
  ctx: CsRenderContext,
): string {
  return `${renderCsExpr(left, ctx)} ${op} ${renderCsExpr(right, ctx)}`;
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
