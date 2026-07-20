import { genericShape } from "../../ir/stdlib/generics.js";
import { variantTag } from "../../ir/stdlib/unions.js";
import type { BinOp, ExprIR, LiteralKind, TypeIR } from "../../ir/types/loom-ir.js";
import { bodyTypeOf } from "../../util/expr-body-type.js";
import { intrinsicKey } from "../../util/intrinsics.js";
import { escapeTsIdent, lowerFirst, upperFirst, workflowFnCamel } from "../../util/naming.js";
import { DURATION_UNIT_MS } from "../../util/temporal.js";
import {
  type ExprTarget,
  type MarkedText,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
  renderExprWithMarks,
} from "../_expr/target.js";
import { renderTypeWith, type TypeTarget } from "../_type/target.js";

// ---------------------------------------------------------------------------
// Expression renderer for the TypeScript backend.
//
// Consumes fully-resolved Loom ExprIR — every name has a refKind / callKind
// tag, every member access has a receiver type, every collection op is
// flagged as such.  No further AST or scoping work is needed; this layer
// only deals with TypeScript-specific syntax.
//
// The 17-arm dispatch + recursion live in `../_expr/target.ts`; this file is
// the TS leaf table (`TS_TARGET`) plus the thin `renderTsExpr` entry point.
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
  /** Active variant-`match` binding aliases (variant-match.md) — maps a
   *  binding name to the text it renders as.  In TS a binding is an alias of
   *  the scrutinee, so this maps e.g. `o` → `outcome`. */
  matchBindings?: ReadonlyMap<string, string>;
  /** Read-port handle expressions to PREPEND to a `domain-service` call's
   *  arguments (domain-services.md rev. 4, Slice 1 — the `reading` tier).  A
   *  `reading` service operation takes one read-port parameter per repository
   *  it reads; the orchestrating caller (a `workflow`) supplies the matching
   *  handle here, keyed by `<service>.<op>`.  Returns `[]` (or is absent) for a
   *  PURE service call, which therefore stays byte-identical.  Only the
   *  workflow path wires this — aggregate-op render contexts leave it undefined
   *  (and the validator forbids them calling a non-pure service anyway). */
  readPortArgs?: (service: string, op: string) => string[];
  /** Text a `current-user` ref renders as, overriding the default bare
   *  `currentUser` parameter/local.  The persist-time audit-stamp helper (which
   *  has no `currentUser` in scope) passes `requireCurrentUser()` so a declared
   *  claim stamp (`createdByRole := currentUser.role`) materialises the real
   *  attribute (`requireCurrentUser().role`) rather than collapsing to the
   *  actor id. */
  principalExpr?: string;
}

const DEFAULT: TsRenderContext = { thisName: "this" };

