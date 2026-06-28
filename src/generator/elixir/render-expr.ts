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
  type UnaryExpr,
} from "../_expr/target.js";

// ---------------------------------------------------------------------------
// Expression renderer for the Phoenix LiveView / Elixir backend.
//
// Mirrors the shape of the other backends: consumes fully-resolved Loom
// ExprIR.  Output is idiomatic Elixir 1.16.  The 17-arm dispatch +
// recursion live in `../_expr/target.ts`; this file is the Elixir leaf table
// (`ELIXIR_TARGET`) plus the thin `renderExpr` entry point.
//
// DECIMAL == MONEY here.  Elixir models BOTH `money` and `decimal` as plain
// `Decimal` structs (the schema/migration/saga layers all map both to Ecto
// `:decimal`; there is no currency library — `money` is rendered as a bare
// `Decimal`).  Every site that special-cases one must cover the other, or the
// expression renderer drifts from the storage layer: literals must wrap in
// `Decimal.new(...)`, arithmetic must dispatch through `Decimal.add/sub/mult/div`
// + `Decimal.compare`, coercions must mirror.  `isDecimalStruct` is the single
// predicate every site shares so the two can't drift again.
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
  /** Shared `<App>.Types` module — emitted once per app by the
   *  orchestrator (index.ts).  When set, `renderTypespec` lowers
   *  `id` → `<typesModule>.id()` and primitive `datetime` →
   *  `<typesModule>.timestamp()` instead of inlining `String.t()` /
   *  `DateTime.t()`.  Optional so direct expression-render unit tests
   *  (which never touch typespecs) can construct a ctx without
   *  caring; emission paths that write `@spec` lines always set it. */
  typesModule?: string;
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
  /** When true, the expression renders inside an Ecto query filter
   *  (`from ... where: ...`), where a declared parameter is pinned as
   *  `^name` and money/decimal lower via native operators/literals (NOT the
   *  Elixir `Decimal.*` struct API, which is invalid inside a query fragment).
   *  Set for retrieval / find `where` predicates that bind declared
   *  parameters.  Off everywhere else (op / derived / invariant bodies use
   *  plain locals + the in-memory `Decimal.*` API). */
  filterArgs?: boolean;
  /** Foundation the expression is rendered for.  `platform: elixir` only ever
   *  emits the vanilla foundation (plain Ecto/Phoenix), so this is always
   *  `"vanilla"`; the field is retained so the many vanilla call sites that
   *  pass `foundation: "vanilla"` keep type-checking, but it no longer
   *  selects a code path. */
  foundation?: "vanilla";
  /** Renders the aggregate-`id` expression (`{kind:"id"}`) as this bare
   *  local instead of `<thisName>.id`.  Set by the event-sourced create
   *  command runner, where the new aggregate id is a freshly generated
   *  local (`id = Ecto.UUID.generate()`) and no `this` struct exists yet.
   *  Unset everywhere else → `id` stays `<thisName>.id`. */
  idLocal?: string;
  /** When set, a provenanced `field := value` write in this body renders
   *  with inline lineage capture (the co-located backing column + the
   *  per-process trace buffer push).  Set only on the vanilla named-operation
   *  persist path — the one body that drains the buffer in its save
   *  transaction (`context-emit.ts:renderNamedOpFunction`).  Off everywhere
   *  else, so a provenanced write outside that path stays a plain struct
   *  update (no orphaned, undrained trace). */
  captureProvenance?: boolean;
  /** Per-name rewrite for `param` references.  Used by the in-process
   *  dispatch handlers (dispatch-emit.ts), where a reactor / event-create
   *  body's single bound event param (`s` in `on(s: ShipmentRequested)`)
   *  must render as the handler's `event` argument rather than a bare
   *  `s`.  A param whose name is a key here renders as the mapped value
   *  (so `s.order` → `event.order`); other refs are unaffected. */
  paramRenames?: Record<string, string>;
}

