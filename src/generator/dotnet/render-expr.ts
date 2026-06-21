import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { EnrichedAggregateIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import { upperFirst } from "../../util/naming.js";
import {
  type CallExpr,
  type ExprTarget,
  type MemberExpr,
  type MethodCallExpr,
  type NewExpr,
  type RefExpr,
  renderExprWith,
} from "../_expr/target.js";
import type { UnionMember } from "../_payload/union-wire.js";
import { joinDbSetName, joinFkPropName } from "./emit/join-entities.js";

// ---------------------------------------------------------------------------
// Expression renderer for the .NET / C# backend.
//
// Same shape as the TypeScript renderer — consumes fully-resolved Loom
// ExprIR.  Output is idiomatic C# 12.  The 17-arm dispatch + recursion live
// in `../_expr/target.ts`; this file is the C# leaf table (`CS_TARGET`) plus
// the thin `renderCsExpr` entry point.
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
  /** Aggregate whose finds/derived bodies we're lowering.  Required
   * for `this.<refColl>.contains(param)` membership predicates, which
   * lower to a subquery against the field's join entity DbSet
   * (`_db.<JoinDbSet>.Any(...)`).  When unset, the contains
   * predicate falls back to the in-memory `Contains(value)` shape —
   * the validator only admits the membership form inside repository
   * `where` clauses, so other emission contexts (derived, invariant)
   * shouldn't reach it. */
  agg?: EnrichedAggregateIR;
  /** Resource-op call routing: resourceName → static C# helper class
   *  name (e.g. `salesFiles` → `S3Resources`).  Set on the workflow
   *  render context (Phase 4c); a `resource-op` call renders to
   *  `<class>.<Resource>_<Verb>(args)`.  When unset, a resource-op
   *  throws at emit (non-resource render contexts never see one). */
  resourceClasses?: Map<string, string>;
  /** Exception-less operation return (exception-less.md): the Domain union the
   *  enclosing method returns.  `name` is the Domain union type; `members` give
   *  each variant's tag + field order so a tagged `return` constructs the right
   *  `<name>_<Tag>(...)` variant record positionally.  Unset outside a
   *  union-returning operation body. */
  returnUnion?: { name: string; members: UnionMember[] };
}

const DEFAULT: CsRenderContext = { thisName: "this" };

/** Namespaces a rendered domain expression reaches into beyond the SDK's
 *  `<ImplicitUsings>` set.  Today the sole trigger is the
 *  `string.matches(...)` → `Regex.IsMatch` lowering, which needs
 *  `System.Text.RegularExpressions`.  This is the pure mirror of the
 *  trigger in `renderMethodCall`: file emitters call it over the same
 *  expressions they render to build their `using` header, instead of
 *  threading a mutable Set through every render call.  Walking the whole
 *  tree is safe — the renderer always renders the whole tree, so a
 *  `matches` shape anywhere is rendered (and thus needs the namespace)
 *  exactly when this finds it. */
export function collectCsExprUsings(e: ExprIR, into: Set<string> = new Set()): Set<string> {
  switch (e.kind) {
    case "method-call":
      if (
        e.member === "matches" &&
        e.receiverType.kind === "primitive" &&
        e.receiverType.name === "string" &&
        e.args.length === 1
      ) {
        into.add("System.Text.RegularExpressions");
      }
      collectCsExprUsings(e.receiver, into);
      for (const a of e.args) collectCsExprUsings(a, into);
      return into;
    case "member":
      return collectCsExprUsings(e.receiver, into);
    case "binary":
      collectCsExprUsings(e.left, into);
      return collectCsExprUsings(e.right, into);
    case "unary":
      return collectCsExprUsings(e.operand, into);
    case "paren":
      return collectCsExprUsings(e.inner, into);
    case "ternary":
      collectCsExprUsings(e.cond, into);
      collectCsExprUsings(e.then, into);
      return collectCsExprUsings(e.otherwise, into);
    case "call":
      for (const a of e.args) collectCsExprUsings(a, into);
      return into;
    case "lambda":
      if (e.body) collectCsExprUsings(e.body, into);
      return into;
    case "new":
    case "object":
      for (const f of e.fields) collectCsExprUsings(f.value, into);
      return into;
    case "convert":
      return collectCsExprUsings(e.value, into);
    case "match":
      for (const arm of e.arms) {
        collectCsExprUsings(arm.cond, into);
        collectCsExprUsings(arm.value, into);
      }
      if (e.otherwise) collectCsExprUsings(e.otherwise, into);
      return into;
    default:
      // literal | this | id | ref — leaves with no sub-expressions.
      return into;
  }
}

