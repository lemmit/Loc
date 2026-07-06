import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { EnrichedAggregateIR, ExprIR, TypeIR } from "../../ir/types/loom-ir.js";
import { refCollectionFieldName } from "../../ir/util/ref-collection.js";
import {
  DATA_KEY_PATH_DELIMITER,
  deepScopeAnchorClaim,
  isDeepScopeFilter,
  TENANT_OWNED_DATA_KEY_FIELD,
  TENANT_OWNED_TENANT_ID_FIELD,
} from "../../ir/util/tenant-stance.js";
import { intrinsicKey } from "../../util/intrinsics.js";
import { escapeCsharpIdent, upperFirst } from "../../util/naming.js";
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
  /** EF-translated expression position (find/view `Where`, `HasQueryFilter`,
   *  criteria Specifications): scalar intrinsics render their EF-translatable
   *  spelling (see CS_INTRINSIC_QUERY_RENDERERS) instead of the domain form. */
  efQuery?: boolean;
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
  /** TPC abstract-base derived bodies (aggregate-inheritance.md, `ownTable`):
   *  the base owns no typed `Id` property (each concrete carries its own
   *  strongly-typed id), so an `id` read in a base derived member (e.g. the
   *  synthesized `inspect`) must go through the loosely-typed boxed accessor
   *  the concretes override (`public override object IdBoxed => Id;`).  When
   *  set, an `id` expr renders `this.<idAccessor>` instead of `this.Id`. */
  idAccessor?: string;
  /** Static-position principal resolution (tenancy).  An EF Core query filter
   *  lambda is built once in `OnModelCreating` and cannot close over a
   *  request-scoped `currentUser` local the way an operation/workflow body can.
   *  When set, the `current-user` arm renders this expression instead of the
   *  bare `currentUser` token, so a capability `filter this.x == currentUser.x`
   *  resolves through the ambient accessor (`RequestContext.Current!.CurrentUser!`)
   *  the read side already uses — one currentUser resolution for the whole
   *  backend.  Unset everywhere a `currentUser` local is actually in scope. */
  currentUserExpr?: string;
  /** Read-port handle resolver for a `reading`-tier domain-service body
   *  (domain-services.md rev. 4, Slice 1).  A `repo-read` Call
   *  (`Accounts.byHolder(holder)`, lowered to `callKind: "repo-read"`) renders
   *  against the repository the service has INJECTED — on .NET / EF a `reading`
   *  service is a DI'd `sealed class` whose ctor takes one `I<Aggregate>Repository`
   *  per read-port, stored as `_<repo>`.  Given the `repoRead.repo` name
   *  (`Accounts`), this returns the field expression to read through
   *  (`_accounts`).  Only the service-body render context sets it; unset
   *  everywhere else (a `repo-read` reaching a non-service context is a
   *  validator-caught bug). */
  repoReadHandle?: (repo: string) => string;
  /** Injected-service call resolver for a `reading`-tier domain-service call
   *  (domain-services.md rev. 4, Slice 1).  On .NET a `reading` service is a
   *  DI'd `sealed class`, so the orchestrating workflow injects it (`_registration`)
   *  and the call site is `await _registration.IsEmailAvailableAsync(holder, ct)` —
   *  NOT the static `Registration.IsEmailAvailable(holder)` a PURE service emits.
   *  Given the resolved `{ service, op }`, this returns the injected receiver +
   *  the async method name when the op is reading (so the `domain-service` arm
   *  awaits it and passes `cancellationToken`), or `undefined` for a PURE op
   *  (which then stays byte-identical, rendering the static `Service.Op(args)`).
   *  Only the workflow-handler render context sets it. */
  domainServiceReadingCall?: (
    service: string,
    op: string,
  ) => { receiver: string; method: string } | undefined;
}

/** The ambient request-scoped principal accessor on the .NET read side. Every
 *  static-position `currentUser` query predicate — the EF `HasQueryFilter`
 *  capability filters AND the reified retrieval `Specification<T>` `where` —
 *  resolves the principal through this one expression, so the backend has a
 *  single principal source (the `currentUser`-is-an-ambient-operand reframe of
 *  `reified-criteria.md`). Pass it as `currentUserExpr` when rendering a
 *  predicate that has no in-scope `currentUser` local. */