const DEFAULT: RenderCtx = { thisName: "record", contextModule: "MyApp" };

/** Both `money` and `decimal` are rendered as bare `Decimal` structs on the
 *  Elixir backend (see the header note).  This predicate is the single source
 *  of truth shared by every renderer site so the two stay in lockstep. */
const isDecimalStruct = (name: string | undefined): boolean =>
  name === "money" || name === "decimal";

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
  id: (ctx) => ctx.idLocal ?? `${ctx.thisName}.id`,
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  domainServiceCall(args, serviceRef, ctx) {
    // `Shop.Domain.Services.Pricing.quote(...)` — fully-qualified module.
    const app = ctx.contextModule.split(".")[0] ?? ctx.contextModule;
    return `${app}.Domain.Services.${upperFirst(serviceRef.service)}.${snake(serviceRef.op)}(${args.join(", ")})`;
  },
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
  unary: (op, operand, e) => renderUnary(op, operand, e),
  binary: renderBinary,
  // Lower to `if … do … else … end`
  ternary: (cond, then, otherwise) => `if ${cond}, do: ${then}, else: ${otherwise}`,
  convert: (value, e) => renderElixirConvert(e.target, e.from, value),
  match: renderMatch,
  // Variant-`match` (variant-match.md) — TODO(fan-out): render `case subject do
  // %Order{} = o -> <value> end` with a REAL binding (`bindingRefText` returns
  // the binding name).
  matchVariant() {
    throw new Error("variant-match: Elixir backend not yet implemented (variant-match.md fan-out)");
  },
  bindingRefText: (binding) => binding,
  // List literals are walker-config sugar (e.g. responsive Grid cols); no
  // domain-expression position consumes one today, but keep total with an
  // Elixir-list emit so unexpected uses still compile.
  list: (elements) => `[${elements.join(", ")}]`,
};

// Query-filter rendering target — for predicates rendered inside an Ecto
// `from ... where: ...` fragment (`filterArgs: true`).  Inside a query fragment
// a money/decimal value is NOT an Elixir `Decimal` struct: the operators (`>` /
// `+`) and bare numerals lower straight to the Postgres `numeric` column, so
// the `Decimal.add` / `Decimal.compare` / `Decimal.new` struct forms the native
// op-body path emits are invalid there.  This target overrides exactly the
// three decimal-sensitive leaves to emit the native operator / bare literal;
// everything else is shared with ELIXIR_TARGET.
const ELIXIR_FILTER_TARGET: ExprTarget<RenderCtx> = {
  ...ELIXIR_TARGET,
  literal: (lit, value) => renderLiteral(lit, value, /* inFilter */ true),
  unary: (op, operand, e) => renderUnary(op, operand, e, /* inFilter */ true),
  binary: (l, r, e) => renderBinary(l, r, e, /* inFilter */ true),
  convert: (value, e) => renderElixirConvert(e.target, e.from, value, /* inFilter */ true),
};

export function renderExpr(e: ExprIR, ctx: RenderCtx = DEFAULT): string {
  // `filterArgs` renders inside an Ecto query filter, where money/decimal are
  // data-layer-native (the Postgres column) rather than `Decimal` structs.
  const target = ctx.filterArgs ? ELIXIR_FILTER_TARGET : ELIXIR_TARGET;
  return renderExprWith(e, target, ctx);
}

/**
 * Render an explicit conversion expression for the Phoenix/Elixir
 * backend.  Both `money` and `decimal` are `Decimal` structs here, so the
 * two are interchangeable on either side of a coercion:
 *   string(x: int|long|bool)            → `to_string(x)`
 *   string(x: money|decimal)            → `Decimal.to_string(x)`
 *   long(x: int)                        → `x`           (Elixir has only
 *                                                        integer)
 *   long(x: money|decimal)              → `Decimal.to_integer(x)`
 *   decimal|money(x: int|long)          → `Decimal.new(x)`  (box the int)
 *   decimal|money(x: money|decimal)     → `x`           (both already Decimal)
 */
