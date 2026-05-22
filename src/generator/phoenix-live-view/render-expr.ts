import type { BinOp, ExprIR, TypeIR } from "../../ir/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Expression renderer for the Phoenix LiveView / Elixir backend.
//
// Mirrors the shape of dotnet/render-expr.ts: a single exported
// `renderExpr` function that dispatches on `expr.kind`.  Output is
// idiomatic Elixir 1.16 / Ash 3.x.
//
// `RenderCtx.thisName` names the implicit receiver for `this-prop`
// references.  In aggregate action bodies the receiver is the changeset
// struct's existing data; in calculation/validation expressions it is
// typically the record struct itself (often the underscore-prefixed
// resource variable `record`).
// ---------------------------------------------------------------------------

export interface RenderCtx {
  /** Rendered name for `this`-rooted references.  Default: `"record"`. */
  thisName: string;
  /** Module prefix for the current bounded context, e.g. `"MyApp.Sales"`. */
  contextModule: string;
}

const DEFAULT: RenderCtx = { thisName: "record", contextModule: "MyApp" };

export function renderExpr(e: ExprIR, ctx: RenderCtx = DEFAULT): string {
  switch (e.kind) {
    case "literal":
      return renderLiteral(e.lit, e.value);
    case "this":
      return ctx.thisName;
    case "id":
      return `${ctx.thisName}.id`;
    case "ref":
      return renderRef(e, ctx);
    case "member":
      return renderMember(e, ctx);
    case "method-call":
      return renderMethodCall(e, ctx);
    case "call":
      return renderCall(e, ctx);
    case "lambda":
      // Single-expression lambda: `x => expr` → `fn x -> expr end`
      // Block-body lambdas are not renderable as an inline expression.
      if (e.body) return `fn ${e.param} -> ${renderExpr(e.body, ctx)} end`;
      return `fn ${e.param} -> # block-body-lambda end`;
    case "new":
      return renderNew(e, ctx);
    case "object":
      // Bare object literals appear in e2e contexts; not expected in
      // domain expression bodies.
      return `%{${e.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ")}}`;
    case "paren":
      return `(${renderExpr(e.inner, ctx)})`;
    case "unary":
      return renderUnary(e.op, e.operand, ctx);
    case "binary":
      return renderBinary(e.op, e.left, e.right, ctx);
    case "ternary":
      // Lower to `if … do … else … end`
      return `if ${renderExpr(e.cond, ctx)}, do: ${renderExpr(e.then, ctx)}, else: ${renderExpr(e.otherwise, ctx)}`;
    case "match":
      return renderMatch(e.arms, e.otherwise, ctx);
  }
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "null") return "nil";
  if (lit === "bool") return value === "true" ? "true" : "false";
  if (lit === "now") return "DateTime.utc_now()";
  if (lit === "decimal") return value; // Elixir decimals are plain numbers
  // int
  return value;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function renderRef(e: Extract<ExprIR, { kind: "ref" }>, ctx: RenderCtx): string {
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return snake(e.name);
    case "this-prop":
    case "this-vo-prop":
    case "this-derived":
      return `${ctx.thisName}.${snake(e.name)}`;
    case "helper-fn":
      return snake(e.name);
    case "enum-value":
      // Ash enum values are atoms in Elixir.
      return `:${snake(e.name)}`;
    case "current-user":
      return "current_user";
    default:
      return snake(e.name);
  }
}

// ---------------------------------------------------------------------------
// Member access
// ---------------------------------------------------------------------------

function renderMember(e: Extract<ExprIR, { kind: "member" }>, ctx: RenderCtx): string {
  const recv = renderExpr(e.receiver, ctx);
  // Array/list length shorthand → Elixir `length(list)` or `Enum.count`
  if (e.receiverType.kind === "array" && e.member === "count") {
    return `Enum.count(${recv})`;
  }
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return `String.length(${recv})`;
  }
  return `${recv}.${snake(e.member)}`;
}

// ---------------------------------------------------------------------------
// Method calls
// ---------------------------------------------------------------------------

function renderMethodCall(e: Extract<ExprIR, { kind: "method-call" }>, ctx: RenderCtx): string {
  const recv = renderExpr(e.receiver, ctx);
  const args = e.args.map((a) => renderExpr(a, ctx));
  if (e.isCollectionOp) {
    return renderCollectionOp(recv, e.member, args, ctx);
  }
  // string.matches(pattern) → Regex.match?(~r/pattern/, recv)
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    // Strip surrounding quotes from the pattern string arg if present,
    // then embed as a sigil.
    const raw = e.args[0];
    const pat = raw?.kind === "literal" && raw.lit === "string" ? raw.value : args[0]!;
    return `Regex.match?(~r/${pat}/, ${recv})`;
  }
  return `${recv}.${snake(e.member)}(${args.join(", ")})`;
}