const CS_TARGET: ExprTarget<CsRenderContext> = {
  literal: renderLiteral,
  id: (ctx) => `${ctx.thisName}.Id`,
  ref: renderRef,
  member: renderMember,
  methodCall: renderMethodCall,
  call: renderCall,
  domainServiceCall(args, serviceRef) {
    // `Pricing.Quote(cart, customer)` — generated `public static class`.
    return `${upperFirst(serviceRef.service)}.${upperFirst(serviceRef.op)}(${args.join(", ")})`;
  },
  lambda(param, body) {
    // Lambdas always introduce their own parameter; the body is rendered
    // with the outer `this` still pointing at the same receiver (lambdas in
    // DSL are pure expressions).
    //
    // Lambda body is now optional.  .NET render contexts shouldn't see block
    // bodies — those are React-emitter territory — but stay total to keep the
    // build happy.
    if (body !== undefined) return `${param} => ${body}`;
    return `${param} => { /* block-body lambda — not C#-renderable */ }`;
  },
  newPart: renderNew,
  // Bare object literals only appear in e2e contexts; in operation bodies
  // this branch is unreachable (the validator rejects them).
  object: (fields) =>
    `new { ${fields.map((f) => `${upperFirst(f.name)} = ${f.value}`).join(", ")} }`,
  unary: (op, operand) => `${op}${operand}`,
  binary: (left, right, e) => `${left} ${e.op} ${right}`,
  ternary: (cond, then, otherwise) => `${cond} ? ${then} : ${otherwise}`,
  convert: (value, e) => renderCsConvert(e.target, e.from, value),
  match(arms, otherwise) {
    // Lower a match expression to a chained C# ternary so it can appear
    // inside `derived` bodies, view binds, and other C#-rendered expression
    // positions.  Same right-fold semantics as the TS renderer.
    let out = otherwise ?? "null";
    for (const arm of [...arms].reverse()) {
      out = `(${arm.cond} ? ${arm.value} : ${out})`;
    }
    return out;
  },
  // List literals are walker-config sugar (e.g. responsive Grid cols).  No
  // .NET render context emits one today; keep total with an array initializer
  // fallback so unexpected uses produce valid C#.
  list: (elements) => `new[] { ${elements.join(", ")} }`,
};

export function renderCsExpr(e: ExprIR, ctx: CsRenderContext = DEFAULT): string {
  return renderExprWith(e, CS_TARGET, ctx);
}

/**
 * Render an explicit conversion expression (`string(age)`,
 * `money(decimalField)`, etc.) for the .NET backend.  Per-(from,
 * target) pair so each emit matches C# idiom:
 *   string(x: numeric)        → `x.ToString(CultureInfo.InvariantCulture)`
 *   string(x: bool)           → `x.ToString()` (bool is culture-stable)
 *   string(x: datetime)       → `x.ToString("O", CultureInfo.InvariantCulture)`
 *                               (ISO 8601 round-trip; CA1305-clean)
 *   long(x: int)              → `(long)x`
 *   decimal(x: int|long)      → `(decimal)x`
 *   decimal(x: money)         → `x`               (money IS decimal in C#)
 *   money(x: int|long)        → `(decimal)x`
 *   money(x: decimal)         → `x`               (no-op)
 */