const TS_TARGET: ExprTarget<TsRenderContext> = {
  literal: renderLiteral,
  id: (ctx) => (ctx.thisName === "this" ? "this._id" : `${ctx.thisName}.id`),
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  domainServiceCall(args, serviceRef) {
    // `Pricing.quote(cart, customer)` — the generated TS service module is an
    // exported namespace of pure functions (operation name camel-cased).
    return `${serviceRef.service}.${lowerFirst(serviceRef.op)}(${args.join(", ")})`;
  },
  lambda(param, body) {
    // Lambdas always introduce their own parameter; the body is rendered
    // with the outer `this` still pointing at the same receiver (lambdas in
    // DSL are pure expressions).
    //
    // Lambda body is now optional (block-body lambdas land for page event
    // handlers).  TS render contexts shouldn't see block bodies — those are
    // React-emitter territory — but stay total to keep the build happy.
    const p = escapeTsIdent(param);
    if (body !== undefined) return `(${p}) => ${body}`;
    return `(${p}) => { /* block-body lambda — page metamodel territory, not TS-renderable */ }`;
  },
  newPart: renderNew,
  object: (fields) => `({ ${fields.map((f) => `${f.name}: ${f.value}`).join(", ")} })`,
  unary: (op, operand) => `${op}${operand}`,
  binary: renderBinary,
  ternary: (cond, then, otherwise) => `${cond} ? ${then} : ${otherwise}`,
  convert: (value, e) => renderTsConvert(e.target, e.from, value),
  // A5 temporal: a Loom duration value is plain MILLISECONDS (a `number`) on
  // this backend, so `duration ± duration` / `duration * int` fall through
  // to native numeric operators and `datetime ± duration` becomes
  // `.getTime()` arithmetic in `renderBinary`.  Self-parenthesized: the
  // snippet lands in arbitrary expression slots.
  duration: (unit, amount) => {
    switch (unit) {
      case "days":
        return `((${amount}) * ${DURATION_UNIT_MS.days})`;
      case "hours":
        return `((${amount}) * ${DURATION_UNIT_MS.hours})`;
      case "minutes":
        return `((${amount}) * ${DURATION_UNIT_MS.minutes})`;
    }
  },
  match(arms, otherwise) {
    // Lower a match expression to a chained ternary so it can appear inside
    // `derived` bodies, view binds, and other TS-rendered expression
    // positions.  Right-fold: each arm wraps the previous tail.
    let out = otherwise ?? "undefined";
    for (const arm of [...arms].reverse()) {
      out = `(${arm.cond} ? ${arm.value} : ${out})`;
    }
    return out;
  },
  // TS has no expression-level pattern `match`, so a variant-`match` lowers to
  // an idiomatic discriminated-union conditional on the wire `type` tag
  // (z.discriminatedUnion("type") on the wire side).  Right-fold to a chained
  // ternary with the `else`/`undefined` tail; the binding is the scrutinee
  // alias (already substituted in each arm's `value` via `ctx.matchBindings`),
  // so no `const` is introduced.
  matchVariant(m) {
    // Right-fold the arms into a chained discriminated-union ternary.  With an
    // explicit `else`, that is the tail.  Without one, an exhaustive variant
    // match has no real fall-through, so the LAST arm becomes the unconditional
    // tail (its `subject.type` test would be the only remaining variant) — this
    // avoids a spurious `| undefined` widening of the result type.  A
    // non-exhaustive match is a validator warning (loom.match-non-exhaustive);
    // there is no runtime variant beyond the union, so folding the last arm as
    // the else is the idiomatic, type-correct choice.
    if (m.arms.length === 0) return m.otherwise ?? "undefined";
    const armList = [...m.arms];
    let out: string;
    let rest: typeof armList;
    if (m.otherwise !== undefined) {
      out = m.otherwise;
      rest = armList;
    } else {
      const last = armList[armList.length - 1]!;
      out = last.value;
      rest = armList.slice(0, -1);
    }
    for (const arm of [...rest].reverse()) {
      out = `(${m.subject}.type === ${JSON.stringify(arm.tag)} ? ${arm.value} : ${out})`;
    }
    return out;
  },
  // In TS the binding is an alias of the scrutinee (no real bound variable in a
  // ternary), so a match-binding ref renders as the subject text.
  bindingRefText: (_binding, subject) => subject,
  // Union-find repos return `Agg | null` (payloads.md §Union finds).
  absenceCheck: (subject) => `${subject} !== null`,
  // List literals are walker-config sugar (e.g. responsive Grid cols).  No
  // domain-expression position consumes one today; emit a TS array literal
  // so unexpected uses still compile.
  list: (elements) => `[${elements.join(", ")}]`,
};

export function renderTsExpr(e: ExprIR, ctx: TsRenderContext = DEFAULT): string {
  return renderExprWith(e, TS_TARGET, ctx);
}

/** Marks-carrying sibling of `renderTsExpr` (span-tracking-emission.md, M15
 *  phase 7 slice 2) — same TS leaf table, composed through the level-wise
 *  anchoring dispatcher instead of the plain one.  Only called from a
 *  recording path (the aggregate op-body loop, when a `SourceMapRecorder`
 *  is threaded in); never on the default flag-off path. */
export function renderTsExprWithMarks(e: ExprIR, ctx: TsRenderContext = DEFAULT): MarkedText {
  return renderExprWithMarks(e, TS_TARGET, ctx);
}

/**
 * Render an explicit conversion expression (`string(age)`,
 * `money(decimalField)`, etc.) for the TS backend.  Per-(from,
 * target) pair so each emit matches the host idiom:
 *   string(x: number|bool)    → `String(x)`
 *   string(x: Decimal)        → `x.toString()`
 *   long(x: number)           → `x`                 (no distinction)
 *   decimal(x: number)        → `x`                 (no distinction)
 *   decimal(x: Decimal)       → `x.toNumber()`     (lossy, explicit)
 *   money(x: number)          → `new Decimal(x)`
 *   money(x: Decimal)         → `x`                 (already Decimal)
 *
 * `from` may be undefined when the source's type couldn't be
 * inferred (broken upstream).  Falls back to the safe TS string-
 * coercion (`String(x)`) so the output still compiles even when
 * the validator is already reporting the inferred-type problem.
 */