function renderCollectionOp(recv: string, name: string, args: string[], _ctx: RenderCtx): string {
  switch (name) {
    case "count":
      return `Enum.count(${recv})`;
    case "sum":
      return args.length === 1 ? `Enum.sum(Enum.map(${recv}, ${args[0]}))` : `Enum.sum(${recv})`;
    case "all":
      return `Enum.all?(${recv}, ${args[0] ?? "fn _ -> true end"})`;
    case "any":
      return `Enum.any?(${recv}, ${args[0] ?? "fn _ -> false end"})`;
    case "contains":
      return `Enum.member?(${recv}, ${args[0] ?? "nil"})`;
    case "where":
      return `Enum.filter(${recv}, ${args[0] ?? "fn _ -> true end"})`;
    case "first":
      return `List.first(${recv})`;
    case "firstOrNull":
      return `List.first(${recv})`;
    default:
      return `Enum.${snake(name)}(${recv}, ${args.join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function renderCall(e: Extract<ExprIR, { kind: "call" }>, ctx: RenderCtx): string {
  const args = e.args.map((a) => renderExpr(a, ctx)).join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      // Embedded Ash resource / struct constructor.
      return `%${ctx.contextModule}.${upperFirst(e.name)}{${args}}`;
    case "function":
    case "private-operation":
      return `${snake(e.name)}(${ctx.thisName}, ${args})`;
    case "free":
      return `${snake(e.name)}(${args})`;
  }
}

// ---------------------------------------------------------------------------
// New (entity part constructor)
// ---------------------------------------------------------------------------

function renderNew(e: Extract<ExprIR, { kind: "new" }>, ctx: RenderCtx): string {
  const fields = e.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ");
  return `%${ctx.contextModule}.${upperFirst(e.partName)}{${fields}}`;
}

// ---------------------------------------------------------------------------
// Unary
// ---------------------------------------------------------------------------

function renderUnary(op: "-" | "!", operand: ExprIR, ctx: RenderCtx): string {
  const inner = renderExpr(operand, ctx);
  if (op === "!") return `not ${inner}`;
  return `-${inner}`;
}

// ---------------------------------------------------------------------------
// Binary operators
// ---------------------------------------------------------------------------

// Operator mapping from IR BinOp → Elixir.
function elixirOp(op: BinOp, leftIsString: boolean): string {
  switch (op) {
    case "&&":
      return "and";
    case "||":
      return "or";
    case "==":
      return "==";
    case "!=":
      return "!=";
    case "+":
      // String concatenation uses `<>` in Elixir.
      return leftIsString ? "<>" : "+";
    case "-":
      return "-";
    case "*":
      return "*";
    case "/":
      return "/";
    case "%":
      return "rem";
    case "<":
      return "<";
    case "<=":
      return "<=";
    case ">":
      return ">";
    case ">=":
      return ">=";
  }
}

function isStringType(e: ExprIR): boolean {
  if (e.kind === "literal" && e.lit === "string") return true;
  if (e.kind === "ref" && e.type?.kind === "primitive" && e.type.name === "string") return true;
  if (e.kind === "member") {
    const mt = e.memberType;
    return mt.kind === "primitive" && mt.name === "string";
  }
  return false;
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR, ctx: RenderCtx): string {
  const l = renderExpr(left, ctx);
  const r = renderExpr(right, ctx);
  const elOp = elixirOp(op, isStringType(left));
  if (op === "%") {
    // `rem` is a function in Elixir.
    return `rem(${l}, ${r})`;
  }
  return `${l} ${elOp} ${r}`;
}

// ---------------------------------------------------------------------------
// Match → cond do … end
// ---------------------------------------------------------------------------

function renderMatch(
  arms: { cond: ExprIR; value: ExprIR }[],
  otherwise: ExprIR | undefined,
  ctx: RenderCtx,
): string {
  const clauses = arms
    .map((a) => `    ${renderExpr(a.cond, ctx)} -> ${renderExpr(a.value, ctx)}`)
    .join("\n");
  const fallthrough = otherwise ? `    true -> ${renderExpr(otherwise, ctx)}` : `    true -> nil`;
  return `cond do\n${clauses}\n${fallthrough}\n  end`;
}

// ---------------------------------------------------------------------------
// Type rendering (used by domain-emit for attribute type mapping)
// ---------------------------------------------------------------------------

export function renderAshType(t: TypeIR, contextModule: string): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
          return ":integer";
        case "long":
          return ":integer";
        case "decimal":
          return ":decimal";
        case "string":
          return ":string";
        case "bool":
          return ":boolean";
        case "datetime":
          return ":utc_datetime";
        case "guid":
          return ":uuid";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return ":uuid";
    case "enum":
      return `${contextModule}.${upperFirst(t.name)}`;
    case "valueobject":
      return `${contextModule}.${upperFirst(t.name)}`;
    case "entity":
      return `${contextModule}.${upperFirst(t.name)}`;
    case "array":
      return `{:array, ${renderAshType(t.element, contextModule)}}`;
    case "optional":
      return renderAshType(t.inner, contextModule);
  }
}
