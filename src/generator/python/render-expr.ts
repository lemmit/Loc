import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { BinOp, ExprIR, LiteralKind, TypeIR } from "../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../util/naming.js";
import {
  type CallExpr,
  type ExprTarget,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
} from "../_expr/target.js";

// ---------------------------------------------------------------------------
// Expression renderer for the Python backend.
//
// Same shape as the TS / .NET renderers — consumes fully-resolved Loom
// ExprIR; output is idiomatic Python 3.13.  The 17-arm dispatch +
// recursion live in `../_expr/target.ts`; this file is the Python leaf
// table (`PY_TARGET`) plus the thin `renderPyExpr` entry point.
//
// Naming: the DSL's lowerCamelCase folds to snake_case on every
// identifier the backend owns (fields, params, lets, methods) — the
// Python analogue of .NET's `upperFirst` pascalisation.  Class-ish
// names (enums, VOs, events, parts) keep their DSL casing.
//
// Privacy: DSL `function`s and private operations render as
// `_`-prefixed methods; public operations are bare snake_case.  Both
// `callKind`s that can appear inside a body (`function` /
// `private-operation`) target the `_`-prefixed spelling.
// ---------------------------------------------------------------------------

export interface PyRenderContext {
  /** Rendered name for the implicit receiver (`self` by default). */
  thisName: string;
  /** Render `this`-family field refs as the VERBATIM (camelCase) wire name
   *  off `thisName` — `self.commitSha` — instead of the snake_case domain
   *  spelling.  Set when rendering a predicate against a request DTO (the
   *  Pydantic `@model_validator` for cross-field invariants), whose fields
   *  keep the wire casing. */
  wireField?: boolean;
  /** Method-name prefix for `function` / `private-operation` call
   *  targets and `helper-fn` refs.  Defaults to `_` (aggregate
   *  functions are private).  Value-object emission passes `""` —
   *  VO functions are public surface, invoked across aggregate
   *  boundaries (`probability.as_fraction()`), so their internal
   *  spelling must match the public method name. */
  fnPrefix?: string;
}

const DEFAULT: PyRenderContext = { thisName: "self" };

const PY_TARGET: ExprTarget<PyRenderContext> = {
  literal: renderLiteral,
  id: (ctx) => (ctx.thisName === "self" ? "self._id" : `${ctx.thisName}.id`),
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  domainServiceCall(args, serviceRef) {
    // `quote(cart, customer)` — bare module-level function (snake-cased).
    return `${snake(serviceRef.op)}(${args.join(", ")})`;
  },
  lambda(param, body) {
    if (body !== undefined) return `lambda ${snake(param)}: ${body}`;
    return `lambda ${snake(param)}: None  # block-body lambda — page metamodel territory`;
  },
  newPart: renderNew,
  // Bare object literals only appear in e2e contexts; in operation bodies
  // this branch is unreachable (the validator rejects them).
  object: (fields) => `{${fields.map((f) => `"${f.name}": ${f.value}`).join(", ")}}`,
  unary: (op, operand) => (op === "!" ? `not ${operand}` : `${op}${operand}`),
  binary: renderBinary,
  ternary: (cond, then, otherwise) => `(${then} if ${cond} else ${otherwise})`,
  convert: (value, e) => renderPyConvert(e.target, e.from, value),
  match(arms, otherwise) {
    // Python's `match` is a statement — lower to chained conditional
    // expressions so the result composes in any expression position.
    // Same right-fold as the TS/C# renderers.
    let out = otherwise ?? "None";
    for (const arm of [...arms].reverse()) {
      out = `(${arm.value} if ${arm.cond} else ${out})`;
    }
    return out;
  },
  list: (elements) => `[${elements.join(", ")}]`,
};

export function renderPyExpr(e: ExprIR, ctx: PyRenderContext = DEFAULT): string {
  return renderExprWith(e, PY_TARGET, ctx);
}

/**
 * Imports a rendered domain expression reaches for beyond builtins.
 * Pure mirror of the renderer's triggers (the C#
 * `collectCsExprUsings` pattern): file emitters call it over the same
 * expressions they render to build their import header.  Keys are
 * import lines: `re`, `decimal` (→ `from decimal import Decimal`),
 * `datetime` (→ `from datetime import UTC, datetime`).
 */