function renderTsConvert(target: string, from: string | undefined, v: string): string {
  if (target === "string") {
    if (from === "money") return `${v}.toString()`;
    return `String(${v})`;
  }
  if (target === "long" || target === "decimal") {
    // TS uses `number` for both int/long/decimal — conversion is a
    // no-op unless the source is `Decimal` (money), in which case we
    // narrow with `.toNumber()` (lossy, intentional — only fires
    // when the user wrote `decimal(moneyValue)` explicitly).
    if (from === "money") return `${v}.toNumber()`;
    return v;
  }
  if (target === "money") {
    if (from === "money") return v;
    return `new Decimal(${v})`;
  }
  return v; // unrecognised target — caller has bigger problems
}

function renderLiteral(lit: LiteralKind, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "new Date()";
  if (lit === "null") return "null";
  if (lit === "money") return `new Decimal(${JSON.stringify(value)})`;
  // int, decimal, bool — value stored as source-compatible string
  return value;
}

function renderRef(e: RefExpr, ctx: TsRenderContext): string {
  const fromOutside = ctx.thisName !== "this";
  switch (e.refKind) {
    case "match-binding":
      // The narrowed variant binding of a variant-`match` arm.  TS has no
      // expression-level pattern binding, so the binding is an alias of the
      // scrutinee — render the subject text installed in `ctx.matchBindings`
      // (falls back to the bare name if the side-channel is missing).
      return ctx.matchBindings?.get(e.name) ?? e.name;
    case "let":
    case "lambda":
      // Locals introduced inside the body; escape keyword collisions so the
      // use matches the (also-escaped) binding (`let new` → `new_`).
      return escapeTsIdent(e.name);
    case "param":
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
    case "workflow-fn":
      // A bare (uncalled) reference to a workflow helper — the module-scoped name.
      return workflowFnCamel(e.wfScope!, e.name);
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      // Magic identifier for the system's user-claim shape — matches
      // the parameter / local that each per-request emitter
      // materialises (operation methods get a `currentUser: User`
      // param, workflow + view-route handlers introduce a local).  A
      // caller with no such binding (the persist-time stamp helper)
      // overrides it via `principalExpr`.
      return ctx.principalExpr ?? "currentUser";
    default:
      // `refKind === "unknown"` is intentional for some positions
      // (e2e test bodies, member-chain receivers like `Order.byId(...)`
      // where `Order` is rendered verbatim and the surrounding member
      // node carries the resolved semantics — see
      // `src/ir/lower/lower-expr.ts:606-608`).  Workflow-position
      // unknowns ARE bugs and the IR validator catches those at
      // `src/ir/validate/validate.ts:1098`.
      return e.name;
  }
}

function renderMember(recv: string, e: MemberExpr): string {
  // String length stays as `.length`; arrays expose collection ops without
  // parentheses too — `lines.count` should compile to `.length`.
  if (e.receiverType.kind === "array" && e.member === "count") return `${recv}.length`;
  // `distinct` is property-style (no parens, like `count`) so it lowers to a
  // member node — route it through the shared collection-op table.
  if (e.receiverType.kind === "array" && e.member === "distinct") {
    return TS_COLLECTION_RENDERERS.distinct!(recv, []);
  }
  return `${recv}.${e.member}`;
}

