import type { BinOp, EnrichedAggregateIR, ExprIR, TypeIR } from "../../ir/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { joinDbSetName, joinFkPropName } from "./emit/join-entities.js";

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
  /**
   * Mutable accumulator for namespaces this rendering reaches into
   * that aren't covered by the SDK's `<ImplicitUsings>` set
   * (e.g. `System.Text.RegularExpressions` when `string.matches(...)`
   * lowers to `Regex.IsMatch`).  The file-level emitter creates the
   * Set, threads this ctx through every render call inside the file,
   * and emits one `using <ns>;` per entry into the file header.
   * Optional so callers that don't care about tracking
   * (one-shot snippet rendering in tests etc.) can omit it.
   */
  usings?: Set<string>;
  /** Aggregate whose finds/derived bodies we're lowering.  Required
   * for `this.<refColl>.contains(param)` membership predicates, which
   * lower to a subquery against the field's join entity DbSet
   * (`_db.<JoinDbSet>.Any(...)`).  When unset, the contains
   * predicate falls back to the in-memory `Contains(value)` shape —
   * the validator only admits the membership form inside repository
   * `where` clauses, so other emission contexts (derived, invariant)
   * shouldn't reach it. */
  agg?: EnrichedAggregateIR;
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
      //
      // Lambda body is now optional.  .NET render contexts
      // shouldn't see block bodies — those are React-emitter territory
      // — but stay total to keep the build happy.
      if (e.body) return `${e.param} => ${renderCsExpr(e.body, ctx)}`;
      return `${e.param} => { /* block-body lambda — not C#-renderable */ }`;
    case "new":
      return renderNew(e, ctx);
    case "object":
      // Bare object literals only appear in e2e contexts; in operation
      // bodies this branch is unreachable (the validator rejects them).
      return `new { ${e.fields.map((f) => `${upperFirst(f.name)} = ${renderCsExpr(f.value, ctx)}`).join(", ")} }`;
    case "list":
      // List literals are walker-config sugar (e.g. responsive Grid cols).
      // No .NET render context emits one today; keep total with an array
      // initializer fallback so unexpected uses produce valid C#.
      return `new[] { ${e.elements.map((el) => renderCsExpr(el, ctx)).join(", ")} }`;
    case "paren":
      return `(${renderCsExpr(e.inner, ctx)})`;
    case "unary":
      return `${e.op}${renderCsExpr(e.operand, ctx)}`;
    case "binary":
      return renderBinary(e.op, e.left, e.right, ctx);
    case "ternary":
      return `${renderCsExpr(e.cond, ctx)} ? ${renderCsExpr(e.then, ctx)} : ${renderCsExpr(e.otherwise, ctx)}`;
    case "convert":
      return renderCsConvert(e.target, e.from, e.value, ctx);
    case "match": {
      // Lower a match expression to a chained C# ternary so
      // it can appear inside `derived` bodies, view binds, and other
      // C#-rendered expression positions.  Same right-fold semantics
      // as the TS renderer.
      const arms = [...e.arms].reverse();
      const tail = e.otherwise ? renderCsExpr(e.otherwise, ctx) : "null";
      let out = tail;
      for (const arm of arms) {
        out = `(${renderCsExpr(arm.cond, ctx)} ? ${renderCsExpr(arm.value, ctx)} : ${out})`;
      }
      return out;
    }
  }
}

/** Field name behind a `this.<field>` receiver (used to look up the
 * AssociationIR when lowering `.contains(...)`), or null if the
 * receiver isn't a `this`-rooted single member access. */
function refCollectionFieldName(e: ExprIR): string | null {
  if (e.kind === "paren") return refCollectionFieldName(e.inner);
  if (e.kind === "member" && e.receiver.kind === "this") return e.member;
  if (e.kind === "ref" && e.refKind === "this-prop") return e.name;
  return null;
}

/**
 * Render an explicit conversion expression (`string(age)`,
 * `money(decimalField)`, etc.) for the .NET backend.  Per-(from,
 * target) pair so each emit matches C# idiom:
 *   string(x: numeric|bool) → `x.ToString()`
 *   string(x: decimal|money) → `x.ToString(CultureInfo.InvariantCulture)`
 *                              (locale-independent decimal separator)
 *   long(x: int)             → `(long)x`
 *   decimal(x: int|long)     → `(decimal)x`
 *   decimal(x: money)        → `x`               (money IS decimal in C#)
 *   money(x: int|long)       → `(decimal)x`
 *   money(x: decimal)        → `x`               (no-op)
 */
function renderCsConvert(
  target: string,
  from: string | undefined,
  value: ExprIR,
  ctx: CsRenderContext,
): string {
  const v = renderCsExpr(value, ctx);
  if (target === "string") {
    if (from === "decimal" || from === "money") {
      return `${v}.ToString(System.Globalization.CultureInfo.InvariantCulture)`;
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

function renderRef(e: Extract<ExprIR, { kind: "ref" }>, ctx: CsRenderContext): string {
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
      return e.name;
  }
}

function renderMember(e: Extract<ExprIR, { kind: "member" }>, ctx: CsRenderContext): string {
  const recv = renderCsExpr(e.receiver, ctx);
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
  e: Extract<ExprIR, { kind: "method-call" }>,
  ctx: CsRenderContext,
): string {
  const recv = renderCsExpr(e.receiver, ctx);
  const args = e.args.map((a) => renderCsExpr(a, ctx));
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
    ctx.usings?.add("System.Text.RegularExpressions");
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

function renderCall(e: Extract<ExprIR, { kind: "call" }>, ctx: CsRenderContext): string {
  const args = e.args.map((a) => renderCsExpr(a, ctx)).join(", ");
  switch (e.callKind) {
    case "value-object-ctor":
      return `new ${upperFirst(e.name)}(${args})`;
    case "function":
    case "private-operation":
      return `${ctx.thisName}.${upperFirst(e.name)}(${args})`;
    case "free":
      return `${upperFirst(e.name)}(${args})`;
  }
}

function renderNew(e: Extract<ExprIR, { kind: "new" }>, ctx: CsRenderContext): string {
  const inits = [
    `Id = ${e.partName}Id.New()`,
    `ParentId = ${ctx.thisName}.Id`,
    ...e.fields.map((f) => `${upperFirst(f.name)} = ${renderCsExpr(f.value, ctx)}`),
  ];
  return `${e.partName}._Create(new ${e.partName}.State { ${inits.join(", ")} })`;
}

function renderBinary(op: BinOp, left: ExprIR, right: ExprIR, ctx: CsRenderContext): string {
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