export function collectPyExprImports(e: ExprIR, into: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case "literal":
      if (e.lit === "money") into.add("decimal");
      if (e.lit === "now") into.add("datetime");
      return into;
    case "method-call":
      if (
        e.member === "matches" &&
        e.receiverType.kind === "primitive" &&
        e.receiverType.name === "string" &&
        e.args.length === 1
      ) {
        into.add("re");
      }
      collectPyExprImports(e.receiver, into);
      for (const a of e.args) collectPyExprImports(a, into);
      return into;
    case "member":
      return collectPyExprImports(e.receiver, into);
    case "binary":
      collectPyExprImports(e.left, into);
      return collectPyExprImports(e.right, into);
    case "unary":
      return collectPyExprImports(e.operand, into);
    case "paren":
      return collectPyExprImports(e.inner, into);
    case "ternary":
      collectPyExprImports(e.cond, into);
      collectPyExprImports(e.then, into);
      return collectPyExprImports(e.otherwise, into);
    case "call":
      if (e.callKind === "value-object-ctor") {
        // VO ctor calls don't import here — the emitter resolves VO
        // imports from the type graph — but `money(...)` style converts do.
      }
      for (const a of e.args) collectPyExprImports(a, into);
      return into;
    case "convert":
      if (e.target === "money") into.add("decimal");
      collectPyExprImports(e.value, into);
      return into;
    case "lambda":
      if (e.body) collectPyExprImports(e.body, into);
      return into;
    case "new":
    case "object":
      for (const f of e.fields) collectPyExprImports(f.value, into);
      return into;
    case "match":
      for (const arm of e.arms) {
        collectPyExprImports(arm.cond, into);
        collectPyExprImports(arm.value, into);
      }
      if (e.otherwise) collectPyExprImports(e.otherwise, into);
      return into;
    default:
      // this | id | ref — leaves with no sub-expressions.
      return into;
  }
}

/**
 * Render an explicit conversion (`string(age)`, `money(x)`, …) for the
 * Python backend.  Per-(from, target) pair so each emit matches the
 * host idiom:
 *   string(x: datetime)  → `x.isoformat()`  (ISO 8601, parity with "O"/.toISOString)
 *   string(x: other)     → `str(x)`
 *   long(x)              → `int(x)`
 *   decimal(x: money)    → `float(x)`       (lossy, explicit — like TS .toNumber())
 *   decimal(x: other)    → `float(x)`
 *   money(x: money)      → `x`              (no-op)
 *   money(x: other)      → `Decimal(str(x))` (str-wrap avoids float artifacts)
 */
function renderPyConvert(target: string, from: string | undefined, v: string): string {
  if (target === "string") {
    if (from === "datetime") return `${v}.isoformat()`;
    return `str(${v})`;
  }
  if (target === "long") {
    if (from === "long") return v;
    return `int(${v})`;
  }
  if (target === "decimal") {
    if (from === "decimal") return v;
    return `float(${v})`;
  }
  if (target === "money") {
    if (from === "money") return v;
    return `Decimal(str(${v}))`;
  }
  return v;
}

function renderLiteral(lit: LiteralKind, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "datetime.now(UTC)";
  if (lit === "null") return "None";
  if (lit === "money") return `Decimal(${JSON.stringify(value)})`;
  if (lit === "bool") return value === "true" ? "True" : "False";
  // int, long, decimal — value stored as source-compatible string.
  return value;
}