// Scalar-intrinsic snippet table (src/util/intrinsics.ts) — one arm per
// catalogue row, keyed `<receiver>.<name>`.  Exported so the intrinsic
// completeness test can pin that every catalogue row has a TS arm.
export const TS_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `${recv}.trim()`,
  "string.toUpper": (recv) => `${recv}.toUpperCase()`,
  "string.toLower": (recv) => `${recv}.toLowerCase()`,
  // 0-based clamping semantics = JS slice (see the catalogue contract).
  "string.substring": (recv, args) =>
    args.length > 1
      ? `${recv}.slice(${args[0]}, (${args[0]}) + (${args[1]}))`
      : `${recv}.slice(${args[0]})`,
  "string.startsWith": (recv, args) => `${recv}.startsWith(${args[0]})`,
  "string.endsWith": (recv, args) => `${recv}.endsWith(${args[0]})`,
  "string.contains": (recv, args) => `${recv}.includes(${args[0]})`,
  "string.replace": (recv, args) => `${recv}.replaceAll(${args[0]}, ${args[1]})`,
  "string.split": (recv, args) => `${recv}.split(${args[0]})`,
  // ---- numerics (A3) -------------------------------------------------------
  // `money` is decimal.js `Decimal` on this backend; int/long/decimal are
  // plain numbers (see the catalogue's representation note).  Loom
  // expressions are pure, so a snippet may mention `recv` more than once.
  "int.abs": (recv) => `Math.abs(${recv})`,
  "long.abs": (recv) => `Math.abs(${recv})`,
  "decimal.abs": (recv) => `Math.abs(${recv})`,
  "money.abs": (recv) => `${recv}.abs()`,
  // Truncating integer division (toward zero) — `Math.trunc` on the float quotient.
  "int.divTrunc": (recv, args) => `Math.trunc(${recv} / ${args[0]})`,
  "long.divTrunc": (recv, args) => `Math.trunc(${recv} / ${args[0]})`,
  "int.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `Math.min(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `Decimal.min(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `Math.max(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `Decimal.max(${recv}, ${args[0]})`,
  // HALF-AWAY-FROM-ZERO (catalogue contract) — `Math.round` alone rounds
  // -2.5 UP to -2, so route through sign/abs on the float path.  Self-
  // parenthesized: the snippet lands in arbitrary expression slots.
  "decimal.round": (recv, args) =>
    args.length > 0
      ? `(Math.sign(${recv}) * (Math.round(Math.abs(${recv}) * 10 ** (${args[0]})) / 10 ** (${args[0]})))`
      : `(Math.sign(${recv}) * Math.round(Math.abs(${recv})))`,
  "money.round": (recv, args) =>
    `${recv}.toDecimalPlaces(${args[0] ?? "0"}, Decimal.ROUND_HALF_UP)`,
  "decimal.floor": (recv) => `Math.floor(${recv})`,
  "decimal.ceil": (recv) => `Math.ceil(${recv})`,
  "money.floor": (recv) => `${recv}.floor()`,
  "money.ceil": (recv) => `${recv}.ceil()`,
};

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  _ctx: TsRenderContext,
): string {
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args, e);
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
    // Emit a `/pattern/.test(...)` literal when the regex source is a
    // compile-time string — keeps the generated code free of the
    // `new RegExp(...)` indirection (and useRegexLiterals warning).
    const arg0 = e.args[0];
    if (arg0?.kind === "literal" && arg0.lit === "string") {
      return `${asRegexLiteral(arg0.value)}.test(${recv})`;
    }
    return `new RegExp(${args[0]}).test(${recv})`;
  }
  if (e.receiverType.kind === "primitive") {
    const intrinsic = TS_INTRINSIC_RENDERERS[intrinsicKey(e.receiverType.name, e.member)];
    if (intrinsic) return intrinsic(recv, args);
  }
  return `${recv}.${e.member}(${args.join(", ")})`;
}

/** True iff `e.args[1]` is the boolean literal `true` — the descending flag
 *  a `sortBy(λ, true)` call carries (the only collection op with a 2nd arg). */
export function isDescendingSort(e: Extract<ExprIR, { kind: "method-call" }>): boolean {
  const flag = e.args[1];
  return flag?.kind === "literal" && flag.lit === "bool" && flag.value === "true";
}

/** Keyed renderer table — one entry per collection op.  The completeness pin
 *  (`test/generator/collection-op-completeness.test.ts`) asserts every catalogue
 *  op has a key here, so a future op is a compile-time-caught omission rather
 *  than a silent fall-through. */
export const TS_COLLECTION_RENDERERS: Record<
  string,
  (recv: string, args: string[], e?: Extract<ExprIR, { kind: "method-call" }>) => string
