import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { BinOp, ExprIR, LiteralKind, TypeIR } from "../../ir/types/loom-ir.js";
import { intrinsicKey } from "../../util/intrinsics.js";
import { escapePythonIdent, snake, upperFirst, workflowFnSnake } from "../../util/naming.js";
import {
  type CallExpr,
  type ExprTarget,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
} from "../_expr/target.js";
import { renderTypeWith, type TypeTarget } from "../_type/target.js";

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
  /** Variant-`match` binding side-channel (variant-match.md) — maps a bound
   *  name to the scrutinee text it aliases inside an arm's value. */
  matchBindings?: ReadonlyMap<string, string>;
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
  /** Handler record-param names (M-T5.10 handler-param rewrite): a
   *  `command`/`query` request RECORD param is FLATTENED into its fields as
   *  local `def` params, so a `cmd.<field>` member access in the handler body
   *  must resolve to the flat field local (`<snake(field)>`), NOT attribute
   *  access on a `cmd` object.  Set only by the explicit-handler emitter; the
   *  aggregate / workflow render contexts leave it undefined (byte-identical). */
  recordParamNames?: ReadonlySet<string>;
  /** Read-port handle expressions to PREPEND to a `domain-service` call's
   *  arguments (domain-services.md rev. 4, Slice 1 — the `reading` tier).  A
   *  `reading` service operation takes one read-port parameter per repository
   *  it reads; the orchestrating caller (a `workflow`) supplies the matching
   *  repo handle here, keyed by `<service>.<op>`.  Returns `[]` (or is absent)
   *  for a PURE service call, which therefore stays byte-identical.  Only the
   *  workflow path wires this — aggregate-op render contexts leave it undefined
   *  (and the validator forbids them calling a non-pure service anyway). */
  readPortArgs?: (service: string, op: string) => string[];
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
    const p = escapePythonIdent(snake(param));
    if (body !== undefined) return `lambda ${p}: ${body}`;
    return `lambda ${p}: None  # block-body lambda — page metamodel territory`;
  },
  newPart: renderNew,
  // Bare object literals only appear in e2e contexts; in operation bodies
  // this branch is unreachable (the validator rejects them).
  object: (fields) => `{${fields.map((f) => `"${f.name}": ${f.value}`).join(", ")}}`,
  unary: (op, operand) => (op === "!" ? `not ${operand}` : `${op}${operand}`),
  binary: renderBinary,
  ternary: (cond, then, otherwise) => `(${then} if ${cond} else ${otherwise})`,
  convert: (value, e) => renderPyConvert(e.target, e.from, value),
  // A5 temporal: a Loom ABSOLUTE duration value is a stdlib
  // `datetime.timedelta` on this backend, so `duration ± duration` /
  // `duration * int` and `datetime ± duration` all fall through to the
  // native operators in `renderBinary`.  The emitters import the name via
  // `collectPyExprImports` (`from datetime import timedelta`).
  duration: (unit, amount) => {
    switch (unit) {
      case "days":
        return `timedelta(days=(${amount}))`;
      case "hours":
        return `timedelta(hours=(${amount}))`;
      case "minutes":
        return `timedelta(minutes=(${amount}))`;
    }
  },
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
  // Variant-`match` (variant-match.md) — Python has no expression-level
  // pattern match, so (like TS) fold to a chained conditional on the union's
  // `type` discriminator (`subject["type"] == "<tag>"`).  The binding is an
  // alias of the scrutinee dict (`bindingRefText` returns the subject), and a
  // field read off it subscripts (see renderMember).  With no `else`, an
  // exhaustive variant match folds the last arm as the tail (no spurious None).
  matchVariant(m) {
    if (m.arms.length === 0) return m.otherwise ?? "None";
    const arms = [...m.arms];
    let out: string;
    let rest: typeof arms;
    if (m.otherwise !== undefined) {
      out = m.otherwise;
      rest = arms;
    } else {
      out = arms[arms.length - 1]!.value;
      rest = arms.slice(0, -1);
    }
    for (const arm of [...rest].reverse()) {
      out = `(${arm.value} if ${m.subject}["type"] == ${JSON.stringify(arm.tag)} else ${out})`;
    }
    return out;
  },
  // No real bound variable in a conditional expression — the binding aliases
  // the scrutinee dict (the subject text).
  bindingRefText: (_binding, subject) => subject,
  // Union-find repos return `Agg | None` (payloads.md §Union finds); `is not
  // None` keeps the emit clean under ruff's default E711 gate.
  absenceCheck: (subject) => `${subject} is not None`,
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
 * import lines: `re`, `math` (→ `import math`), `decimal` (→ `from
 * decimal import Decimal`), `datetime` (→ `from datetime import UTC,
 * datetime`).
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
      if (e.receiverType.kind === "primitive") {
        const needs = PY_INTRINSIC_IMPORTS[intrinsicKey(e.receiverType.name, e.member)];
        if (needs) into.add(needs);
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
    case "duration":
      // A5 temporal — an absolute constructor renders `timedelta(...)`.
      into.add("timedelta");
      return collectPyExprImports(e.amount, into);
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
    case "let":
    case "lambda":
      // Locals introduced inside the body; escape keyword collisions so the
      // use matches the (also-escaped) binding.
      return escapePythonIdent(snake(e.name));
    case "param":
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
    case "workflow-fn":
      // Bare reference to a workflow helper — the module-scoped `def` name.
      return workflowFnSnake(e.wfScope!, e.name);
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "match-binding":
      // Variant-`match` binding (variant-match.md): Python has no
      // expression-level pattern binding, so the bound name is an alias of the
      // scrutinee dict — render the subject text installed in `ctx.matchBindings`.
      return ctx.matchBindings?.get(e.name) ?? snake(e.name);
    case "current-user":
      return "current_user";
    default:
      // `refKind === "unknown"` is intentional for some positions
      // (member-chain receivers rendered verbatim) — same contract as
      // the TS/.NET renderers.
      return e.name;
  }
}