export const AMBIENT_CURRENT_USER = "RequestContext.Current!.CurrentUser!";

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
export function collectCsExprUsings(
  e: ExprIR,
  into: Set<string> = new Set(),
  /** Project root namespace — when present, a `domain-service` call adds
   *  `${ns}.Domain.Services` so the hosting file resolves the static class
   *  the call leaf emits (`Pricing.Quote(...)`).  Omitted by collectors that
   *  never sit beside a domain-service call (criteria, finds, validators). */
  ns?: string,
): Set<string> {
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
      collectCsExprUsings(e.receiver, into, ns);
      for (const a of e.args) collectCsExprUsings(a, into, ns);
      return into;
    case "member":
      return collectCsExprUsings(e.receiver, into, ns);
    case "binary":
      collectCsExprUsings(e.left, into, ns);
      return collectCsExprUsings(e.right, into, ns);
    case "unary":
      return collectCsExprUsings(e.operand, into, ns);
    case "paren":
      return collectCsExprUsings(e.inner, into, ns);
    case "ternary":
      collectCsExprUsings(e.cond, into, ns);
      collectCsExprUsings(e.then, into, ns);
      return collectCsExprUsings(e.otherwise, into, ns);
    case "call":
      // A domain-service member call (`Pricing.Quote(...)`) reaches into the
      // generated `Domain.Services` namespace — the call leaf renders the
      // class name unqualified, so the file must import it.
      if (e.callKind === "domain-service" && ns !== undefined) {
        into.add(`${ns}.Domain.Services`);
      }
      for (const a of e.args) collectCsExprUsings(a, into, ns);
      return into;
    case "lambda":
      if (e.body) collectCsExprUsings(e.body, into, ns);
      return into;
    case "new":
    case "object":
      for (const f of e.fields) collectCsExprUsings(f.value, into, ns);
      return into;
    case "convert":
      return collectCsExprUsings(e.value, into, ns);
    case "match":
      for (const arm of e.arms) {
        collectCsExprUsings(arm.cond, into, ns);
        collectCsExprUsings(arm.value, into, ns);
      }
      if (e.otherwise) collectCsExprUsings(e.otherwise, into, ns);
      return into;
    default:
      // literal | this | id | ref — leaves with no sub-expressions.
      return into;
  }
}