function renderCsConvert(target: string, from: string | undefined, v: string): string {
  if (target === "string") {
    // CA1305: numeric / decimal / datetime ToString needs an IFormatProvider
    // so generated code doesn't drift on a non-en-US machine.  Other types
    // (id records, enums, custom value-objects) either lack the IFormatProvider
    // overload (records' default ToString) or render it obsolete (Enum.ToString
    // since .NET 8) — keep their bare ToString.
    if (from === "decimal" || from === "money") {
      return `${v}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;
    }
    if (from === "int" || from === "long") {
      return `${v}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;
    }
    if (from === "datetime") {
      // ISO 8601 round-trip — "O" is the only format that preserves DateTime
      // precision losslessly, and IFormatProvider keeps the literal stable.
      return `${v}.ToString("O", System.Globalization.CultureInfo.InvariantCulture)`;
    }
    return `${v}.ToString()`;
  }
  if (target === "long") {
    return `(long)${v}`;
  }
  if (target === "decimal") {
    // money is already C# `decimal` — explicit cast is redundant.
    if (from === "money" || from === "decimal") return v;
    return `(decimal)${v}`;
  }
  if (target === "money") {
    // money is C# `decimal` — coerce int/long to decimal; same-type
    // is a no-op.
    if (from === "decimal" || from === "money") return v;
    return `(decimal)${v}`;
  }
  return v;
}

function renderLiteral(lit: string, value: string): string {
  if (lit === "string") return JSON.stringify(value);
  if (lit === "now") return "DateTime.UtcNow";
  if (lit === "null") return "null";
  if (lit === "decimal") return `${value}m`;
  // long literals emit with the `L` suffix.  Without it, large
  // values (e.g. `9999999999`) parse as int in C# and overflow at
  // compile time — `long big = 9999999999;` errors with CS1021.
  // The `lowerExprInContext` seam elaborates a bare IntLit in a
  // long context to `lit("long", ...)`; this is the matching emit
  // side.
  if (lit === "long") return `${value}L`;
  // money literals carry a precise-decimal source string.  C#'s
  // `decimal` parses precision-preserving from the same source form
  // — `10.50m` — so the suffix is identical to `decimal`'s.  The
  // wire serialiser (per-property `JsonNumberHandling`) is what makes
  // money distinct on the JSON boundary.
  if (lit === "money") return `${value}m`;
  return value;
}

function renderRef(e: RefExpr, ctx: CsRenderContext): string {
  switch (e.refKind) {
    case "param":
    case "let":
    case "lambda":
      return e.name;
    case "this-prop":
    case "this-vo-prop":
    case "this-derived":
      return `${ctx.thisName}.${upperFirst(e.name)}`;
    case "helper-fn":
      return `${ctx.thisName}.${upperFirst(e.name)}`;
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
  // Arrays lower to `List<T>` which has `.Count` (not `.Length`).  The
  // DSL admits both `.count` and `.length` on arrays; map both to .Count.
  if (e.receiverType.kind === "array" && (e.member === "count" || e.member === "length")) {
    return `${recv}.Count`;
  }
  if (
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    e.member === "length"
  ) {
    return `${recv}.Length`;
  }
  return `${recv}.${upperFirst(e.member)}`;
}

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  ctx: CsRenderContext,
): string {
  // `this.<refColl>.contains(x)` — membership over a reference
  // collection.  Lowers to a join-table subquery, mirroring TS's
  // `inArray(roots.id, ...)` shape.  Detection is structural: the
  // method-call's receiverType is `array<id>`, the receiver chains
  // through `this.<field>`, and we can resolve the field's
  // AssociationIR on `ctx.agg`.  All-in-context conditions guard
  // against firing on regular collection `.contains(x)` calls.
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
        const dbSet = joinDbSetName(assoc);
        const owner = joinFkPropName(assoc.ownerFk);
        const target = joinFkPropName(assoc.targetFk);
        return `_db.${dbSet}.Any(__j => __j.${owner} == ${ctx.thisName}.Id && __j.${target} == ${args[0]})`;
      }
    }
  }
  if (e.isCollectionOp) {
    return renderCollectionOp(`(${recv})`, e.member, args);
  }
  // `string.matches(literal)` — domain rendering lowers to
  // Regex.IsMatch from System.Text.RegularExpressions.  Wire-boundary
  // FluentValidation rendering is handled separately via the
  // `regex` SingleFieldPattern.
  if (
    e.member === "matches" &&
    e.receiverType.kind === "primitive" &&
    e.receiverType.name === "string" &&
    args.length === 1
  ) {
    return `Regex.IsMatch(${recv}, ${args[0]})`;
  }
  return `${recv}.${upperFirst(e.member)}(${args.join(", ")})`;
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
      return `${recv}.${upperFirst(name)}(${args.join(", ")})`;
  }
}