function renderMember(recv: string, e: MemberExpr, ctx: PyRenderContext): string {
  // Handler record-param field access (M-T5.10 handler-param rewrite): a
  // `command`/`query` record param is FLATTENED into its fields as local `def`
  // params, so `cmd.<field>` resolves to the flat field local (`<snake(field)>`),
  // not attribute access on a `cmd` object (there is no such local).  Only the
  // explicit-handler emitter installs `recordParamNames`.
  if (
    ctx.recordParamNames &&
    e.receiver.kind === "ref" &&
    e.receiver.refKind === "param" &&
    ctx.recordParamNames.has(e.receiver.name)
  ) {
    return snake(e.member);
  }
  // Variant-`match` binding (variant-match.md): a union result is the tagged
  // dict `{"type": tag, **fields}` (see render-stmt's union return), so a field
  // read off the bound variant is a subscript, not an attribute.  The key is
  // the verbatim field name the value dict was built with.  `dict[str, object]`
  // subscripting yields `object`, so cast to the resolved member type to keep
  // `mypy --strict` happy.
  if (e.receiver.kind === "ref" && e.receiver.refKind === "match-binding") {
    return `cast(${renderPyType(e.memberType)}, ${recv}[${JSON.stringify(e.member)}])`;
  }
  // Collection / string sizes go through the `len` builtin.
  if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
    return `len(${recv})`;
  }
  // `distinct` is property-style (no parens, like `count`) — route the
  // member-node form through the shared collection-op table.
  if (e.receiverType.kind === "array" && e.member === "distinct") {
    return PY_COLLECTION_RENDERERS.distinct!(recv, []);
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

// Scalar-intrinsic snippet table (src/util/intrinsics.ts) — one arm per
// catalogue row, keyed `<receiver>.<name>`.  Consulted BEFORE the default
// fallthrough below: the default snake-cases the DSL member onto the
// receiver (`.trim()`), which is not a Python string method — the catalogue
// snippet owns the host spelling (`.strip()`).  Exported so the intrinsic
// completeness test can pin that every catalogue row has a Python arm.
export const PY_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `${recv}.strip()`,
  "string.toUpper": (recv) => `${recv}.upper()`,
  "string.toLower": (recv) => `${recv}.lower()`,
  // 0-based clamping semantics = JS slice (see the catalogue contract);
  // Python slicing clamps natively.  Space around the slice colon is the
  // black/ruff-format style for non-trivial slice operands.
  "string.substring": (recv, args) =>
    args.length > 1 ? `${recv}[${args[0]} : (${args[0]}) + (${args[1]})]` : `${recv}[${args[0]} :]`,
  "string.startsWith": (recv, args) => `${recv}.startswith(${args[0]})`,
  "string.endsWith": (recv, args) => `${recv}.endswith(${args[0]})`,
  // String-receiver `contains` is the intrinsic (lowering keys
  // `isCollectionOp` off the receiver type) — parenthesised so the `in`
  // expression composes in any position (`not (x in s)`).
  "string.contains": (recv, args) => `(${args[0]} in ${recv})`,
  "string.replace": (recv, args) => `${recv}.replace(${args[0]}, ${args[1]})`,
  "string.split": (recv, args) => `${recv}.split(${args[0]})`,
  // ---- numerics (A3 math batch) -------------------------------------------
  // abs/min/max are Python builtins that work uniformly across int (int/long),
  // float (decimal), and Decimal (money) receivers.
  "int.abs": (recv) => `abs(${recv})`,
  "long.abs": (recv) => `abs(${recv})`,
  "decimal.abs": (recv) => `abs(${recv})`,
  "money.abs": (recv) => `abs(${recv})`,
  "int.min": (recv, args) => `min(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `min(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `min(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `min(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `max(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `max(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `max(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `max(${recv}, ${args[0]})`,
  // `round(places?)` is HALF-AWAY-FROM-ZERO by catalogue contract — Python's
  // builtin round() is banker's (half-even), so it must NOT appear here.
  // Float path: copysign(floor(|x|·10^p + 0.5), x) / 10^p — exact half-away
  // at float precision, mypy-strict clean (floor's int is float-compatible),
  // self-parenthesised.  Needs `import math` (collectPyExprImports mirrors).
  "decimal.round": (recv, args) => {
    const p = args[0] ?? "0";
    return `(math.copysign(math.floor(abs(${recv}) * 10 ** (${p}) + 0.5), ${recv}) / 10 ** (${p}))`;
  },
  // Decimal path: quantize to 10^-places with the explicit ROUND_HALF_UP mode
  // (Decimal's own default is context-dependent half-even).  Stays Decimal.
  // Needs `from decimal import Decimal` (collectPyExprImports mirrors).
  "money.round": (recv, args) =>
    `${recv}.quantize(Decimal(1).scaleb(-(${args[0] ?? "0"})), rounding="ROUND_HALF_UP")`,
  // floor/ceil KEEP the receiver type (catalogue contract): float-wrapped on
  // the float-backed decimal (math.floor/ceil return int), to_integral_value
  // on money so the result stays Decimal.
  "decimal.floor": (recv) => `float(math.floor(${recv}))`,
  "decimal.ceil": (recv) => `float(math.ceil(${recv}))`,
  "money.floor": (recv) => `${recv}.to_integral_value(rounding="ROUND_FLOOR")`,
  "money.ceil": (recv) => `${recv}.to_integral_value(rounding="ROUND_CEILING")`,
};

// Intrinsic snippets above whose emitted Python reaches for an import —
// consulted by collectPyExprImports's method-call arm so the collector stays
// a pure mirror of the renderer.  `decimal.*` rounding rides on `math`;
// `money.round` constructs `Decimal(1)` (the receiver alone wouldn't force
// the import when no money literal appears in the expression).
const PY_INTRINSIC_IMPORTS: Record<string, "math" | "decimal"> = {
  "decimal.round": "math",
  "decimal.floor": "math",
  "decimal.ceil": "math",
  "money.round": "decimal",
};

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  _ctx: PyRenderContext,
): string {
  if (e.isCollectionOp) {
    return renderCollectionOp(recv, e.member, args, e);
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
  if (e.receiverType.kind === "primitive") {
    const intrinsic = PY_INTRINSIC_RENDERERS[intrinsicKey(e.receiverType.name, e.member)];
    if (intrinsic) return intrinsic(recv, args);
  }
  return `${recv}.${snake(e.member)}(${args.join(", ")})`;
}

/** True iff `e.args[1]` is the boolean literal `true` (a `sortBy(λ, true)`
 *  descending flag — the only collection op carrying a 2nd arg). */
function isDescendingSort(e: MethodCallExpr): boolean {
  const flag = e.args[1];
  return flag?.kind === "literal" && flag.lit === "bool" && flag.value === "true";
}

/** Keyed renderer table — one entry per collection op (see the completeness
 *  pin `test/generator/collection-op-completeness.test.ts`).  Collection
 *  lambdas arrive rendered as `lambda x: …`; comprehension shapes apply them
 *  to a hygienic loop variable via `applied`. */
export const PY_COLLECTION_RENDERERS: Record<
  string,
  (recv: string, args: string[], e?: MethodCallExpr) => string
> = {
  count: (recv) => `len(${recv})`,
  sum: (recv, args) =>
    args.length === 1 ? `sum((${args[0]})(__x) for __x in ${recv})` : `sum(${recv})`,
  all: (recv, args) => (args.length === 1 ? `all((${args[0]})(__x) for __x in ${recv})` : "True"),
  any: (recv, args) =>
    args.length === 1 ? `any((${args[0]})(__x) for __x in ${recv})` : `len(${recv}) > 0`,
  contains: (recv, args) => `${args[0] ?? "None"} in ${recv}`,
  where: (recv, args) =>
    args.length === 1 ? `[__x for __x in ${recv} if (${args[0]})(__x)]` : `list(${recv})`,
  first: (recv) => `${recv}[0]`,
  firstOrNull: (recv) => `(${recv}[0] if ${recv} else None)`,
  map: (recv, args) => `[(${args[0]})(__x) for __x in ${recv}]`,
  sortBy: (recv, args, e) =>
    e && isDescendingSort(e)
      ? `sorted(${recv}, key=${args[0]}, reverse=True)`
      : `sorted(${recv}, key=${args[0]})`,
  distinct: (recv) => `list(dict.fromkeys(${recv}))`,
  take: (recv, args) => `${recv}[:${args[0]}]`,
  skip: (recv, args) => `${recv}[${args[0]}:]`,
  join: (recv, args) => `${args[0]}.join(${recv})`,
  // min/max return the PROJECTED value, empty → None (default=None).
  min: (recv, args) => `min(((${args[0]})(__x) for __x in ${recv}), default=None)`,
  max: (recv, args) => `max(((${args[0]})(__x) for __x in ${recv}), default=None)`,
};

function renderCollectionOp(recv: string, name: string, args: string[], e: MethodCallExpr): string {
  const render = PY_COLLECTION_RENDERERS[name];
  if (render) return render(recv, args, e);
  return `${recv}.${snake(name)}(${args.join(", ")})`;
}

function renderCall(args: string[], e: CallExpr, ctx: PyRenderContext): string {
  const argList = args.join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `${e.name}(${argList})`;
    case "function":
      // Helper functions are always emitted as private methods (`def _is_draft`).
      return `${ctx.thisName}.${ctx.fnPrefix ?? "_"}${snake(e.name)}(${argList})`;
    case "workflow-fn":
      // A workflow's own `function` — a module-scoped `def`, namespaced by its
      // workflow (workflows share the generated file).  Same derivation as the
      // def site (`workflowFnSnake`).
      return `${workflowFnSnake(e.wfScope!, e.name)}(${argList})`;
    case "private-operation": {
      // Operations are emitted as PUBLIC methods (`def reserve`) unless declared
      // `private` (`def _reserve`) — so a sibling-operation self-call only gets
      // the `_` prefix when the target is actually private.
      const prefix = e.targetPrivate ? (ctx.fnPrefix ?? "_") : "";
      return `${ctx.thisName}.${prefix}${snake(e.name)}(${argList})`;
    }
    case "resource-op": {
      // Resource adapters land with the extern/auth slice (S16); the
      // call shape mirrors TS's awaited helper.
      const op = e.resourceOp!;
      return `(await ${snake(op.resourceName)}_${snake(op.verb)}(${argList}))`;
    }
    case "domain-service": {
      // `quote(cart, customer)` — the generated Python service module exports
      // bare module-level functions (snake-cased), imported by name.  A
      // `reading`-tier service op takes read-port handle(s) AHEAD of the user
      // args; the orchestrating caller supplies them via `ctx.readPortArgs`
      // (domain-services.md rev. 4, Slice 1).  A PURE service has no ports →
      // no prepend, no `await` → byte-identical.  A reading op is `async` (it
      // awaits its repo reads), so its call is `(await op(handle, …))` —
      // parenthesised so it composes in any expression position (a precondition,
      // a comparison), exactly like a `repo-read`.
      const ref = e.serviceRef!;
      const ports = ctx.readPortArgs?.(ref.service, ref.op) ?? [];
      const all = [...ports, ...args].join(", ");
      const call = `${snake(ref.op)}(${all})`;
      return ports.length > 0 ? `(await ${call})` : call;
    }
    case "repo-read": {
      // A read-only repository query in a `reading` domain-service body
      // (domain-services.md rev. 4, Slice 1).  Renders against the THREADED
      // read-port handle — `snake(repo)` (`Accounts` → `accounts`), the param
      // the service declaration takes and the orchestrating workflow supplies —
      // exactly the var the workflow's own repo reads use
      // (`await accounts.by_holder(holder)`).  `await`-wrapped in parens so it
      // composes in any expression position (`(await …) is None`).  The method
      // is the resolved repo method, snake-cased to the generated Python repo's
      // method name (`byHolder` → `by_holder`, `getById` → `get_by_id`).  A
      // criterion / retrieval read (`find`/`findAll`/`run`) renders against the
      // synthesized `run_<retrieval>` method (the same one the workflow
      // `repo-run` uses) so the criterion actually filters the query instead of
      // dropping to the whole-table `find_all`; a single-result `find` takes the
      // first row.
      const read = e.repoRead!;
      const handle = snake(read.repo);
      if (read.readKind !== "named" && read.retrievalName) {
        const call = `${handle}.run_${snake(read.retrievalName)}(${argList})`;
        return read.readKind === "find"
          ? `((lambda __r: __r[0] if __r else None)(await ${call}))`
          : `(await ${call})`;
      }
      return `(await ${handle}.${snake(read.method)}(${argList}))`;
    }
    case "action":
    // Sibling action call (Proposal A Stage 1) — frontend-only; never lowered
    // into a backend domain expression.  Plain call keeps the switch total.
    case "store-action":
    // `<Store>.<action>()` call (Stage 5) — frontend-only; plain-call fall-through.
    case "free":
      return `${snake(e.name)}(${argList})`;
  }
}

function renderNew(
  fields: { name: string; value: string }[],
  e: NewExpr,
  ctx: PyRenderContext,
): string {
  // A NESTED part's enclosing parent has no id yet at construction — its FK is
  // stamped from tree position on save — so omit the construction-time parent_id
  // (the ambient `self` id would be the wrong parent).  Root-level parts keep it.
  const parentRef = ctx.thisName === "self" ? "self._id" : `${ctx.thisName}.id`;
  const inits = [
    `id=new_${snake(e.partName)}_id()`,
    ...(e.nested ? [] : [`parent_id=${parentRef}`]),
    ...fields.map((f) => `${snake(f.name)}=${f.value}`),
  ];
  return `${e.partName}._create(${inits.join(", ")})`;
}

function renderBinary(left: string, right: string, e: Extract<ExprIR, { kind: "binary" }>): string {
  // A5 temporal — Python's datetime/timedelta overload the native
  // operators (`datetime ± timedelta`, `datetime - datetime → timedelta`,
  // timedelta algebra/scaling) directly, so no dedicated arm is needed.
  //
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

// Type printing leaf table — the Python arm of the shared `TypeTarget` dispatch
// (`../_type/target.ts`).  Python has no boxing axis, so the `mode` arg is ignored.
const PY_TYPE_TARGET: TypeTarget = {
  primitive(name) {
    switch (name) {
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
      case "duration":
        // A5 temporal — absolute duration as `datetime.timedelta`.
        // Expression-only (never a field / wire type in this slice).
        return "timedelta";
    }
  },
  id: (targetName) => `${targetName}Id`,
  array: (element) => `list[${element}]`,
  optional: (inner) => `${inner} | None`,
  // Carrier-bounded generic (`order paged`) → the generic dataclass
  // the carrier emitter defines (S12), e.g. `Paged[Order]`.
  genericInstance: (t, recur) => `${upperFirst(t.ctor)}[${recur(t.arg)}]`,
  // Discriminated union → the tagged-union alias name (S12 emits it).
  union: (t) => unionInstanceName(t.variants),
  none: () => "None",
};

export function renderPyType(t: TypeIR): string {
  return renderTypeWith(t, PY_TYPE_TARGET);
}