function renderElixirConvert(
  target: string,
  from: string | undefined,
  v: string,
  // Inside an Ecto query filter money/decimal are data-layer-native, not
  // `Decimal` structs, so the `Decimal.*` coercions are invalid — treat them as
  // plain numerics.
  inFilter = false,
): string {
  const decimalStruct = (name: string | undefined) => !inFilter && isDecimalStruct(name);
  if (target === "string") {
    if (decimalStruct(from)) return `Decimal.to_string(${v})`;
    return `to_string(${v})`;
  }
  if (target === "long" || target === "int") {
    // A Decimal → integer narrowing truncates toward zero (`Decimal.to_integer`
    // raises on a fractional value, so round down first); the int/long
    // passthrough (`x` already an integer) is unchanged.
    if (decimalStruct(from)) return `Decimal.to_integer(Decimal.round(${v}, 0, :down))`;
    return v;
  }
  if (decimalStruct(target)) {
    // money|decimal target: already a Decimal → no-op; otherwise box.
    if (decimalStruct(from)) return v;
    return `Decimal.new(${v})`;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

function renderLiteral(lit: string, value: string, inFilter = false): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "null") return "nil";
  if (lit === "bool") return value === "true" ? "true" : "false";
  if (lit === "now") return "DateTime.utc_now()";
  // Both decimal and money literals are `Decimal` structs on Elixir; wrap the
  // source numeral as a string so `Decimal.new` keeps full precision.  Inside an
  // Ecto query filter, however, a numeral is data-layer-native (`Decimal.new`
  // is invalid there) — emit it bare.
  if (lit === "decimal" || lit === "money") {
    return inFilter ? value : `Decimal.new(${JSON.stringify(value)})`;
  }
  // int
  return value;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function renderRef(e: RefExpr, ctx: RenderCtx): string {
  switch (e.refKind) {
    case "param":
      // Dispatch handlers rename the bound event param to `event`.
      if (ctx.paramRenames?.[e.name]) return ctx.paramRenames[e.name];
      // Inside an Ecto query filter (`from ... where: ...`), a declared
      // argument is pinned as a plain local (`^name`); everywhere else a
      // param is a bare local.  (`let`/`lambda` are always locals.)
      if (ctx.filterArgs) {
        // Ecto query filter — pin the bound local.
        return `^${snake(e.name)}`;
      }
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
      // A vanilla Ecto `:string` column stores the enum value as a string
      // (`"confirmed"`).
      return `"${snake(e.name)}"`;
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
      // Embedded value-object constructor.  Elixir structs require
      // *named* fields, so use the (lowering-populated) field names rather
      // than positional args.  Falls back to positional for hand-built IR
      // that carries no names (kept total).
      const names = e.argNames;
      if (names && names.length === args.length && names.every((n) => n)) {
        const namedFields = args.map((a, i) => `${snake(names[i] as string)}: ${a}`).join(", ");
        // Vanilla stores value objects as plain JSON maps — no `%Ctx.VO{}`
        // struct module is emitted — so an inline VO constructor (e.g. in an
        // event-sourced applier fold) builds a map; `%Ctx.VO{…}` would
        // reference an undefined struct and fail `mix compile`.
        return `%{${namedFields}}`;
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
    case "action":
    // Sibling action call (Proposal A Stage 1) — frontend-only; never lowered
    // into a backend domain expression.  Plain call keeps the switch total.
    case "store-action":
    // `<Store>.<action>()` call (Stage 5) — frontend-only; plain-call fall-through.
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
    case "domain-service": {
      // `Shop.Domain.Services.Pricing.quote(cart, customer)` — a plain
      // stateless module (no GenServer, no state), fully qualified
      // under the app's `Domain.Services` namespace.  The app prefix is the
      // first segment of `contextModule` (`MyApp.Sales` → `MyApp`).
      const ref = e.serviceRef!;
      const app = ctx.contextModule.split(".")[0] ?? ctx.contextModule;
      return `${app}.Domain.Services.${upperFirst(ref.service)}.${snake(ref.op)}(${args.join(", ")})`;
    }
  }
}

// ---------------------------------------------------------------------------
// New (entity part constructor)
// ---------------------------------------------------------------------------

function renderNew(fields: { name: string; value: string }[], e: NewExpr, ctx: RenderCtx): string {
  const body = fields.map((f) => `${snake(f.name)}: ${f.value}`).join(", ");
  // The part is an Ecto `embedded_schema` struct (`%Ctx.Part{}`) — see
  // schema-emit's `embeds_many`.
  return `%${ctx.contextModule}.${upperFirst(e.partName)}{${body}}`;
}

// ---------------------------------------------------------------------------
// Unary
// ---------------------------------------------------------------------------

function renderUnary(op: "-" | "!", operand: string, e: UnaryExpr, inFilter = false): string {
  if (op === "!") return `not ${operand}`;
  // Negating a money/decimal `Decimal` struct: native `-` is `:erlang.-/1`,
  // which raises on a `Decimal` ("bad argument in arithmetic").  Use
  // `Decimal.negate/1` in native Elixir (op-bodies / emitted ExUnit tests);
  // inside an Ecto query filter money/decimal are data-layer-native, so plain `-`.
  if (!inFilter && isDecimalOperand(e.operand)) return `Decimal.negate(${operand})`;
  return `-${operand}`;
}

/** Does this expression evaluate to a money/decimal `Decimal` struct? — used to
 *  route unary negation through `Decimal.negate/1`.  Covers the realistic
 *  operand shapes (negative literal, a typed ref/member, an arithmetic binary,
 *  a decimal cast, parens). */
function isDecimalOperand(operand: ExprIR): boolean {
  switch (operand.kind) {
    case "literal":
      return isDecimalStruct(operand.lit);
    case "ref":
      return operand.type?.kind === "primitive" && isDecimalStruct(operand.type.name);
    case "member":
      return operand.memberType.kind === "primitive" && isDecimalStruct(operand.memberType.name);
    case "binary":
      return (
        (operand.resultType?.kind === "primitive" && isDecimalStruct(operand.resultType.name)) ||
        (operand.leftType?.kind === "primitive" && isDecimalStruct(operand.leftType.name))
      );
    case "convert":
      return isDecimalStruct(operand.target);
    case "paren":
      return isDecimalOperand(operand.inner);
    case "unary":
      return isDecimalOperand(operand.operand);
    default:
      return false;
  }
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

function renderBinary(l: string, r: string, e: BinaryExpr, inFilter = false): string {
  // `x == null` / `x != null` → `is_nil(x)` / `not is_nil(x)`.  Comparing
  // against `nil` with `==`/`!=` is an Elixir footgun: the compiler warns
  // ("Comparing values with nil will always return false. Use is_nil/1
  // instead."), so `--warnings-as-errors` fails on it, and an Ecto query
  // filter wants `is_nil/1` too.
  if (e.op === "==" || e.op === "!=") {
    const leftNull = e.left.kind === "literal" && e.left.lit === "null";
    const rightNull = e.right.kind === "literal" && e.right.lit === "null";
    if (leftNull || rightNull) {
      const operand = leftNull ? r : l;
      return e.op === "==" ? `is_nil(${operand})` : `not is_nil(${operand})`;
    }
  }
  // money / decimal operands cannot use the native `+`/`*`/`>` operators in
  // Elixir — both are `Decimal` structs.  Arithmetic dispatches through
  // `Decimal.add/2` / `mult/2` / `div/2`; comparisons go through
  // `Decimal.compare/2` (returns `:lt | :eq | :gt` — three tokens,
  // not a single operator, so the result shape isn't `${l} ${op}
  // ${r}` like the primitive path).  An integer operand on either side is
  // accepted by the `Decimal.*` functions as-is (they coerce integers); a
  // `decimal`/`money` literal is already wrapped in `Decimal.new(...)`, so
  // no extra boxing is needed here.
  // Inside an Ecto query filter money/decimal lower to the data layer via the
  // native operators — `Decimal.compare`/`Decimal.add` are invalid there — so
  // only the native op-body path dispatches through `Decimal.*`.
  if (!inFilter && e.leftType?.kind === "primitive" && isDecimalStruct(e.leftType.name)) {
    return renderDecimalBinary(e.op, l, r);
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

const DECIMAL_ARITH: Record<string, string | undefined> = {
  "+": "Decimal.add",
  "-": "Decimal.sub",
  "*": "Decimal.mult",
  "/": "Decimal.div",
};

// Shared by money AND decimal operands — both are `Decimal` structs here.
function renderDecimalBinary(op: BinOp, l: string, r: string): string {
  const arithFn = DECIMAL_ARITH[op];
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
// Elixir typespec rendering — emits real
// Elixir typespec syntax (`String.t()`, `integer()`, `Foo.t() | nil`) for
// `@spec` / `@type` annotations on event modules, value-object modules,
// and the hand-written `def`s in the context module.
//
// Optionals lower to `T | nil` (Elixir's nullable convention).  Arrays
// lower to `[T]`.  Enums and value-object/entity types reference their
// module's `.t()`.
//
// When `typesModule` is provided (`<App>.Types`, emitted once per app
// by `types-module-emit.ts`), `id` → `<typesModule>.id()` and primitive
// `datetime` → `<typesModule>.timestamp()` — references to the shared
// vocabulary instead of inlining `String.t()` / `DateTime.t()`.  Falls
// back to the inline shapes when absent (used by direct unit tests and
// for backwards compatibility with any emission site that hasn't been
// threaded through yet).
// ---------------------------------------------------------------------------

export function renderTypespec(t: TypeIR, contextModule: string, typesModule?: string): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "integer()";
        case "decimal":
        case "money":
          // Decimal is the canonical precise type for both decimal and
          // money fields — matches `renderAshType`'s `:decimal` mapping.
          return "Decimal.t()";
        case "string":
          return "String.t()";
        case "bool":
          return "boolean()";
        case "datetime":
          return typesModule ? `${typesModule}.timestamp()` : "DateTime.t()";
        case "guid":
          // UUIDs are plain binary strings on the struct.
          return "String.t()";
        case "json":
          return "map()";
      }
    case "id":
      // IDs flow as UUID strings on the struct (`:uuid` → String.t()).
      return typesModule ? `${typesModule}.id()` : "String.t()";
    case "enum":
      // Vanilla has no enum module — the value is stored as its string, so the
      // spec is `String.t()`.
      return "String.t()";
    case "valueobject":
      // Vanilla stores value objects as plain JSON maps — no module exists, so
      // the spec is `map()`.
      return "map()";
    case "entity":
      return `${contextModule}.${upperFirst(t.name)}.t()`;
    case "array":
      return `[${renderTypespec(t.element, contextModule, typesModule)}]`;
    case "optional":
      return `${renderTypespec(t.inner, contextModule, typesModule)} | nil`;
    case "action":
    case "slot":
      throw new Error("renderTypespec: 'slot' type is UI-only and should not reach the backend.");
    case "genericInstance":
      // Transport-only carrier — not a stored attribute typespec.  The page
      // envelope is a plain map; keep the renderer total.
      return "map()";
    case "union":
    case "none":
      // Discriminated unions (`A or B`, `T option`) are transport-only; never
      // a stored attribute typespec.  Defensive `map()` keeps it total.
      return "map()";
  }
}