const CS_TARGET: ExprTarget<CsRenderContext> = {
  literal: renderLiteral,
  id: (ctx) => `${ctx.thisName}.${ctx.idAccessor ?? "Id"}`,
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
    const p = escapeCsharpIdent(param);
    if (body !== undefined) return `${p} => ${body}`;
    return `${p} => { /* block-body lambda — not C#-renderable */ }`;
  },
  newPart: renderNew,
  // Bare object literals only appear in e2e contexts; in operation bodies
  // this branch is unreachable (the validator rejects them).
  object: (fields) =>
    `new { ${fields.map((f) => `${upperFirst(f.name)} = ${f.value}`).join(", ")} }`,
  unary: (op, operand) => `${op}${operand}`,
  binary: (left, right, e) => {
    // Self-id vs scalar comparison (`this.id == currentUser.<claim>` — the
    // derived tenancy registry self-scope, Phase 1b).  The entity's `Id` is
    // the strongly-typed `<Agg>Id` record struct, so a raw scalar operand
    // must be lifted into it: same-typed claims wrap directly
    // (`new OrgId(claim)`), a `string` claim against a guid id parses first
    // (`new OrgId(Guid.Parse(claim))`).  Inside an EF query filter the
    // wrapped side references no lambda parameter, so EF funcletizes it into
    // a query parameter and translates the comparison through the id's
    // `HasConversion` — exactly like `GetByIdAsync`'s `x.Id == id`.  Scoped
    // to the aggregate's OWN key (`this.id`) so `<Agg>Id` is guaranteed to
    // exist; id-typed reference FIELDS are untouched.
    if (e.op === "==" || e.op === "!=") {
      const liftedRight = liftScalarToSelfId(e.left, e.right, right);
      if (liftedRight) return `${left} ${e.op} ${liftedRight}`;
      const liftedLeft = liftScalarToSelfId(e.right, e.left, left);
      if (liftedLeft) return `${liftedLeft} ${e.op} ${right}`;
    }
    return `${left} ${e.op} ${right}`;
  },
  ternary: (cond, then, otherwise) => `${cond} ? ${then} : ${otherwise}`,
  convert: (value, e) => renderCsConvert(e.target, e.from, value),
  duration: () => {
    throw new Error("A5: duration not yet implemented on dotnet");
  },
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
  // Variant-`match` (variant-match.md) — C# switch expression over the
  // polymorphic Domain union.  Each variant's carrier is the record
  // `${unionName}_${tag}` (the same `<name>_<Tag>` form a union return
  // constructs), so `${Union}_${tag} b => …` binds the narrowed record and
  // `b.Field` reads it.  A `_` discard arm always trails so a non-exhaustive
  // match (validator *warns*, never errors) stays a total switch expression.
  matchVariant(m) {
    const unmatched = 'throw new System.InvalidOperationException("unmatched variant")';
    // A union-returning repository find reaches .NET as its OPTIONAL TWIN
    // (`Agg?`, see `unionFindAsOptionalTwin`): exactly one non-error success
    // variant (the aggregate) plus error variant(s) that collapse to the
    // absent `null`.  The Domain layer never emits the `<Union>_<Tag>` carrier
    // records for a find union, so a workflow `match` over such a result must
    // switch on the twin natively — an `Agg pattern` arm for the success, `_`
    // for absent — not the DU carriers.  A real polymorphic DU (2+ success
    // variants, whose carrier records ARE emitted) keeps the carrier form.
    const successArms = m.arms.filter((a) => !a.isError);
    const isOptionalTwin = successArms.length === 1 && m.arms.length > successArms.length;
    if (isOptionalTwin) {
      const success = successArms[0]!;
      const binder = success.binding ?? "_unused";
      const errorValue = m.arms.find((a) => a.isError)?.value ?? m.otherwise ?? unmatched;
      return `${m.subject} switch\n    {\n        ${success.variantTypeName} ${binder} => ${success.value},\n        _ => ${errorValue},\n    }`;
    }
    const arms = m.arms.map((a) => {
      const carrier = `${m.unionName}_${a.tag}`;
      const binder = a.binding ?? "_unused";
      return `        ${carrier} ${binder} => ${a.value},`;
    });
    // C# can't prove a polymorphic switch exhaustive, so a discard arm is
    // mandatory.  With an `else`, use it; without one, throw on the
    // (validator-warned) unmatched variant rather than return `null` — which
    // would trip nullable-reference-types under `/warnaserror` for a
    // non-nullable return, and a missed variant *should* fail loudly.
    const tail = `        _ => ${m.otherwise ?? unmatched},`;
    return `${m.subject} switch\n    {\n${arms.join("\n")}\n${tail}\n    }`;
  },
  bindingRefText: (binding) => binding,
  // Union-find repos return `Agg?` (payloads.md §Union finds).
  absenceCheck: (subject) => `${subject} is not null`,
  // List literals are walker-config sugar (e.g. responsive Grid cols).  No
  // .NET render context emits one today; keep total with an array initializer
  // fallback so unexpected uses produce valid C#.
  list: (elements) => `new[] { ${elements.join(", ")} }`,
};

export function renderCsExpr(e: ExprIR, ctx: CsRenderContext = DEFAULT): string {
  return renderExprWith(e, CS_TARGET, ctx);
}

/** When `idSide` is the aggregate's own key (`this.id`, id-typed) and
 *  `scalarSide` is a raw scalar of the id's value type — or a `string`
 *  against a guid id — return the scalar's rendered text lifted into the
 *  strongly-typed `<Agg>Id`; else null (no rewrite). */