> = {
  count: (recv) => `${recv}.length`,
  // `sum` over MONEY (decimal.js `Decimal`) must fold with `.plus` from a
  // `new Decimal(0)` seed — a native `0 + Decimal` coerces to a string.  int/
  // long/decimal are plain `number` on this backend, so they keep the native
  // `+`/`0`-seed form.  Numeric type is the λ-body type (lambda form) or the
  // receiver's element type (no-arg `money[]` sum).
  sum: (recv, args, e) =>
    sumBodyIsMoney(e)
      ? args.length === 1
        ? `${recv}.reduce((acc, x) => acc.plus((${args[0]})(x)), new Decimal(0))`
        : `${recv}.reduce((acc, x) => acc.plus(x), new Decimal(0))`
      : args.length === 1
        ? `${recv}.reduce((acc, x) => acc + (${args[0]})(x), 0)`
        : `${recv}.reduce((acc, x) => acc + x, 0)`,
  all: (recv, args) => `${recv}.every(${args[0] ?? "() => true"})`,
  any: (recv, args) => `${recv}.some(${args[0] ?? "() => true"})`,
  // Array membership.  For value types this is JS's `.includes(value)` (===).
  // For money the elements are decimal.js `Decimal` instances, whose `===` is
  // reference identity — two value-equal Decimals never match — so a money
  // membership test dispatches to a value-equality scan (`.some(x => x.eq(v))`),
  // the same reason min/max/sum special-case money.
  contains: (recv, args, e) =>
    receiverElementIsMoney(e)
      ? `${recv}.some((__x) => __x.eq(${args[0] ?? "undefined"}))`
      : `${recv}.includes(${args[0] ?? "undefined"})`,
  where: (recv, args) => `${recv}.filter(${args[0] ?? "() => true"})`,
  first: (recv) => `${recv}[0]`,
  firstOrNull: (recv) => `(${recv}[0] ?? null)`,
  map: (recv, args) => `${recv}.map(${args[0]})`,
  sortBy: (recv, args, e) => {
    // Money keys are decimal.js `Decimal`s, whose `<`/`>` coerce via `valueOf()`
    // (a string) → LEXICOGRAPHIC order (Decimal(10) < Decimal(9)).  Compare them
    // with `.lt`/`.gt` instead, the same money special-case as min/max.
    const desc = e ? isDescendingSort(e) : false;
    const money = projectionBodyIsMoney(e);
    const cmp = money
      ? desc
        ? "kb.lt(ka) ? -1 : kb.gt(ka) ? 1 : 0"
        : "ka.lt(kb) ? -1 : ka.gt(kb) ? 1 : 0"
      : desc
        ? "kb < ka ? -1 : kb > ka ? 1 : 0"
        : "ka < kb ? -1 : ka > kb ? 1 : 0";
    return `[...${recv}].sort((__a, __b) => { const ka = (${args[0]})(__a), kb = (${args[0]})(__b); return ${cmp}; })`;
  },
  distinct: (recv) => `[...new Set(${recv})]`,
  take: (recv, args) => `${recv}.slice(0, ${args[0]})`,
  skip: (recv, args) => `${recv}.slice(${args[0]})`,
  join: (recv, args) => `${recv}.join(${args[0]})`,
  // min/max return the PROJECTED value, empty → null.  Uniform comparator-
  // reduce works for number/string/Date via `<`/`>`.  Money is decimal.js
  // `Decimal` — its `<`/`>` operators don't compare, so a money projection
  // dispatches to the `.lt`/`.gt` method form (bodyTypeOf on the lambda body).
  min: (recv, args, e) =>
    projectionBodyIsMoney(e)
      ? `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b.lt(__a) ? __b : __a)) : null)`
      : `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b < __a ? __b : __a)) : null)`,
  max: (recv, args, e) =>
    projectionBodyIsMoney(e)
      ? `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b.gt(__a) ? __b : __a)) : null)`
      : `(${recv}.length ? ${recv}.map(${args[0]}).reduce((__a, __b) => (__b > __a ? __b : __a)) : null)`,
};

/** True iff a `min`/`max` reduction's lambda body types as `money` — its
 *  projected values are decimal.js `Decimal`s, which need `.lt`/`.gt` rather
 *  than the native `<`/`>` comparators. */
function projectionBodyIsMoney(e?: Extract<ExprIR, { kind: "method-call" }>): boolean {
  const lam = e?.args[0];
  const bodyT = lam?.kind === "lambda" && lam.body ? bodyTypeOf(lam.body) : undefined;
  return bodyT?.kind === "primitive" && bodyT.name === "money";
}

