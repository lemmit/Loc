import type {
  AggregateIR,
  BinOp,
  EnrichedAggregateIR,
  ExprIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import { snake, upperFirst } from "../../util/naming.js";
import {
  type BinaryExpr,
  type CallExpr,
  type ExprTarget,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
} from "../_expr/target.js";

// ---------------------------------------------------------------------------
// Expression renderer for the Phoenix LiveView / Elixir backend.
//
// Mirrors the shape of the other backends: consumes fully-resolved Loom
// ExprIR.  Output is idiomatic Elixir 1.16 / Ash 3.x.  The 17-arm dispatch +
// recursion live in `../_expr/target.ts`; this file is the Elixir leaf table
// (`ELIXIR_TARGET`) plus the thin `renderExpr` entry point.
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
  /** Aggregate whose finds/derived/op bodies we're lowering.  Required
   *  for `this.<refColl>.contains(param)` membership predicates, which
   *  lower to an Ash `exists(<rel>, id == ^arg(:<param>))` filter
   *  against the field's join entity.  When unset, contains falls back
   *  to in-memory `Enum.member?` — the validator only admits the
   *  membership form inside repository `where` clauses, so other
   *  emission contexts (derived, invariant) shouldn't reach it. */
  agg?: EnrichedAggregateIR;
  /** Resource-op routing (Phase 4c): resourceName → fully-qualified
   *  Elixir helper module (e.g. `salesFiles` → `MyApp.Resources.S3`).
   *  A `resource-op` call renders `<Module>.<resource>_<verb>(args)`.
   *  Unset outside workflow rendering — a resource-op there throws. */
  resourceModules?: Map<string, string>;
  /** When true, the expression renders inside an Ash read-action
   *  `filter expr(...)`, where a read-action argument must be referenced
   *  as `^arg(:name)` (not a bare identifier).  Set for retrieval / find
   *  `where` predicates that bind declared parameters.  Off everywhere
   *  else (op / derived / invariant bodies use plain locals). */
  filterArgs?: boolean;
}

const DEFAULT: RenderCtx = { thisName: "record", contextModule: "MyApp" };

/** Ash relationship name for a reference-collection association —
 *  always `<fieldName>_through`.  We can't reuse the field name
 *  (`:party`) because that conflicts with the calculation that
 *  re-exposes the m2m as an `{:array, :uuid}` wire field of the same
 *  name (Ash treats both as queryable references on the resource).
 *  Suffixing keeps both registrable and signals intent ("this is the
 *  m2m through-relationship for `party`").  Shared by the four
 *  emitters that need to reference the relationship name in lockstep:
 *  domain-emit (declares the m2m), render-expr (contains → `exists`
 *  lowering), render-stmt (manage_relationship), and the calculation's
 *  `expr(<rel>.id)` body. */
export function relationshipNameFor(_agg: AggregateIR, fieldName: string): string {
  return `${snake(fieldName)}_through`;
}

const ELIXIR_TARGET: ExprTarget<RenderCtx> = {
  literal: renderLiteral,
  id: (ctx) => `${ctx.thisName}.id`,
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  lambda(param, body) {
    // Single-expression lambda: `x => expr` → `fn x -> expr end`
    // Block-body lambdas are not renderable as an inline expression.
    if (body !== undefined) return `fn ${param} -> ${body} end`;
    return `fn ${param} -> # block-body-lambda end`;
  },
  newPart: renderNew,
  // Bare object literals appear in e2e contexts; not expected in domain
  // expression bodies.
  object: (fields) => `%{${fields.map((f) => `${snake(f.name)}: ${f.value}`).join(", ")}}`,
  unary: renderUnary,
  binary: renderBinary,
  // Lower to `if … do … else … end`
  ternary: (cond, then, otherwise) => `if ${cond}, do: ${then}, else: ${otherwise}`,
  convert: (value, e) => renderElixirConvert(e.target, e.from, value),
  match: renderMatch,
  // List literals are walker-config sugar (e.g. responsive Grid cols); no
  // domain-expression position consumes one today, but keep total with an
  // Elixir-list emit so unexpected uses still compile.
  list: (elements) => `[${elements.join(", ")}]`,
};