function liftScalarToSelfId(
  idSide: ExprIR,
  scalarSide: ExprIR,
  renderedScalar: string,
): string | null {
  const idType = selfIdTypeOf(idSide);
  if (!idType) return null;
  const scalarType = staticScalarTypeOf(scalarSide);
  if (!scalarType) return null;
  if (scalarType === idType.valueType) return `new ${idType.targetName}Id(${renderedScalar})`;
  if (idType.valueType === "guid" && scalarType === "string")
    return `new ${idType.targetName}Id(Guid.Parse(${renderedScalar}))`;
  return null;
}

/** The id TypeIR of a `this.id` member access (the aggregate's own key), or
 *  null for any other shape. */
function selfIdTypeOf(e: ExprIR): Extract<TypeIR, { kind: "id" }> | null {
  if (e.kind === "paren") return selfIdTypeOf(e.inner);
  if (
    e.kind === "member" &&
    e.receiver.kind === "this" &&
    e.member === "id" &&
    e.memberType.kind === "id"
  ) {
    return e.memberType;
  }
  return null;
}

/** The static primitive-type NAME of an expression, when statically known
 *  and primitive (member → memberType, ref → declared type); else null. */
function staticScalarTypeOf(e: ExprIR): string | null {
  if (e.kind === "paren") return staticScalarTypeOf(e.inner);
  const t = e.kind === "member" ? e.memberType : e.kind === "ref" ? e.type : undefined;
  return t?.kind === "primitive" ? t.name : null;
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
    case "let":
    case "lambda":
      // Locals introduced inside the body; escape keyword collisions so the
      // use matches the (also-escaped) binding (`let base` → `@base`).
      return escapeCsharpIdent(e.name);
    case "param":
      return e.name;
    case "this-prop":
    case "this-vo-prop":
    case "this-derived":
      return `${ctx.thisName}.${upperFirst(e.name)}`;
    case "helper-fn":
      return `${ctx.thisName}.${upperFirst(e.name)}`;
    case "workflow-fn":
      // Bare reference to a workflow helper — the static method group on the
      // shared `<Wf>Functions` class.
      return `${upperFirst(e.wfScope!)}Functions.${upperFirst(e.name)}`;
    case "enum-value":
      return `${e.enumName}.${e.name}`;
    case "current-user":
      // Magic identifier for the system's `user { ... }` shape.  The
      // emitter for each per-request context (operation, workflow,
      // view bind) materialises a local / parameter named
      // `currentUser` typed as `User`; this rendering keeps member
      // access (`currentUser.role`) idiomatic on both backends.  In a
      // static EF query-filter lambda no such local exists — `ctx.currentUserExpr`
      // redirects to the ambient accessor the read side already uses.
      return ctx.currentUserExpr ?? "currentUser";
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

// Scalar-intrinsic snippet table (src/util/intrinsics.ts) — one arm per
// catalogue row, keyed `<receiver>.<name>`.  Exported so the intrinsic
// completeness test can pin that every catalogue row has a C# arm.
export const CS_INTRINSIC_RENDERERS: Record<string, (recv: string, args: string[]) => string> = {
  "string.trim": (recv) => `${recv}.Trim()`,
  // Invariant forms — the catalogue contract is culture-free case mapping,
  // and the culture-sensitive ToUpper()/ToLower() trip CA1304/CA1311 under
  // the generated project's /warnaserror.  EF Core (≥9) translates the
  // Invariant forms to SQL upper()/lower(), so the query position keeps
  // working through the same LINQ path (verified via ToQueryString).
  "string.toUpper": (recv) => `${recv}.ToUpperInvariant()`,
  "string.toLower": (recv) => `${recv}.ToLowerInvariant()`,
  // 0-based CLAMPING semantics (JS `slice` — see the catalogue contract):
  // .NET's Substring throws on out-of-range, so guard + Math.Min.  Receiver /
  // arg duplication is safe — Loom expressions are pure.  StringComparison
  // and Math live in `System`, covered by the SDK's <ImplicitUsings>.
  "string.substring": (recv, args) =>
    args.length > 1
      ? `(${args[0]} >= ${recv}.Length ? "" : ${recv}.Substring(${args[0]}, Math.Min(${args[1]}, ${recv}.Length - ${args[0]})))`
      : `(${args[0]} >= ${recv}.Length ? "" : ${recv}.Substring(${args[0]}))`,
  "string.startsWith": (recv, args) => `${recv}.StartsWith(${args[0]}, StringComparison.Ordinal)`,
  "string.endsWith": (recv, args) => `${recv}.EndsWith(${args[0]}, StringComparison.Ordinal)`,
  "string.contains": (recv, args) => `${recv}.Contains(${args[0]}, StringComparison.Ordinal)`,
  "string.replace": (recv, args) => `${recv}.Replace(${args[0]}, ${args[1]})`,
  // Materialized to a List: Loom `string[]` renders as List<T> on this
  // backend, and the collection-op renderer emits the List API (`.Count`,
  // LINQ) — a raw string[] would not compose (CS0428 on `.Count`).
  "string.split": (recv, args) => `${recv}.Split(${args[0]}).ToList()`,
  // ---- numerics (A3 math batch) -------------------------------------------
  // Loom money AND decimal both map to C# `decimal` (money is a bare precise
  // scalar, no currency); int→int, long→long — so the System.Math overloads
  // resolve per receiver with no casts.  `Math` is in `System`, covered by
  // the SDK's <ImplicitUsings>.
  "int.abs": (recv) => `Math.Abs(${recv})`,
  "long.abs": (recv) => `Math.Abs(${recv})`,
  "decimal.abs": (recv) => `Math.Abs(${recv})`,
  "money.abs": (recv) => `Math.Abs(${recv})`,
  // Two-value LEAST/GREATEST (the catalogue contract), not the LINQ
  // aggregates.
  "int.min": (recv, args) => `Math.Min(${recv}, ${args[0]})`,
  "long.min": (recv, args) => `Math.Min(${recv}, ${args[0]})`,
  "decimal.min": (recv, args) => `Math.Min(${recv}, ${args[0]})`,
  "money.min": (recv, args) => `Math.Min(${recv}, ${args[0]})`,
  "int.max": (recv, args) => `Math.Max(${recv}, ${args[0]})`,
  "long.max": (recv, args) => `Math.Max(${recv}, ${args[0]})`,
  "decimal.max": (recv, args) => `Math.Max(${recv}, ${args[0]})`,
  "money.max": (recv, args) => `Math.Max(${recv}, ${args[0]})`,
  // HALF-AWAY-FROM-ZERO ("commercial") rounding per the catalogue contract —
  // .NET's native default is banker's half-even, so the mode is forced.
  // `places` defaults to 0 (the parameterless Math.Round overload).
  "decimal.round": (recv, args) =>
    args.length > 0
      ? `Math.Round(${recv}, ${args[0]}, MidpointRounding.AwayFromZero)`
      : `Math.Round(${recv}, MidpointRounding.AwayFromZero)`,
  "money.round": (recv, args) =>
    args.length > 0
      ? `Math.Round(${recv}, ${args[0]}, MidpointRounding.AwayFromZero)`
      : `Math.Round(${recv}, MidpointRounding.AwayFromZero)`,
  // floor/ceil keep the receiver type (whole-valued decimal, not int) — the
  // decimal overloads of Math.Floor/Ceiling do exactly that.
  "decimal.floor": (recv) => `Math.Floor(${recv})`,
  "money.floor": (recv) => `Math.Floor(${recv})`,
  "decimal.ceil": (recv) => `Math.Ceiling(${recv})`,
  "money.ceil": (recv) => `Math.Ceiling(${recv})`,
};

// EF-query-position overrides (sparse).  EF Core translates ONLY the
// culture-sensitive parameterless ToUpper()/ToLower() to SQL upper()/lower()
// — the Invariant forms throw "could not be translated" (verified against
// EF Core 10 + Npgsql via ToQueryString).  Since the SQL functions are
// culture-free, the semantics stay the catalogue's invariant contract; the
// culture-default C# SPELLING never actually executes.  CA1304/CA1311 are
// NoWarn'd in the generated csproj for exactly this line of code.
export const CS_INTRINSIC_QUERY_RENDERERS: Record<
  string,
  (recv: string, args: string[]) => string
> = {
  "string.toUpper": (recv) => `${recv}.ToUpper()`,
  "string.toLower": (recv) => `${recv}.ToLower()`,
  // The MidpointRounding overloads of Math.Round are NOT translatable — only
  // the bare Math.Round(x) / Math.Round(x, n) forms lower to SQL round()
  // (verified against EF Core 10.0.9 + Npgsql 10.0.2 via ToQueryString).
  // Postgres round(numeric[, n]) is half-away-from-zero already, so the
  // catalogue's commercial-rounding contract holds; the banker's-default C#
  // SPELLING never actually executes.  (Math.Abs/Min/Max/Floor/Ceiling all
  // translate as-is — abs()/LEAST()/GREATEST()/floor()/ceiling() — so no
  // other numeric row needs a query override.)
  "decimal.round": (recv, args) => `Math.Round(${recv}, ${args[0] ?? "0"})`,
  "money.round": (recv, args) => `Math.Round(${recv}, ${args[0] ?? "0"})`,
};

function renderMethodCall(
  recv: string,
  args: string[],
  e: MethodCallExpr,
  ctx: CsRenderContext,
): string {
  // `deep` read level (multi-tenancy Phase 2 P2.4) — descendant-or-self
  // materialized-path scope with the NULL-dataKey fallback to the tenant
  // floor (see `DEEP_SCOPE_SEMANTICS`).  Rendered as a static-expressible EF
  // query-filter lambda: `.StartsWith(...)` translates to SQL LIKE, `== null`
  // to IS NULL — no host call inside the filter (#1676 pattern).
  if (isDeepScopeFilter(e)) {
    const t = ctx.thisName;
    const col = `${t}.${upperFirst(TENANT_OWNED_DATA_KEY_FIELD)}`;
    const tenantCol = `${t}.${upperFirst(TENANT_OWNED_TENANT_ID_FIELD)}`;
    const principal = ctx.currentUserExpr ?? "currentUser";
    // Anchor claim off `args[0]`: `orgPath` for `deep`, `rootOrg` for `global`.
    const org = `${principal}.${upperFirst(deepScopeAnchorClaim(e))}`;
    const tenant = `${principal}.${upperFirst(TENANT_OWNED_TENANT_ID_FIELD)}`;
    const prefix = JSON.stringify(DATA_KEY_PATH_DELIMITER);
    return (
      `((${col} != null && (${col} == ${org} || ${col}.StartsWith(${org} + ${prefix}))) ` +
      `|| (${col} == null && ${tenantCol} == ${tenant}))`
    );
  }
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
  if (e.receiverType.kind === "primitive") {
    const key = intrinsicKey(e.receiverType.name, e.member);
    // EF-translated positions (find/view Where, HasQueryFilter, criteria
    // Specifications) may need a different C# spelling than domain bodies —
    // the sparse query table wins there, falling back to the main table.
    const intrinsic =
      (ctx.efQuery ? CS_INTRINSIC_QUERY_RENDERERS[key] : undefined) ?? CS_INTRINSIC_RENDERERS[key];
    if (intrinsic) return intrinsic(recv, args);
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
    case "workflow-fn":
      // A workflow's own `function` — a `public static` method on the shared
      // `<Wf>Functions` helper class (the workflow body renders into several
      // handler/reactor classes, so a static class avoids a receiver + dupes).
      return `${upperFirst(e.wfScope!)}Functions.${upperFirst(e.name)}(${argList})`;
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
      // A domain-service member call.  A PURE service is a `public static class`,
      // so the call is the static `Pricing.Quote(cart, customer)` (op name
      // PascalCased).  A `reading`-tier service (domain-services.md rev. 4) is a
      // DI'd `sealed class` the orchestrating workflow has INJECTED, so the call
      // routes through the injected receiver and awaits the async method —
      // `await _registration.IsEmailAvailableAsync(holder, cancellationToken)`.
      // `ctx.domainServiceReadingCall` returns the receiver + async method name
      // for a reading op, or undefined for a pure op (→ the static call, which
      // stays byte-identical).  Only the workflow-handler context sets the
      // resolver; everywhere else a pure call is the only shape that can appear.
      const ref = e.serviceRef!;
      const reading = ctx.domainServiceReadingCall?.(ref.service, ref.op);
      if (reading) {
        const ctArg = argList.length > 0 ? `${argList}, cancellationToken` : "cancellationToken";
        return `(await ${reading.receiver}.${reading.method}(${ctArg}))`;
      }
      return `${upperFirst(ref.service)}.${upperFirst(ref.op)}(${argList})`;
    }
    case "repo-read": {
      // A read-only repository query in a `reading` domain-service body
      // (domain-services.md rev. 4, Slice 1).  Renders against the INJECTED
      // repository the service holds — `ctx.repoReadHandle(repo)` resolves the
      // field (`Accounts` → `_accounts`), and the method is the resolved repo
      // method (the .NET method name shape, no re-recognition).  `await`-wrapped
      // in parens so it composes in any expression position (`(await …) == null`,
      // a precondition).  Awaiting plus the `cancellationToken` pass-through makes
      // the enclosing service method async (the declaration emitter wraps the
      // return in Task<…> when ports are present).  Defensive fall-through to a
      // static-shaped call if no handle is wired (validator-unreachable).
      const read = e.repoRead!;
      const handle = ctx.repoReadHandle?.(read.repo);
      if (handle) {
        // A criterion / retrieval read (`find`/`findAll`/`run`) renders against
        // the synthesized `Run<RetrievalName>Async` retrieval method — the same
        // one the workflow `repo-run` uses — so the criterion actually filters
        // the query instead of dropping to the whole-table `All()`.  The token
        // is passed NAMED (an optional `page` sits ahead of it), and a
        // single-result `find` takes `.FirstOrDefault()`.
        if (read.readKind !== "named" && read.retrievalName) {
          const method = `Run${upperFirst(read.retrievalName)}Async`;
          const callArgs =
            argList.length > 0
              ? `${argList}, cancellationToken: cancellationToken`
              : "cancellationToken: cancellationToken";
          const call = `${handle}.${method}(${callArgs})`;
          return read.readKind === "find" ? `(await ${call}).FirstOrDefault()` : `(await ${call})`;
        }
        const method = csRepoReadMethod(read.method, read.readKind);
        const ctArg = argList.length > 0 ? `${argList}, cancellationToken` : "cancellationToken";
        return `(await ${handle}.${method}(${ctArg}))`;
      }
      return `${upperFirst(e.name)}(${argList})`;
    }
    case "action":
    // Sibling action call (Proposal A Stage 1) — frontend-only; never lowered
    // into a backend domain expression.  Plain call keeps the switch total.
    case "store-action":
    // `<Store>.<action>()` call (Stage 5) — frontend-only; plain-call fall-through.
    case "free":
      return `${upperFirst(e.name)}(${argList})`;
  }
}