/** True iff a collection op's receiver element type is `money` — its elements
 *  are decimal.js `Decimal`s, so `contains` must use value equality (`.eq`)
 *  rather than `.includes` (reference identity). */
function receiverElementIsMoney(e?: Extract<ExprIR, { kind: "method-call" }>): boolean {
  const rt = e?.receiverType;
  if (!rt) return false;
  const unwrapped = rt.kind === "optional" ? rt.inner : rt;
  const elem = unwrapped.kind === "array" ? unwrapped.element : undefined;
  return elem?.kind === "primitive" && elem.name === "money";
}

/** True iff a `sum` reduction's numeric type is `money` — the λ-body type for
 *  `sum(λ)`, the receiver's element type for a no-arg `money[]` sum.  A money
 *  sum folds decimal.js `Decimal`s (`.plus` from a `new Decimal(0)` seed); a
 *  numeric sum stays native `+`/`0`. */
function sumBodyIsMoney(e?: Extract<ExprIR, { kind: "method-call" }>): boolean {
  if (!e) return false;
  const lam = e.args[0];
  if (lam?.kind === "lambda" && lam.body) {
    const bodyT = bodyTypeOf(lam.body);
    return bodyT?.kind === "primitive" && bodyT.name === "money";
  }
  const rt = e.receiverType;
  const unwrapped = rt.kind === "optional" ? rt.inner : rt;
  const elem = unwrapped.kind === "array" ? unwrapped.element : undefined;
  return elem?.kind === "primitive" && elem.name === "money";
}

function renderCollectionOp(
  recv: string,
  name: string,
  args: string[],
  e: Extract<ExprIR, { kind: "method-call" }>,
): string {
  const render = TS_COLLECTION_RENDERERS[name];
  if (render) return render(recv, args, e);
  return `${recv}.${name}(${args.join(", ")})`;
}