function renderRef(e: RefExpr, ctx: PyRenderContext): string {
  const fromOutside = ctx.thisName !== "self";
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return snake(e.name);
    case "this-prop":
      // Wire DTO: the verbatim camelCase attribute.  Inside the aggregate
      // class: the private backing field.  Outside (row scope, e.g. view
      // binds): the public property.
      if (ctx.wireField) return `${ctx.thisName}.${e.name}`;
      return fromOutside ? `${ctx.thisName}.${snake(e.name)}` : `self._${snake(e.name)}`;
    case "this-vo-prop":
    case "this-derived":
      if (ctx.wireField) return `${ctx.thisName}.${e.name}`;
      return `${ctx.thisName}.${snake(e.name)}`;
    case "helper-fn":
      return `${ctx.thisName}.${ctx.fnPrefix ?? "_"}${snake(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      return "current_user";
    default:
      // `refKind === "unknown"` is intentional for some positions
      // (member-chain receivers rendered verbatim) — same contract as
      // the TS/.NET renderers.
      return e.name;
  }
}

function renderMember(recv: string, e: MemberExpr): string {
  // Collection / string sizes go through the `len` builtin.
  if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
    return `len(${recv})`;
  }
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return `len(${recv})`;
  }
  return `${recv}.${snake(e.member)}`;
}

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  _ctx: PyRenderContext,
): string {
  if (e.isCollectionOp) {
    return renderCollectionOp(recv, e.member, args);
  }
  // `string.matches(pattern)` → `re.search(...) is not None` (search
  // semantics match TS `.test` / C# `Regex.IsMatch`).
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    return `re.search(${args[0]}, ${recv}) is not None`;
  }
  return `${recv}.${snake(e.member)}(${args.join(", ")})`;
}

function renderCollectionOp(recv: string, name: string, args: string[]): string {
  // Collection lambdas arrive rendered as `lambda x: …`; comprehension
  // shapes apply them to a hygienic loop variable.
  const applied = (fn: string) => `(${fn})(__x) for __x in ${recv}`;
  switch (name) {
    case "count":
      return `len(${recv})`;
    case "sum":
      return args.length === 1 ? `sum(${applied(args[0]!)})` : `sum(${recv})`;
    case "all":
      return args.length === 1 ? `all(${applied(args[0]!)})` : "True";
    case "any":
      return args.length === 1 ? `any(${applied(args[0]!)})` : `len(${recv}) > 0`;
    case "contains":
      return `${args[0] ?? "None"} in ${recv}`;
    case "where":
      return args.length === 1 ? `[__x for __x in ${recv} if (${args[0]})(__x)]` : `list(${recv})`;
    case "first":
      return `${recv}[0]`;
    case "firstOrNull":
      return `(${recv}[0] if ${recv} else None)`;
    default:
      return `${recv}.${snake(name)}(${args.join(", ")})`;
  }
}

function renderCall(args: string[], e: CallExpr, ctx: PyRenderContext): string {
  const argList = args.join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `${e.name}(${argList})`;
    case "function":
    case "private-operation":
      return `${ctx.thisName}.${ctx.fnPrefix ?? "_"}${snake(e.name)}(${argList})`;
    case "resource-op": {
      // Resource adapters land with the extern/auth slice (S16); the
      // call shape mirrors TS's awaited helper.
      const op = e.resourceOp!;
      return `(await ${snake(op.resourceName)}_${snake(op.verb)}(${argList}))`;
    }
    case "domain-service": {
      // `quote(cart, customer)` — the generated Python service module
      // exports bare module-level functions (snake-cased), imported by name.
      const ref = e.serviceRef!;
      return `${snake(ref.op)}(${argList})`;
    }
    case "free":
      return `${snake(e.name)}(${argList})`;
  }
}

function renderNew(
  fields: { name: string; value: string }[],
  e: NewExpr,
  ctx: PyRenderContext,
): string {
  const parentRef = ctx.thisName === "self" ? "self._id" : `${ctx.thisName}.id`;
  const inits = [
    `id=new_${snake(e.partName)}_id()`,
    `parent_id=${parentRef}`,
    ...fields.map((f) => `${snake(f.name)}=${f.value}`),
  ];
  return `${e.partName}._create(${inits.join(", ")})`;
}

function renderBinary(left: string, right: string, e: Extract<ExprIR, { kind: "binary" }>): string {
  // Python's `Decimal` overloads the native operators precisely, so
  // money needs no method-dispatch detour (unlike decimal.js).
  return `${left} ${pyBinOp(e.op)} ${right}`;
}

function pyBinOp(op: BinOp): string {
  if (op === "&&") return "and";
  if (op === "||") return "or";
  return op;
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

export function renderPyType(t: TypeIR): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "int";
        case "decimal":
          return "float";
        case "money":
          // Precise decimal — `decimal.Decimal` (parity with decimal.js
          // on TS / `decimal` on C#).
          return "Decimal";
        case "string":
        case "guid":
          return "str";
        case "bool":
          return "bool";
        case "datetime":
          return "datetime";
        case "json":
          return "object";
      }
    case "id":
      return `${t.targetName}Id`;
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return t.name;
    case "array":
      return `list[${renderPyType(t.element)}]`;
    case "optional":
      return `${renderPyType(t.inner)} | None`;
    case "action":
    case "slot":
      throw new Error("renderPyType: 'slot' type is UI-only and should not reach the backend.");
    case "genericInstance":
      // Carrier-bounded generic (`order paged`) → the generic dataclass
      // the carrier emitter defines (S12), e.g. `Paged[Order]`.
      return `${upperFirst(t.ctor)}[${renderPyType(t.arg)}]`;
    case "union":
      // Discriminated union → the tagged-union alias name (S12 emits it).
      return unionInstanceName(t.variants);
    case "none":
      return "None";
  }
}