/** The .NET repository method name a `repo-read` (`callKind: "repo-read"`) in a
 *  `reading` domain-service body resolves to (domain-services.md rev. 4, Slice 1).
 *  Mirrors the names the repository emitter generates:
 *   - a named `getById` read → `GetByIdAsync` (the built-in load-or-null, which
 *     carries the `Async` suffix, like the workflow `repoLet`);
 *   - the auto-`findAll` (`readKind: "findAll"`) → `All` (the enriched find named
 *     `all`, PascalCased — no `Async` suffix, like every declared find);
 *   - any other named declared `find` (`byHolder`, …) → `<UpperFirst>` (declared
 *     finds get no `Async` suffix — `Task<Account?> ByHolder(...)`).
 *  The `find`/`run` criterion/retrieval forms are not part of the reading-tier
 *  Slice-1 surface (the validator-admitted bodies use named finds); they fall
 *  back to the PascalCased verb so the switch stays total. */
function csRepoReadMethod(method: string, readKind: string): string {
  if (readKind === "named") {
    return method === "getById" ? "GetByIdAsync" : upperFirst(method);
  }
  if (readKind === "findAll") return "All";
  return upperFirst(method);
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
        case "duration":
          // A5: duration not yet implemented on dotnet — expression-only
          // primitive; never a field / wire type in this slice.
          throw new Error("A5: duration not yet implemented on dotnet");
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