function renderCall(
  args: string[],
  e: Extract<ExprIR, { kind: "call" }>,
  ctx: TsRenderContext,
): string {
  const argList = args.join(", ");
  const fromOutside = ctx.thisName !== "this";
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${e.name}(${argList})`;
    case "function":
    case "private-operation":
      return fromOutside
        ? `${ctx.thisName}.${lowerFirst(e.name)}(${argList})`
        : `this.${lowerFirst(e.name)}(${argList})`;
    case "workflow-fn":
      // A workflow's own `function` helper — a module-scoped function named by
      // its workflow (workflows share the generated file).  Call and def sites
      // both derive the name via `workflowFnCamel`.
      return `${workflowFnCamel(e.wfScope!, e.name)}(${argList})`;
    case "resource-op": {
      // A verb call on an ambient resource handle (Phase 4).  The
      // resource client module exports an async `<resource>$<verb>`
      // helper that owns the SDK mapping; the call site is uniform and
      // awaited inline so it composes in any expression position.
      const op = e.resourceOp!;
      return `(await ${op.resourceName}$${op.verb}(${argList}))`;
    }
    case "domain-service": {
      // `Pricing.quote(cart, customer)` — generated TS service namespace.  A
      // `reading`-tier service op takes read-port handle(s) AHEAD of the user
      // args; the orchestrating caller supplies them via `ctx.readPortArgs`
      // (domain-services.md rev. 4).  A PURE service has no ports → no prepend,
      // no `await` → byte-identical.  A reading op is `async` (it awaits its
      // repo reads), so its call is `(await Service.op(handle, …))` — wrapped in
      // parens so it composes in any expression position (a precondition, a
      // comparison) exactly like a `repo-read`.
      const ref = e.serviceRef!;
      const ports = ctx.readPortArgs?.(ref.service, ref.op) ?? [];
      const all = [...ports, ...args].join(", ");
      const call = `${ref.service}.${lowerFirst(ref.op)}(${all})`;
      return ports.length > 0 ? `(await ${call})` : call;
    }
    case "repo-read": {
      // A read-only repository query in a `reading` domain-service body
      // (domain-services.md rev. 4, Slice 1).  Renders against the THREADED
      // read-port handle — `lowerFirst(repo)` (`Accounts` → `accounts`), the
      // param the service declaration takes and the orchestrating workflow
      // supplies — exactly the var the workflow's own repo reads use
      // (`await accounts.byHolder(holder)`).  `await`-wrapped in parens so it
      // composes in any expression position (`(await …) == null`).  For a
      // `named` read the method is the declared find (`byHolder` / `getById`).
      // A criterion / retrieval read (`find`/`findAll`/`run`) renders against
      // the synthesized retrieval method (`run<RetrievalName>`), exactly as the
      // workflow `repo-run` does — so the criterion actually filters the query
      // instead of being dropped for the whole-table read.  A single-result
      // `find` takes the first row (`[0] ?? null`), mirroring the if-let render.
      const read = e.repoRead!;
      const handle = lowerFirst(read.repo);
      if (read.readKind !== "named" && read.retrievalName) {
        const call = `${handle}.run${upperFirst(read.retrievalName)}(${argList})`;
        return read.readKind === "find" ? `(await ${call})[0] ?? null` : `(await ${call})`;
      }
      return `(await ${handle}.${read.method}(${argList}))`;
    }
    case "action":
    // A sibling page/component action call (Proposal A Stage 1) — frontend-
    // only; never lowered into a backend domain expression.  Render as a plain
    // call so the exhaustive switch stays total.
    case "store-action":
    // A `<Store>.<action>()` call (Stage 5) — frontend-only; never reaches a
    // backend domain expression.  Plain-call fall-through keeps the switch total.
    case "free":
      return `${e.name}(${argList})`;
  }
}

function renderNew(
  fields: { name: string; value: string }[],
  e: NewExpr,
  ctx: TsRenderContext,
): string {
  // A NESTED part's enclosing parent has no id yet at construction — its FK is
  // stamped from tree position on save — so omit the construction-time parentId
  // (which would otherwise be the wrong-typed ambient `this` id).  A root-level
  // part keeps the ambient parent id (byte-identical).
  const parentRef = ctx.thisName === "this" ? "this._id" : `${ctx.thisName}.id`;
  const inits = [
    `id: Ids.new${e.partName}Id()`,
    ...(e.nested ? [] : [`parentId: ${parentRef}`]),
    ...fields.map((f) => `${f.name}: ${f.value}`),
  ];
  return `${e.partName}._create({ ${inits.join(", ")} })`;
}

function renderBinary(left: string, right: string, e: Extract<ExprIR, { kind: "binary" }>): string {
  // Money operands carry through as decimal.js `Decimal` instances —
  // their JS operators don't do precise math, so dispatch through the
  // class's method API.  Other primitives use native operators.
  if (e.leftType?.kind === "primitive" && e.leftType.name === "money") {
    return renderMoneyBinary(e.op, left, right);
  }
  // A5 temporal: datetime ± duration / datetime − datetime / duration +
  // datetime.  duration ± duration and duration * int stay native number
  // arithmetic (a duration is plain milliseconds on this backend) and fall
  // through to the default operator path below.
  if (e.op === "+" || e.op === "-") {
    const temporal = renderTemporalBinary(left, right, e);
    if (temporal !== null) return temporal;
  }
  // Equality comparisons in TS: prefer === / !==
  const opPrint = e.op === "==" ? "===" : e.op === "!=" ? "!==" : e.op;
  return `${left} ${opPrint} ${right}`;
}

/** The datetime-involving `+`/`-` arms (A5 temporal), or null to fall
 *  through to native operator rendering.  Dispatch is type-driven off the
 *  lowering's `leftType`/`resultType` stamps:
 *    datetime − datetime → duration   ⇒ `((l).getTime() - (r).getTime())`
 *    datetime ± duration → datetime   ⇒ `new Date((l).getTime() ± (r))`
 *    duration + datetime → datetime   ⇒ `new Date((r).getTime() + (l))` */
function renderTemporalBinary(
  left: string,
  right: string,
  e: Extract<ExprIR, { kind: "binary" }>,
): string | null {
  if (e.op !== "+" && e.op !== "-") return null;
  const prim = (t: TypeIR | undefined): string | null => (t?.kind === "primitive" ? t.name : null);
  const lt = prim(e.leftType);
  const rt = prim(e.resultType);
  if (lt === "datetime") {
    // datetime − datetime → milliseconds (the duration representation).
    if (e.op === "-" && rt === "duration") return `((${left}).getTime() - (${right}).getTime())`;
    if (rt === "datetime") {
      return `new Date((${left}).getTime() ${e.op} (${right}))`;
    }
    return null;
  }
  // duration + datetime (commuted form; `duration - datetime` never types).
  if (lt === "duration" && e.op === "+" && rt === "datetime") {
    return `new Date((${right}).getTime() + (${left}))`;
  }
  return null;
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

function renderMoneyBinary(op: BinOp, left: string, right: string): string {
  const method = MONEY_METHOD[op];
  if (!method) {
    // Unknown operator for money — fall through to native rendering
    // so the failure surfaces in the generated source, not silently.
    return `${left} ${op} ${right}`;
  }
  const call = `${left}.${method}(${right})`;
  return op === "!=" ? `!(${call})` : call;
}

// ---------------------------------------------------------------------------
// Type printing — used by templates as well
// ---------------------------------------------------------------------------

// Type printing leaf table — the TS arm of the shared `TypeTarget` dispatch
// (`../_type/target.ts`).  The 12-arm `TypeIR.kind` switch + recursion live
// there; this supplies only the TS-divergent leaves.
const TS_TYPE_TARGET: TypeTarget = {
  primitive(name) {
    switch (name) {
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
      case "duration":
        // A5 temporal — absolute duration as plain milliseconds.
        // Expression-only (never a field / wire type in this slice).
        return "number";
      case "json":
        return "unknown";
      case "File":
        // Passive wire-only leaf — the fixed FileRef reference object.
        return "{ url: string; key: string; contentType: string; size: number }";
    }
  },
  id: (targetName) => `Ids.${targetName}Id`,
  array: (element) => `${element}[]`,
  optional: (inner) => `${inner} | null`,
  genericInstance(t, recur) {
    // Carrier-bounded generic (`order paged`, `event envelope`) renders as
    // its monomorphized record shape, driven by the stdlib registry so the
    // domain-side type matches the wire DTO field-for-field (P3b).
    const fields = genericShape(t.ctor).fields(t.arg);
    return `{ ${fields.map((f) => `${f.name}: ${recur(f.type)}`).join("; ")} }`;
  },
  // Discriminated union (`A or B`, `T option`) → an inline TS tagged union
  // (P4b).  Each variant carries the `type` discriminator; record-ish
  // variants (entity / value object) intersect their domain type, scalars
  // wrap a `value`, and `none` is the bare unit.  The wire DTO emitters
  // (Hono routes / React api) produce the matching `z.discriminatedUnion`.
  union: (t) => `(${t.variants.map(renderUnionVariantTs).join(" | ")})`,
  none: () => `{ type: "none" }`,
};

export function renderTsType(t: TypeIR): string {
  return renderTypeWith(t, TS_TYPE_TARGET);
}

/** One TS member of a tagged union: `{ type: "Tag" } & Domain` for a record-ish
 *  variant, `{ type: "Tag"; value: T }` for a scalar, `{ type: "none" }` for
 *  the unit.  Mirrors the `unionMembers` wire shape on the domain side. */
function renderUnionVariantTs(v: TypeIR): string {
  const tag = variantTag(v);
  if (v.kind === "none") return `{ type: "none" }`;
  if (v.kind === "entity" || v.kind === "valueobject") {
    return `({ type: "${tag}" } & ${renderTsType(v)})`;
  }
  return `{ type: "${tag}"; value: ${renderTsType(v)} }`;
}

/** Convert a regex source string into a `/pattern/` literal.  Escapes the
 *  closing slash (`/` → `\/`); the value's other backslashes are part of the
 *  regex source and pass through unchanged.  Two edge cases can't sit in a
 *  `/…/` literal and fall back to the `RegExp` constructor (a plain string
 *  literal): an EMPTY pattern (bare `//` is a line comment) and a source that
 *  ends in a dangling odd backslash or contains a newline (the trailing `\`
 *  would escape our closing slash, breaking the file's parse). */
function asRegexLiteral(source: string): string {
  if (source === "") return 'new RegExp("")';
  const escaped = source.replace(/\//g, "\\/");
  const trailingBackslashes = /\\*$/.exec(escaped)?.[0].length ?? 0;
  if (/[\n\r]/.test(escaped) || trailingBackslashes % 2 === 1) {
    return `new RegExp(${JSON.stringify(source)})`;
  }
  return `/${escaped}/`;
}
