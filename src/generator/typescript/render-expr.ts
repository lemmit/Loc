import type { BinOp, ExprIR, LiteralKind, TypeIR } from "../../ir/loom-ir.js";
import { lowerFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Expression renderer for the TypeScript backend.
//
// Consumes fully-resolved Loom ExprIR — every name has a refKind / callKind
// tag, every member access has a receiver type, every collection op is
// flagged as such.  No further AST or scoping work is needed; this layer
// only deals with TypeScript-specific syntax.
//
// Render context lets callers swap the implicit `this` for an external
// row variable (e.g. `r` for view bind projections).  When the context's
// `thisName` is something other than `"this"`, this-rooted refs render
// as `${thisName}.<getter>` (public getters, no underscore) — the only
// access available outside the aggregate class.  When `thisName` is
// `"this"` (the default — operation / function / invariant bodies), refs
// use the existing `this._field` private-field path.
// ---------------------------------------------------------------------------

export interface TsRenderContext {
  /** Rendered name for the implicit receiver (`this` by default). */
  thisName: string;
}

const DEFAULT: TsRenderContext = { thisName: "this" };

export function renderTsExpr(e: ExprIR, ctx: TsRenderContext = DEFAULT): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return ctx.thisName;
    case "id":
      return ctx.thisName === "this" ? "this._id" : `${ctx.thisName}.id`;
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
      //
      // Lambda body is now optional (block-body lambdas land
      // for page event handlers).  TS render contexts shouldn't see
      // block bodies — those are React-emitter territory — but stay
      // total to keep the build happy.
      if (e.body) return `(${e.param}) => ${renderTsExpr(e.body, ctx)}`;
      return `(${e.param}) => { /* block-body lambda — page metamodel territory, not TS-renderable */ }`;
    case "new":
      return renderNew(e, ctx);
    case "object":
      return `({ ${e.fields.map((f) => `${f.name}: ${renderTsExpr(f.value, ctx)}`).join(", ")} })`;
    case "paren":
      return `(${renderTsExpr(e.inner, ctx)})`;
    case "unary":
      return `${e.op}${renderTsExpr(e.operand, ctx)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right, e.leftType, ctx);
    case "ternary":
      return `${renderTsExpr(e.cond, ctx)} ? ${renderTsExpr(e.then, ctx)} : ${renderTsExpr(e.otherwise, ctx)}`;
    case "match": {
      // Lower a match expression to a chained ternary so it
      // can appear inside `derived` bodies, view binds, and other
      // TS-rendered expression positions.  Right-fold: each arm
      // wraps the previous tail.
      const arms = [...e.arms].reverse();
      const tail = e.otherwise ? renderTsExpr(e.otherwise, ctx) : "undefined";
      let out = tail;
      for (const arm of arms) {
        out = `(${renderTsExpr(arm.cond, ctx)} ? ${renderTsExpr(arm.value, ctx)} : ${out})`;
      }
      return out;
    }
  }
}

function renderLiteral(lit: LiteralKind, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date()";
  if (lit === "null") return "null";
  if (lit === "money") return `new Decimal(${JSON.stringify(value)})`;
  // int, decimal, bool — value stored as source-compatible string
  return value;
}

function renderRef(e: Extract<ExprIR, { kind: "ref" }>, ctx: TsRenderContext): string {
  const fromOutside = ctx.thisName !== "this";
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return e.name;
    case "this-prop":
      // Inside the aggregate class: read the private backing field.
      // Outside (view bind projections, e.g. row `r`): use the public
      // getter, which is just the bare name on the runtime instance.
      return fromOutside ? `${ctx.thisName}.${e.name}` : `this._${e.name}`;
    case "this-vo-prop":
      return fromOutside ? `${ctx.thisName}.${e.name}` : `this.${e.name}`;
    case "this-derived":
      return fromOutside ? `${ctx.thisName}.${e.name}` : `this.${e.name}`;
    case "helper-fn":
      return fromOutside ? `${ctx.thisName}.${lowerFirst(e.name)}` : `this.${lowerFirst(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      // Magic identifier for the system's user-claim shape — matches
      // the parameter / local that each per-request emitter
      // materialises (operation methods get a `currentUser: User`
      // param, workflow + view-route handlers introduce a local).
      return "currentUser";
    default:
      return e.name;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>, ctx: TsRenderContext): string {
  const recv = renderTsExpr(e.receiver, ctx);
  // String length stays as `.length`; arrays expose collection ops without
  // parentheses too — `lines.count` should compile to `.length`.
  if (e.receiverType.kind === "array" && e.member === "count") return `${recv}.length`;
  return `${recv}.${e.member}`;
}

function renderMethodCall(
  e: Extract<ExprIR, { kind: "method-call" }>,
  ctx: TsRenderContext,
): string {
  const recv = renderTsExpr(e.receiver, ctx);
  const args = e.args.map((a) => renderTsExpr(a, ctx));
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args);
  }
  // `string.matches(literal)` lowers as a method-call so the wire-
  // boundary single-field detector can absorb it as a `regex` pattern.
  // In domain code, render through the JS RegExp API rather than as a
  // bare `.matches(...)` (no such method on String.prototype).
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    return `new RegExp(${args[0]}).test(${recv})`;
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
    case "contains":
      // Array membership — maps to JS's `.includes(value)`.
      return `${recv}.includes(${args[0] ?? "undefined"})`;
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

function renderCall(e: Extract<ExprIR, { kind: "call" }>, ctx: TsRenderContext): string {
  const args = e.args.map((a) => renderTsExpr(a, ctx)).join(", ");
  const fromOutside = ctx.thisName !== "this";
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${e.name}(${args})`;
    case "function":
    case "private-operation":
      return fromOutside
        ? `${ctx.thisName}.${lowerFirst(e.name)}(${args})`
        : `this.${lowerFirst(e.name)}(${args})`;
    case "free":
      return `${e.name}(${args})`;
  }
}

function renderNew(e: Extract<ExprIR, { kind: "new" }>, ctx: TsRenderContext): string {
  const parentRef = ctx.thisName === "this" ? "this._id" : `${ctx.thisName}.id`;
  const inits = [
    `id: Ids.new${e.partName}Id()`,
    `parentId: ${parentRef}`,
    ...e.fields.map((f) => `${f.name}: ${renderTsExpr(f.value, ctx)}`),
  ];
  return `${e.partName}._create({ ${inits.join(", ")} })`;
}

function renderBinary(
  op: BinOp,
  left: ExprIR,
  right: ExprIR,
  leftType: TypeIR | undefined,
  ctx: TsRenderContext,
): string {
  // Money operands carry through as decimal.js `Decimal` instances —
  // their JS operators don't do precise math, so dispatch through the
  // class's method API.  Other primitives use native operators.
  if (leftType?.kind === "primitive" && leftType.name === "money") {
    return renderMoneyBinary(op, left, right, ctx);
  }
  // Equality comparisons in TS: prefer === / !==
  const opPrint = op === "==" ? "===" : op === "!=" ? "!==" : op;
  return `${renderTsExpr(left, ctx)} ${opPrint} ${renderTsExpr(right, ctx)}`;
}

const MONEY_METHOD: Record<string, string | undefined> = {
  "+": "plus",
  "-": "minus",
  "*": "times",
  "/": "div",
  "%": "mod",
  "==": "eq",
  "!=": "eq", // negated below
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
};

function renderMoneyBinary(
  op: BinOp,
  left: ExprIR,
  right: ExprIR,
  ctx: TsRenderContext,
): string {
  const method = MONEY_METHOD[op];
  if (!method) {
    // Unknown operator for money — fall through to native rendering
    // so the failure surfaces in the generated source, not silently.
    return `${renderTsExpr(left, ctx)} ${op} ${renderTsExpr(right, ctx)}`;
  }
  const call = `${renderTsExpr(left, ctx)}.${method}(${renderTsExpr(right, ctx)})`;
  return op === "!=" ? `!(${call})` : call;
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
        case "money":
          // Precise decimal — mapped to `decimal.js`'s Decimal class
          // (default-import: `import Decimal from "decimal.js"`).
          // Backwards-incompatible with the lossy `number` mapping
          // `decimal` keeps; users opt in per field.
          return "Decimal";
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