function renderCall(args: string[], e: CallExpr, ctx: CsRenderContext): string {
  const argList = args.join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${upperFirst(e.name)}(${argList})`;
    case "function":
    case "private-operation":
      return `${ctx.thisName}.${upperFirst(e.name)}(${argList})`;
    case "resource-op": {
      // Resource-op (Phase 4c) → `<Class>.<Resource>_<Verb>(args)`, an
      // async static helper the .NET ResourceAdapter emits.  Awaited by
      // the statement renderer.  The class is routed by sourceType via
      // `ctx.resourceClasses`; a missing entry means this render context
      // shouldn't carry a resource-op.
      const op = e.resourceOp!;
      const cls = ctx.resourceClasses?.get(op.resourceName);
      if (!cls) {
        throw new Error(
          `Resource operation '${op.resourceName}.${op.verb}' reached the .NET renderer without a resource class mapping.`,
        );
      }
      return `${cls}.${upperFirst(op.resourceName)}_${upperFirst(op.verb)}(${argList})`;
    }
    case "domain-service": {
      // `Pricing.Quote(cart, customer)` — the generated .NET service is a
      // `public static class` (operation name PascalCased).
      const ref = e.serviceRef!;
      return `${upperFirst(ref.service)}.${upperFirst(ref.op)}(${argList})`;
    }
    case "free":
      return `${upperFirst(e.name)}(${argList})`;
  }
}

function renderNew(
  fields: { name: string; value: string }[],
  e: NewExpr,
  ctx: CsRenderContext,
): string {
  const inits = [
    `Id = ${e.partName}Id.New()`,
    `ParentId = ${ctx.thisName}.Id`,
    ...fields.map((f) => `${upperFirst(f.name)} = ${f.value}`),
  ];
  return `${e.partName}._Create(new ${e.partName}.State { ${inits.join(", ")} })`;
}

// ---------------------------------------------------------------------------
// Type printing
// ---------------------------------------------------------------------------

export function renderCsType(t: TypeIR): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
          return "int";
        case "long":
          return "long";
        case "decimal":
          return "decimal";
        case "money":
          // C# `decimal` is already precise — money differs from
          // decimal only at the JSON wire boundary, where the per-
          // property `[JsonNumberHandling]` attribute (emitted by
          // dto-mapping.ts) forces a string encoding.
          return "decimal";
        case "string":
          return "string";
        case "bool":
          return "bool";
        case "datetime":
          return "DateTime";
        case "guid":
          return "Guid";
        case "json":
          return "System.Text.Json.JsonElement";
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
      return `List<${renderCsType(t.element)}>`;
    case "optional":
      return `${renderCsType(t.inner)}?`;
    case "action":
    case "slot":
      throw new Error("renderCsType: 'slot' type is UI-only and should not reach the backend.");
    case "genericInstance":
      // Carrier-bounded generic (`order paged`, `event envelope`) → an
      // idiomatic C# generic record (`Paged<Order>`, `Envelope<string>`),
      // defined once in the shared runtime (P3b).  Domain-side render: an
      // entity arg stays the domain class; the controller maps it to the
      // response record when serializing.
      return `${upperFirst(t.ctor)}<${renderCsType(t.arg)}>`;
    case "union":
      // Discriminated union → the polymorphic base record name (P4c).  The
      // emitter (`emitUnionDtos`) declares it `[JsonPolymorphic("type")]` with
      // one `[JsonDerivedType]` per variant, so the wire matches the TS
      // `z.discriminatedUnion("type", …)` byte-for-byte.
      return unionInstanceName(t.variants);
    case "none":
      // `none` only ever appears inside an option's union (rendered by the
      // union DTO emitter), never as a standalone C# type — defensive.
      return "object";
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