export function renderExpr(e: ExprIR, ctx: RenderCtx = DEFAULT): string {
  return renderExprWith(e, ELIXIR_TARGET, ctx);
}

/**
 * Render an explicit conversion expression for the Phoenix/Ash
 * backend.  Per-(from, target) pair, using Elixir idioms:
 *   string(x: int|long|decimal|bool) → `to_string(x)`
 *   string(x: money)                 → `Decimal.to_string(x)`
 *   long(x: int)                     → `x`           (Elixir has only
 *                                                     integer)
 *   decimal(x: int|long)             → `x`           (Loom's `decimal`
 *                                                     is a plain number
 *                                                     on Phoenix —
 *                                                     no boxing needed)
 *   decimal(x: money)                → `Decimal.to_float(x)` (lossy)
 *   money(x: int|long|decimal)       → `Decimal.new(x)`
 *   money(x: money)                  → `x`           (no-op)
 */
function renderElixirConvert(target: string, from: string | undefined, v: string): string {
  if (target === "string") {
    if (from === "money") return `Decimal.to_string(${v})`;
    return `to_string(${v})`;
  }
  if (target === "long" || target === "decimal") {
    if (from === "money") return `Decimal.to_float(${v})`;
    return v;
  }
  if (target === "money") {
    if (from === "money") return v;
    return `Decimal.new(${v})`;
  }
  return v;
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
  if (lit === "money") return `Decimal.new(${JSON.stringify(value)})`;
  // int
  return value;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function renderRef(e: RefExpr, ctx: RenderCtx): string {
  switch (e.refKind) {
    case "param":
      // Inside an Ash read-action `filter expr(...)`, a declared argument
      // is bound via `^arg(:name)`; everywhere else a param is a plain
      // local.  (`let`/`lambda` are always locals — never read-action args.)
      if (ctx.filterArgs) return `^arg(:${snake(e.name)})`;
      return snake(e.name);
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
      // `refKind === "unknown"` is intentional for some positions
      // (e2e test bodies, member-chain receivers like `Order.byId(...)`
      // where `Order` is rendered verbatim and the surrounding member
      // node carries the resolved semantics — see
      // `src/ir/lower/lower-expr.ts:606-608`).  Workflow-position
      // unknowns ARE bugs and the IR validator catches those at
      // `src/ir/validate/validate.ts:1098`.
      return snake(e.name);
  }
}

// ---------------------------------------------------------------------------
// Member access
// ---------------------------------------------------------------------------

function renderMember(recv: string, e: MemberExpr): string {
  // Array/list size shorthand.  The DSL admits both `.count` and
  // `.length` on arrays (see the .NET renderer's matching comment);
  // both map to Elixir `Enum.count/1`.  Without the `.length` arm an
  // array `.length` fell through to `<recv>.length`, a map field access
  // that raises `BadMapError` on a list at runtime (e.g. a workflow
  // guard `currentUser.permissions.length > 0` → 500 instead of 403).
  if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
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

function renderMethodCall(recv: string, args: string[], e: MethodCallExpr, ctx: RenderCtx): string {
  // `this.<refColl>.contains(x)` — membership over a reference
  // collection.  Inside an Ash `filter expr(...)` this lowers to a
  // join-table subquery via the auto-emitted many_to_many relationship:
  // `exists(<rel>, id == ^arg(:<param>))`.  Detection is structural:
  // receiverType is array<id>, receiver chains through this.<field>,
  // single arg, and ctx.agg is set (only the repository find emitter
  // threads it).  Other emission contexts fall through to the in-memory
  // `Enum.member?` shape below.
  if (
    e.member === "contains" &&
    e.receiverType.kind === "array" &&
    e.receiverType.element.kind === "id" &&
    e.args.length === 1 &&
    ctx.agg
  ) {
    const fieldName = refCollectionFieldName(e.receiver);
    if (fieldName) {
      const assoc = ctx.agg.associations.find((a) => a.fieldName === fieldName);
      if (assoc) {
        const rel = relationshipNameFor(ctx.agg, fieldName);
        // The arg is typically a `ref` to the find's named parameter;
        // Ash filter syntax binds it via `^arg(:<param>)`.  When the
        // arg renders to a bare identifier we map it through; for
        // literals / refs we trust renderExpr to produce a valid
        // Ash-expr token (Ash accepts `^var` for in-scope Elixir
        // values too).
        const argSrc = e.args[0];
        const argRendered =
          argSrc?.kind === "ref" && (argSrc.refKind === "param" || argSrc.refKind === "let")
            ? `^arg(:${snake(argSrc.name)})`
            : args[0]!;
        return `exists(${rel}, id == ${argRendered})`;
      }
    }
  }
  if (e.isCollectionOp) {
    return renderCollectionOp(recv, e.member, args);
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

function renderCollectionOp(recv: string, name: string, args: string[]): string {
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

function renderCall(args: string[], e: CallExpr, ctx: RenderCtx): string {
  switch (e.callKind) {
    case "value-object-ctor": {
      // Embedded Ash resource / struct constructor.  Elixir structs require
      // *named* fields, so use the (lowering-populated) field names rather
      // than positional args.  Falls back to positional for hand-built IR
      // that carries no names (kept total).
      const names = e.argNames;
      if (names && names.length === args.length && names.every((n) => n)) {
        const namedFields = args.map((a, i) => `${snake(names[i] as string)}: ${a}`).join(", ");
        return `%${ctx.contextModule}.${upperFirst(e.name)}{${namedFields}}`;
      }
      return `%${ctx.contextModule}.${upperFirst(e.name)}{${args.join(", ")}}`;
    }
    case "function":
    case "private-operation":
      // Receiver-prefixed call.  Skip the trailing comma when the user
      // function has no params — `passed(changeset, )` is invalid Elixir.
      return args.length > 0
        ? `${snake(e.name)}(${ctx.thisName}, ${args.join(", ")})`
        : `${snake(e.name)}(${ctx.thisName})`;
    case "free":
      return `${snake(e.name)}(${args.join(", ")})`;
    case "resource-op": {
      // Resource-op (Phase 4c) → `<Module>.<resource>_<verb>(args)`, a
      // helper function the Phoenix ResourceAdapter emits.  Routed by
      // sourceType via `ctx.resourceModules`.
      const op = e.resourceOp!;
      const mod = ctx.resourceModules?.get(op.resourceName);
      if (!mod) {
        throw new Error(
          `Resource operation '${op.resourceName}.${op.verb}' reached the Phoenix renderer without a module mapping.`,
        );
      }
      return `${mod}.${snake(op.resourceName)}_${snake(op.verb)}(${args.join(", ")})`;
    }
  }
}

// ---------------------------------------------------------------------------
// New (entity part constructor)
// ---------------------------------------------------------------------------

function renderNew(fields: { name: string; value: string }[], e: NewExpr, ctx: RenderCtx): string {
  const body = fields.map((f) => `${snake(f.name)}: ${f.value}`).join(", ");
  return `%${ctx.contextModule}.${upperFirst(e.partName)}{${body}}`;
}

// ---------------------------------------------------------------------------
// Unary
// ---------------------------------------------------------------------------

function renderUnary(op: "-" | "!", operand: string): string {
  if (op === "!") return `not ${operand}`;
  return `-${operand}`;
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
  if (e.kind === "binary") {
    // Chained string concats: the outer binary's left is an inner
    // binary whose `resultType` is string.  Inspect the IR-level
    // type rather than re-running the shape check on the inner.
    const rt = e.resultType;
    if (rt?.kind === "primitive" && rt.name === "string") return true;
  }
  if (e.kind === "convert") return e.target === "string";
  if (e.kind === "paren") return isStringType(e.inner);
  return false;
}

function renderBinary(l: string, r: string, e: BinaryExpr): string {
  // Money operands cannot use the native `+`/`*`/`>` operators in
  // Elixir — `Decimal` is a struct.  Arithmetic dispatches through
  // `Decimal.add/2` / `mult/2` / `div/2`; comparisons go through
  // `Decimal.compare/2` (returns `:lt | :eq | :gt` — three tokens,
  // not a single operator, so the result shape isn't `${l} ${op}
  // ${r}` like the primitive path).
  if (e.leftType?.kind === "primitive" && e.leftType.name === "money") {
    return renderMoneyBinary(e.op, l, r);
  }
  // Prefer the IR-level `leftType` over the AST-shape check: chained
  // string concats (`a + b + c`) carry `leftType: string` on the outer
  // binary even when the left operand is itself a binary.
  const leftIsString =
    (e.leftType?.kind === "primitive" && e.leftType.name === "string") || isStringType(e.left);
  const elOp = elixirOp(e.op, leftIsString);
  if (e.op === "%") {
    // `rem` is a function in Elixir.
    return `rem(${l}, ${r})`;
  }
  return `${l} ${elOp} ${r}`;
}

const MONEY_ARITH: Record<string, string | undefined> = {
  "+": "Decimal.add",
  "-": "Decimal.sub",
  "*": "Decimal.mult",
  "/": "Decimal.div",
};

function renderMoneyBinary(op: BinOp, l: string, r: string): string {
  const arithFn = MONEY_ARITH[op];
  if (arithFn) return `${arithFn}(${l}, ${r})`;
  if (op === "==") return `Decimal.compare(${l}, ${r}) == :eq`;
  if (op === "!=") return `Decimal.compare(${l}, ${r}) != :eq`;
  if (op === "<") return `Decimal.compare(${l}, ${r}) == :lt`;
  if (op === "<=") return `Decimal.compare(${l}, ${r}) in [:lt, :eq]`;
  if (op === ">") return `Decimal.compare(${l}, ${r}) == :gt`;
  if (op === ">=") return `Decimal.compare(${l}, ${r}) in [:gt, :eq]`;
  // Fall through for unsupported ops — surfaces in generated Elixir.
  return `${l} ${op} ${r}`;
}

// ---------------------------------------------------------------------------
// Match → cond do … end
// ---------------------------------------------------------------------------

function renderMatch(
  arms: { cond: string; value: string }[],
  otherwise: string | undefined,
): string {
  const clauses = arms.map((a) => `    ${a.cond} -> ${a.value}`).join("\n");
  const fallthrough = otherwise ? `    true -> ${otherwise}` : `    true -> nil`;
  return `cond do\n${clauses}\n${fallthrough}\n  end`;
}

// ---------------------------------------------------------------------------
// Type rendering (used by domain-emit for attribute type mapping)
// ---------------------------------------------------------------------------

export function renderAshType(t: TypeIR, contextModule: string): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
          return ":integer";
        case "long":
          return ":integer";
        case "decimal":
          return ":decimal";
        case "money":
          // Ash + Ecto :decimal is the canonical precise type;
          // Decimal serialises as string via Jason by default — matches
          // the wire-spec without extra config.  Arithmetic on these
          // values dispatches through `Decimal.add/2` in `renderBinary`.
          return ":decimal";
        case "string":
          return ":string";
        case "bool":
          return ":boolean";
        case "datetime":
          return ":utc_datetime";
        case "guid":
          return ":uuid";
        case "json":
          return ":map";
      }
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
    case "slot":
      throw new Error("renderAshType: 'slot' type is UI-only and should not reach the backend.");
    case "genericInstance":
      throw new Error(
        `renderAshType: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
  }
}
