import { diagMessage } from "../../diagnostics/messages.js";
import { unionInstanceName, variantTag } from "../../ir/stdlib/unions.js";
import type { ExprIR, LiteralKind } from "../../ir/types/loom-ir.js";
import type { OriginRef } from "../../ir/types/origin.js";

// ---------------------------------------------------------------------------
// Shared ExprIR dispatch — the `ExprTarget` contract.
//
// All five domain-logic backends (TypeScript / .NET / Phoenix LiveView /
// Python / Java) render the *same* fully-resolved Loom `ExprIR` to source.
// The 17-arm `kind` dispatch and **all** recursion into sub-expressions are
// identical across backends — only the leaves diverge (operator spelling,
// name casing, money arithmetic, collection-op shape, `refColl.contains`
// membership, regex, `ref` role, `callKind` call syntax).
//
// `renderExprWith` owns the dispatch + recursion once; an `ExprTarget`
// supplies the per-backend leaves.  Sub-expressions are rendered here and
// handed to the target as already-rendered strings, so a target method is a
// pure leaf-formatter — it never recurses.  The few arms that branch on the
// raw node (member array-length, method-call membership/regex, binary money,
// callKind / refKind tables) also receive the original IR node.
//
// Mirrors the body-walker's `WalkerTarget` extraction (src/generator/_walker/
// target.ts).  Adding a backend = one target table, not a sixth dispatcher;
// adding an `ExprIR.kind` = one arm here + one method on the interface (the
// exhaustive switch makes both fail to type-check until done).
// ---------------------------------------------------------------------------

/**
 * Minimum render context: every backend names the implicit receiver.
 *
 * `matchBindings` is the variant-`match` binding side-channel (variant-match.md):
 * while `renderExprWith` recurses into a variant arm's `value`, it maps each
 * in-scope binding name to the text that a `refKind: "match-binding"` ref to
 * that name must render as.  A native-pattern backend (.NET / Java / Elixir /
 * Python) sets the text to the binding identifier (it introduces a real bound
 * variable); the TS backend, which has no expression-level pattern binding,
 * sets it to the subject text (the binding is an *alias* of the scrutinee).
 * The `ref` leaf reads this map for a match-binding ref instead of formatting
 * the bare name.  Undefined / empty outside a variant arm.
 */
export type ExprCtxBase = { thisName: string; matchBindings?: ReadonlyMap<string, string> };

export type RefExpr = Extract<ExprIR, { kind: "ref" }>;
export type MemberExpr = Extract<ExprIR, { kind: "member" }>;
export type MethodCallExpr = Extract<ExprIR, { kind: "method-call" }>;
export type CallExpr = Extract<ExprIR, { kind: "call" }>;
export type LambdaExpr = Extract<ExprIR, { kind: "lambda" }>;
export type NewExpr = Extract<ExprIR, { kind: "new" }>;
export type ObjectExpr = Extract<ExprIR, { kind: "object" }>;
export type UnaryExpr = Extract<ExprIR, { kind: "unary" }>;
export type BinaryExpr = Extract<ExprIR, { kind: "binary" }>;
export type ConvertExpr = Extract<ExprIR, { kind: "convert" }>;
export type DurationExpr = Extract<ExprIR, { kind: "duration" }>;

/** True when a binary node is an integer division that widened to `decimal`
 *  (`int / int`, `int / long`, `long / long`) — BOTH operands integral, result
 *  `decimal`.  The type system widens `/` on integers to `decimal` (5 / 2 =
 *  2.5), so backends whose integer `/` truncates (.NET, Java) or whose native
 *  `/` yields a bare float rather than the decimal representation (Elixir) must
 *  emit real decimal division here, casting/boxing the integral operands.
 *  A mixed `int / decimal` is NOT matched (its decimal operand is already
 *  fractional and must not be re-wrapped). */
export function isIntDivWidenedToDecimal(e: BinaryExpr): boolean {
  if (e.op !== "/") return false;
  if (e.resultType?.kind !== "primitive" || e.resultType.name !== "decimal") return false;
  const integral = (t: BinaryExpr["leftType"]): boolean =>
    t?.kind === "primitive" && (t.name === "int" || t.name === "long");
  return integral(e.leftType) && integral(e.rightType);
}

/** A `name: value` pair with `value` already rendered (object / new fields). */
export interface RenderedField {
  name: string;
  value: string;
}

/** A boolean-form `cond -> value` match arm with both sides already rendered. */
export interface RenderedArm {
  cond: string;
  value: string;
}

/**
 * A variant-form match arm with its `value` already rendered (variant-match.md).
 * Each leaf formats its native discriminated-dispatch construct from these:
 *   - `tag` — the wire discriminator value (`variantTag(varType)`), e.g. the
 *     `subject.type === "<tag>"` comparand (TS) or the JSON `type` field.
 *   - `variantTypeName` — the variant's source-level type name (e.g. `Order`),
 *     for native pattern syntax (`Order o` / `%Order{}` / `case Order`).
 *   - `binding` — the bound variable name, or `undefined` if the arm bound
 *     none (`NotFound => x`).  Native backends emit a real binding; TS aliases
 *     it to the subject (see `ExprCtxBase.matchBindings`), so `binding` may be
 *     ignored by TS.
 *   - `value` — the already-rendered arm body (rendered with the binding's
 *     ref-text installed in `ctx.matchBindings`, so a reference to the binding
 *     came out correct for this backend).
 */
export interface RenderedVariantArm {
  tag: string;
  variantTypeName: string;
  binding: string | undefined;
  value: string;
  /** True when this variant is an `error` payload.  Only the Elixir backend's
   *  asymmetric `{:ok,…}` / `{:error, tag, …}` tuple `case` reads it; the other
   *  backends tag every variant uniformly and ignore it. */
  isError: boolean;
}

/** All of a variant-`match`'s rendered pieces handed to `ExprTarget.matchVariant`. */
export interface RenderedVariantMatch {
  /** The already-rendered scrutinee (a simple ref/let read — side-effect-free). */
  subject: string;
  arms: RenderedVariantArm[];
  /** The rendered `else => …` catch-all, or `undefined` when absent. */
  otherwise: string | undefined;
  /** The union's instance name (`unionInstanceName(subjectType.variants)`),
   *  e.g. `AOrNF`.  Nominally-typed backends (Java/.NET) build a variant's
   *  concrete carrier type as `${unionName}_${tag}` for a native pattern
   *  (`case AOrNF_A a -> …`); structural/dynamic backends (TS/Python/Elixir)
   *  ignore it and dispatch on the `type` tag.  Empty when the subject type
   *  did not resolve to a union (a validator error path). */
  unionName: string;
}

/**
 * Per-backend leaf formatters for the 17 `ExprIR.kind` arms.  Sub-expressions
 * arrive already rendered; the raw node is passed only where a leaf branches
 * on it.  `paren` and `this` are not on the interface — they are byte-identical
 * across backends and handled directly in `renderExprWith`.
 */
export interface ExprTarget<Ctx extends ExprCtxBase> {
  literal(lit: LiteralKind, value: string): string;
  id(ctx: Ctx): string;
  ref(e: RefExpr, ctx: Ctx): string;
  member(recv: string, e: MemberExpr, ctx: Ctx): string;
  methodCall(recv: string, args: string[], e: MethodCallExpr, ctx: Ctx): string;
  call(args: string[], e: CallExpr, ctx: Ctx): string;
  /** Render a `callKind: "domain-service"` member call
   *  (`Pricing.quote(cart, customer)` → the backend's call syntax for the
   *  generated domain-service module).  `serviceRef` is the resolved
   *  `{ service, op }`; `args` arrive already rendered.  Per-backend leaf —
   *  each backend's `call` switch delegates here (domain-services.md). */
  domainServiceCall(args: string[], serviceRef: { service: string; op: string }, ctx: Ctx): string;
  lambda(param: string, body: string | undefined): string;
  newPart(fields: RenderedField[], e: NewExpr, ctx: Ctx): string;
  object(fields: RenderedField[]): string;
  unary(op: UnaryExpr["op"], operand: string, e: UnaryExpr): string;
  binary(left: string, right: string, e: BinaryExpr): string;
  ternary(cond: string, then: string, otherwise: string): string;
  convert(value: string, e: ConvertExpr): string;
  /** Duration constructor `days(n)`/`hours(n)`/`minutes(n)` (A5 temporal) —
   *  render the backend's ABSOLUTE-duration value from the already-rendered
   *  `amount`.  Every unit has a fixed millisecond width, so each backend
   *  renders one uniform absolute-span value (JS ms-number, .NET `TimeSpan`,
   *  java `Duration`, python `timedelta`, Elixir ms-integer) with no calendar
   *  arithmetic.  Calendar-relative offsets (`months`/`years`) are not part
   *  of `duration`. */
  duration(unit: DurationExpr["unit"], amount: string, e: DurationExpr, ctx: Ctx): string;
  /** i18n ICU format wrapper (M-T1.11) — INERT on every domain-logic backend.
   *  The wrapped `inner` arrives already rendered; each backend returns it
   *  verbatim, so a formatted template hole (`{total, number, ::currency/USD}`)
   *  emits byte-identical to a format-less one (the format is dropped). The
   *  suffix only comes alive on the JS/TS frontends' translation runtime. */
  i18nFormat(inner: string): string;
  /** Boolean predicate-arms `match { cond => value }` — the original form,
   *  unchanged.  Lowered to the backend's chained-conditional idiom. */
  match(arms: RenderedArm[], otherwise: string | undefined): string;
  /** Variant-`match SUBJECT { Type binding => value }` (variant-match.md) —
   *  the backend's native discriminated dispatch (TS discriminated-union
   *  conditional on `subject.type`; C#/Java `switch` expression; Elixir `case`;
   *  Python isinstance/match).  Arms arrive structured + pre-rendered so each
   *  leaf formats natively without re-resolving the variant set. */
  matchVariant(m: RenderedVariantMatch): string;
  /** The text a `refKind: "match-binding"` ref to `binding` renders as inside
   *  this arm's value.  Native-pattern backends return `binding` (a real bound
   *  variable); the TS backend returns `subject` (the binding is an alias of
   *  the scrutinee — TS has no expression-level pattern binding).  Called by
   *  `renderExprWith` to populate `ctx.matchBindings` before recursing. */
  bindingRefText(binding: string, subject: string): string;
  /** Presence test for an absence-shaped union-find subject
   *  (`subjectShape: "absence"`, payloads.md §Union finds) — the runtime
   *  value is the bare aggregate-or-absent, so the variant match renders as
   *  `ternary(absenceCheck(subject), successArm, errorArm)`.  Must be the
   *  backend's *lint-clean* nil test (Python `is not None`, C# `is not null`,
   *  Elixir `!= nil`, TS `!== null`, Java `!= null`). */
  absenceCheck(subject: string): string;
  list(elements: string[]): string;
}

/** Source-level type name of a variant arm's `varType` — the comparand for a
 *  native pattern (`Order o`, `%Order{}`, `case Order`).  Named carriers
 *  (entity / value object / enum) expose their declared `name`; everything else
 *  falls back to the wire tag (the v1 variant set is named carriers in
 *  practice — see the `loom.match-unknown-variant` gate). */
function variantTypeName(a: Extract<ExprIR, { kind: "match" }>["variantArms"][number]): string {
  const t = a.varType;
  if (t.kind === "entity" || t.kind === "valueobject" || t.kind === "enum") return t.name;
  return variantTag(t);
}

/**
 * Dispatch a resolved `ExprIR` through a backend's `ExprTarget`.  Owns the
 * full 17-arm switch and all recursion; the exhaustive switch makes a new
 * `kind` a compile error until handled.
 */
export function renderExprWith<Ctx extends ExprCtxBase>(
  e: ExprIR,
  t: ExprTarget<Ctx>,
  ctx: Ctx,
): string {
  const r = (x: ExprIR): string => renderExprWith(x, t, ctx);
  switch (e.kind) {
    case "literal":
      return t.literal(e.lit, e.value);
    case "this":
      return ctx.thisName;
    case "id":
      return t.id(ctx);
    case "ref":
      return t.ref(e, ctx);
    case "member":
      return t.member(r(e.receiver), e, ctx);
    case "method-call":
      return t.methodCall(r(e.receiver), e.args.map(r), e, ctx);
    case "call":
      return t.call(e.args.map(r), e, ctx);
    case "lambda":
      return t.lambda(e.param, e.body ? r(e.body) : undefined);
    case "new":
      return t.newPart(
        e.fields.map((f) => ({ name: f.name, value: r(f.value) })),
        e,
        ctx,
      );
    case "object":
      return t.object(e.fields.map((f) => ({ name: f.name, value: r(f.value) })));
    case "paren":
      return `(${r(e.inner)})`;
    case "unary":
      return t.unary(e.op, r(e.operand), e);
    case "binary":
      return t.binary(r(e.left), r(e.right), e);
    case "ternary":
      return t.ternary(r(e.cond), r(e.then), r(e.otherwise));
    case "convert":
      return t.convert(r(e.value), e);
    case "duration":
      return t.duration(e.unit, r(e.amount), e, ctx);
    case "i18nFormat":
      // Transparent i18n wrapper — render the wrapped operand and drop the
      // format (inert on every backend; only the frontends' i18n runtime uses it).
      return t.i18nFormat(r(e.inner));
    case "match": {
      // Variant form (variant-match.md) when a subject is present.
      if (e.subject) {
        const subject = r(e.subject);
        // Absence-shaped subject (a repository union-find result,
        // `subjectShape: "absence"`): the runtime value is the bare
        // aggregate-or-absent — a discriminator probe / native type switch
        // would test vocabulary that doesn't exist at runtime.  Render a
        // presence check instead: success arm on present (its binding is an
        // alias of the subject on EVERY backend — there is no separate
        // variant carrier to bind), error/`none` arm (or `otherwise`) on
        // absent.  The validator pins the shape to exactly one aggregate
        // variant plus one error/`none` variant.
        if (e.subjectShape === "absence") {
          const isFailureArm = (a: (typeof e.variantArms)[number]) =>
            a.isError === true || a.varType.kind === "none";
          const successArm = e.variantArms.find((a) => !isFailureArm(a));
          const failureArm = e.variantArms.find(isFailureArm);
          // Arm bindings were aliased to the (narrowed) subject at lowering
          // (Env.refAliases), so arm values render with the plain ctx.
          const fallback = e.otherwise ? r(e.otherwise) : undefined;
          // A missing side without an `otherwise` is a non-exhaustive match
          // the validator already warns on; degrade to the subject text so
          // the output stays well-formed.
          const onPresent = successArm ? r(successArm.value) : (fallback ?? subject);
          const onAbsent = failureArm ? r(failureArm.value) : (fallback ?? subject);
          return t.ternary(t.absenceCheck(subject), onPresent, onAbsent);
        }
        const arms = e.variantArms.map((a) => {
          // Install the binding side-channel before rendering this arm's
          // value, so a `refKind: "match-binding"` ref to `a.binding`
          // renders as the backend's binding text.  `bindingRefText`
          // lets a backend swap the alias (TS → subject) for the real
          // bound identifier (native backends → the binding name).
          const bindingText = a.binding ? t.bindingRefText(a.binding, subject) : undefined;
          // EXTEND the inherited map, never replace it: `match` nests, and an
          // inner arm may read an OUTER arm's binding.  A fresh single-entry
          // map dropped every enclosing binding, so that read fell back to the
          // bare `.ddd` name — an identifier the target never declares (TS2304
          // and its per-backend twins).  Native-pattern backends escaped only
          // by coincidence, because their bound name IS the source name.
          const armCtx: Ctx =
            a.binding && bindingText !== undefined
              ? {
                  ...ctx,
                  matchBindings: new Map([...(ctx.matchBindings ?? []), [a.binding, bindingText]]),
                }
              : ctx;
          return {
            tag: variantTag(a.varType),
            variantTypeName: variantTypeName(a),
            binding: a.binding,
            value: renderExprWith(a.value, t, armCtx),
            isError: a.isError ?? false,
          };
        });
        return t.matchVariant({
          subject,
          arms,
          otherwise: e.otherwise ? r(e.otherwise) : undefined,
          unionName:
            e.subjectType?.kind === "union" ? unionInstanceName(e.subjectType.variants) : "",
        });
      }
      return t.match(
        e.arms.map((a) => ({ cond: r(a.cond), value: r(a.value) })),
        e.otherwise ? r(e.otherwise) : undefined,
      );
    }
    case "list":
      return t.list(e.elements.map(r));
    case "action-ref":
      // A named page/component action reference is a UI-handler-arg form
      // (named-actions-and-stores.md, Proposal A Stage 1).  It is consumed by
      // the JSX walker's call-site primitives, never by a domain-logic
      // expression renderer — reaching it here means it leaked to a domain
      // position, which the IR validator should already have rejected.
      throw new Error("renderExprWith: 'action-ref' is not a domain expression");
    case "authz-filter":
      // An authorization/tenancy filter sentinel (M-T9.9).  It lives ONLY in an
      // aggregate's context/write-scope filters and every backend's query-filter
      // translator special-cases it (`isDenyFilter` / `isDeepScopeFilter`)
      // BEFORE reaching this generic dispatch — so reaching it here means a
      // backend's filter translator forgot the sentinel arms.  Throw LOUDLY
      // (a codegen crash) rather than fall through to a wrong render: a silently
      // mis-rendered auth filter is a cross-tenant leak / authorization bypass.
      throw new Error(
        "renderExprWith: 'authz-filter' must be handled by the backend's query-filter translator, not the generic expression dispatcher",
      );
  }
}

// ---------------------------------------------------------------------------
// Emission mode (§F2, Wave 2 packet 2.4) — a declared vocabulary for the
// QUERY-LANGUAGE renderers.
//
// The `ExprTarget` above is the DOMAIN-LOGIC contract: a general-purpose host
// language accepting the full `ExprIR` surface (that is what the 17-arm
// switch in `renderExprWith` is for).  A second family of renderers is much
// narrower — `java/render-jpql.ts` (JPQL, a foreign query-string language),
// `sql-pg-expr.ts` (raw Postgres SQL, migration backfills),
// `dotnet/emit/dapper.ts` `whereToSql` (raw Postgres SQL again, hand-rolled),
// `python/find-predicate.ts` `lowerToSqlAlchemy` (SQLAlchemy Core's operator
// vocabulary, distinct from plain Python `renderPyExpr`), and
// `typescript/repository-find-predicate.ts` `lowerToDrizzle` (Drizzle's
// function-call operator vocabulary, distinct from plain TS) each translate a
// NARROW, validator-gated subset of `ExprIR` into their target query
// language.  Two more backends reuse the FULL domain-logic `ExprTarget`
// itself for query positions rather than a separate narrow renderer —
// dotnet's `CsRenderContext.efQuery` flag (EF Core LINQ translates nearly the
// whole C# surface the domain-logic target already emits) and Elixir's Ecto
// `where:` fragments (Ecto queries are themselves valid Elixir syntax, so the
// same `ELIXIR_TARGET` table serves both) — their `QueryEmissionMode`
// vocabulary is deliberately the FULL kind set (see `ALL_EXPR_KINDS` below);
// what narrows them is the IR-validate-phase `firstNonQueryableNode` gate,
// not a renderer-level refusal.
//
// Each such renderer used to decide "is this construct in my vocabulary" with
// its own per-arm `if`/`default: throw new Error(...)`, undeclared anywhere
// outside that renderer's own source (the java `principalAccessors` branch
// this packet was named for is one instance of the pattern, not the only
// one).  `QueryEmissionMode` names each renderer's target sub-language;
// `QUERY_EMISSION_VOCABULARY` declares, ONCE, which `ExprIR.kind`s each mode
// accepts; and `refuseOutOfVocabulary` is the one place that turns "this
// construct isn't in my vocabulary" into a coded `loom.*` refusal instead of
// a bare, ad hoc `Error`.
//
// The IR validator (`firstNonQueryableNode` and its per-backend callers) is
// what actually keeps an ordinary `.ddd` program off this path — reaching a
// refusal is a validator gap or a compiler bug, never a user mistake, which
// is why the diagnostic carries the `-invalid` suffix (deliberately refused,
// not a `-unsupported` backlog item — see the classification note atop
// `src/diagnostics/unsupported-register.ts`).
//
// `test/generator/_expr/emission-mode.test.ts` is the completeness gate: a
// CENSUS confirms every query-language renderer in `QUERY_EMISSION_RENDERERS`
// references `refuseOutOfVocabulary` with its declared mode (an undeclared
// one fails naming file:line), and a VOCABULARY suite pins each mode's
// accepted `kinds` and asserts every kind outside it is refused.
// ---------------------------------------------------------------------------

/** Every `ExprIR.kind` a DOMAIN-LOGIC position accepts — the full set
 *  `renderExprWith` dispatches, minus `action-ref` (a UI-only marker that is
 *  never valid in a domain expression — see the `renderExprWith` arm above).
 *  The two query-language modes that reuse the full domain-logic target for
 *  query positions (dotnet LINQ, Elixir Ecto) vocabulary to this whole set. */
export const ALL_EXPR_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "literal",
  "this",
  "id",
  "ref",
  "member",
  "method-call",
  "call",
  "lambda",
  "new",
  "object",
  "paren",
  "unary",
  "binary",
  "ternary",
  "convert",
  "duration",
  "i18nFormat",
  "match",
  "list",
  "authz-filter",
]);

export const QUERY_EMISSION_MODES = [
  /** Spring Data `@Query` JPQL — `currentUser.<claim>` reads render as a
   *  SpEL bean expression (`:#{@currentUserAccessor.user()?.<claim>()}`). */
  "jpql-spring-data",
  /** Raw `EntityManager.createQuery(jpql)` — no SpEL layer, so
   *  `currentUser.<claim>` reads instead render as a plain `:name` bind
   *  parameter the caller `setParameter`s off `JpqlCtx.principalAccessors`. */
  "jpql-entity-manager",
  /** `sql-pg-expr.ts` — a `migration` block's `backfillColumn` scalar SQL. */
  "sql-postgres-migration",
  /** dotnet `emit/dapper.ts` `whereToSql` — hand-rolled raw Postgres SQL for
   *  the `persistence: dapper` adapter's finds/retrievals/criteria. */
  "sql-dapper",
  /** dotnet EF Core LINQ (`CsRenderContext.efQuery`) — reuses the full
   *  domain-logic `CS_TARGET_EF`; vocabulary is `ALL_EXPR_KINDS`. */
  "linq-efcore",
  /** python `find-predicate.ts` `lowerToSqlAlchemy` / the workflow and
   *  projection-filter siblings in the same file — SQLAlchemy Core's
   *  operator-overload vocabulary. */
  "sqlalchemy-filter",
  /** node `repository-find-predicate.ts` `lowerToDrizzle` — Drizzle's
   *  function-call operator vocabulary (`eq`/`and`/`or`/…). */
  "drizzle-predicate",
  /** Elixir Ecto `where:` fragments — reuses the full domain-logic
   *  `ELIXIR_TARGET`/`renderExpr` (Ecto queries are valid Elixir syntax);
   *  vocabulary is `ALL_EXPR_KINDS`. */
  "ecto-fragment",
] as const;

export type QueryEmissionMode = (typeof QUERY_EMISSION_MODES)[number];

/** The vocabulary one `QueryEmissionMode` accepts: which top-level
 *  `ExprIR.kind` arms the renderer implements.  A construct whose `kind` is
 *  outside this set is out of vocabulary for the mode and must be refused
 *  (see `refuseOutOfVocabulary`) rather than silently falling through to a
 *  general renderer that emits something that compiles nowhere. */
export interface EmissionVocabulary {
  kinds: ReadonlySet<ExprIR["kind"]>;
}

/** JPQL's vocabulary (`java/render-jpql.ts`'s `render` switch): literal /
 *  this / id / ref / member / paren / unary / binary / authz-filter /
 *  method-call (membership + queryable scalar intrinsics only — see
 *  `JPQL_INTRINSIC_SQL`).  Identical for both JPQL sub-modes; they diverge
 *  only in HOW a `currentUser.<claim>` member renders, not in which `kind`s
 *  are accepted. */
const JPQL_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "literal",
  "this",
  "id",
  "ref",
  "member",
  "paren",
  "unary",
  "binary",
  "authz-filter",
  "method-call",
]);

/** `sql-pg-expr.ts`'s `renderSqlScalarExpr` switch. */
const SQL_MIGRATION_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "literal",
  "ref",
  "paren",
  "unary",
  "binary",
  "ternary",
]);

/** dotnet `emit/dapper.ts`'s `whereToSql` switch. */
const SQL_DAPPER_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "paren",
  "unary",
  "binary",
  "method-call",
  "member",
  "ref",
  "authz-filter",
  "literal",
]);

/** python `find-predicate.ts`'s `lower` switch (the shape `lowerToSqlAlchemy`
 *  / `lowerWorkflowFilterToSqlAlchemy` / `lowerProjectionFilterToSqlAlchemy`
 *  all recurse through). */
const SQLALCHEMY_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "literal",
  "this",
  "id",
  "ref",
  "member",
  "paren",
  "unary",
  "binary",
  "authz-filter",
  "method-call",
]);

/** node `repository-find-predicate.ts`'s `lowerToDrizzle` switch. */
const DRIZZLE_KINDS: ReadonlySet<ExprIR["kind"]> = new Set([
  "literal",
  "this",
  "id",
  "ref",
  "member",
  "paren",
  "unary",
  "binary",
  "authz-filter",
  "method-call",
]);

export const QUERY_EMISSION_VOCABULARY: Record<QueryEmissionMode, EmissionVocabulary> = {
  "jpql-spring-data": { kinds: JPQL_KINDS },
  "jpql-entity-manager": { kinds: JPQL_KINDS },
  "sql-postgres-migration": { kinds: SQL_MIGRATION_KINDS },
  "sql-dapper": { kinds: SQL_DAPPER_KINDS },
  "linq-efcore": { kinds: ALL_EXPR_KINDS },
  "sqlalchemy-filter": { kinds: SQLALCHEMY_KINDS },
  "drizzle-predicate": { kinds: DRIZZLE_KINDS },
  "ecto-fragment": { kinds: ALL_EXPR_KINDS },
};

/** A construct outside its `QueryEmissionMode`'s declared vocabulary reached
 *  a query-language renderer.  Carries the `loom.query-emission-invalid`
 *  code (its wording lives in `src/diagnostics/messages.ts`) — the
 *  `-invalid` suffix marks it "deliberately refused", not `-unsupported`
 *  backlog work: `firstNonQueryableNode` (or a backend-specific queryable
 *  gate) is what keeps a valid `.ddd` program off this path, so reaching it
 *  is a validator gap or a compiler bug, never a user mistake. */
export class QueryEmissionRefusal extends Error {
  readonly code = "loom.query-emission-invalid" as const;
  readonly mode: QueryEmissionMode;
  readonly what: string;
  constructor(mode: QueryEmissionMode, what: string) {
    super(diagMessage("loom.query-emission-invalid", { mode, what }));
    this.name = "QueryEmissionRefusal";
    this.mode = mode;
    this.what = what;
  }
}

/** The one place every query-language renderer's `default:` / unsupported
 *  fallback routes through.  `what` is free text describing the offending
 *  construct (e.g. `` expression kind 'call' `` or `` method call 'foo' ``),
 *  matching the wording each renderer already threw by hand. */
export function refuseOutOfVocabulary(mode: QueryEmissionMode, what: string): never {
  throw new QueryEmissionRefusal(mode, what);
}

// ---------------------------------------------------------------------------
// Span-tracking emission — the marks-carrying twin of `renderExprWith`
// (docs/old/plans/span-tracking-emission.md).
//
// LEVEL-WISE ANCHORING: `renderExprWith` already renders every child via its
// local `r` BEFORE handing the child STRINGS to the leaf method, so the
// dispatcher holds both each child's rendered text and the leaf's composed
// output at the same point.  `renderExprWithMarks` mirrors that exact
// recursion, but each step returns `{ text, marks }` instead of a bare
// string: a child's already-anchored marks are re-anchored into the parent's
// composed text by locating the child's TEXT inside it (the same
// exact-text-search discipline `SourceMapRecorder.fragment` already uses) —
// if the text occurs EXACTLY ONCE, the child's marks shift by the found
// offset; if it occurs zero or more-than-once, that child's marks are
// skipped (honest — a non-unique anchor is a guess, not a fact).  Because
// this happens ONE LEVEL AT A TIME, same-text SIBLINGS (`a + a`) skip at
// their shared parent while a DEEPER repeat two levels down (`count > 0 &&
// count < max`, where `count` repeats but each occurrence is already
// resolved within its own comparison's text one level up) still resolves —
// the fragment() discipline applied one level finer.
//
// Every node also contributes its OWN mark — `{ start: 0, end: text.length,
// origin: e.origin }` — appended AFTER the (already-shifted) child marks, so
// a consumer that wants the most specific mark covering a position prefers
// the narrowest one it can find (same "narrowest wins" rule
// `narrowestRegion` already applies at line granularity in
// src/system/sourcemap-v3.ts).
//
// Leaves are untouched: every `ExprTarget` method is called with plain
// strings exactly as `renderExprWith` calls it today, so a backend's target
// table needs no changes to support this.  `renderExprWith` itself is also
// untouched — this is a parallel entry a caller opts into only when a
// `SourceMapRecorder` is actually threaded in (the TS aggregate op-body loop);
// the flag-off path never calls this function and pays no extra allocation.
// ---------------------------------------------------------------------------

/** One mark discovered while composing an expression's rendered text —
 *  `start`/`end` are 0-based, end-exclusive offsets RELATIVE to the owning
 *  `MarkedText.text` (never absolute file offsets; a caller anchors this
 *  text into its own larger context, same as `SourceMapRecorder.fragment`
 *  anchors a whole rendered fragment into a file's final content). */
export interface ExprMark {
  start: number;
  end: number;
  origin: OriginRef;
}

/** An expression's rendered text plus every mark discovered while composing
 *  it — its own node's mark (when `origin` is present) and, recursively, its
 *  children's marks re-anchored into this text.  Marks are NOT sorted or
 *  deduplicated — narrowest-first callers should look at end-start width
 *  themselves, same as `narrowestRegion`. */
export interface MarkedText {
  text: string;
  marks: ExprMark[];
}

/** Locate `child`'s text inside the already-composed `composed` text and
 *  shift its marks by the (unique) match offset.  Empty text or a
 *  zero-mark child short-circuits (nothing to anchor); an absent or
 *  ambiguous (>1 occurrence) match is an honest skip, not a guess. */
function anchorChild(child: MarkedText, composed: string): ExprMark[] {
  if (child.marks.length === 0 || child.text.length === 0) return [];
  const first = composed.indexOf(child.text);
  if (first === -1) return [];
  if (composed.indexOf(child.text, first + 1) !== -1) return [];
  return child.marks.map((m) => ({ start: m.start + first, end: m.end + first, origin: m.origin }));
}

/**
 * Dispatch a resolved `ExprIR` through a backend's `ExprTarget`, exactly as
 * `renderExprWith` does, but additionally composing the marks described
 * above.  Mirrors the 17-arm switch (including the variant-`match` /
 * absence-shape branches) so it stays a drop-in alternative entry — a
 * caller picks this OR `renderExprWith`, never both, per render.
 */
export function renderExprWithMarks<Ctx extends ExprCtxBase>(
  e: ExprIR,
  t: ExprTarget<Ctx>,
  ctx: Ctx,
): MarkedText {
  const rm = (x: ExprIR): MarkedText => renderExprWithMarks(x, t, ctx);
  // Compose this node's own result: anchor every child's marks into `text`
  // (in child order), then append this node's own whole-text mark.
  const compose = (text: string, children: readonly MarkedText[]): MarkedText => {
    const childMarks = children.flatMap((c) => anchorChild(c, text));
    const ownMarks: ExprMark[] = e.origin ? [{ start: 0, end: text.length, origin: e.origin }] : [];
    return { text, marks: [...childMarks, ...ownMarks] };
  };
  switch (e.kind) {
    case "literal":
      return compose(t.literal(e.lit, e.value), []);
    case "this":
      return compose(ctx.thisName, []);
    case "id":
      return compose(t.id(ctx), []);
    case "ref":
      return compose(t.ref(e, ctx), []);
    case "member": {
      const recv = rm(e.receiver);
      return compose(t.member(recv.text, e, ctx), [recv]);
    }
    case "method-call": {
      const recv = rm(e.receiver);
      const args = e.args.map(rm);
      return compose(
        t.methodCall(
          recv.text,
          args.map((a) => a.text),
          e,
          ctx,
        ),
        [recv, ...args],
      );
    }
    case "call": {
      const args = e.args.map(rm);
      return compose(
        t.call(
          args.map((a) => a.text),
          e,
          ctx,
        ),
        args,
      );
    }
    case "lambda": {
      const body = e.body ? rm(e.body) : undefined;
      return compose(t.lambda(e.param, body?.text), body ? [body] : []);
    }
    case "new": {
      const fields = e.fields.map((f) => ({ name: f.name, value: rm(f.value) }));
      return compose(
        t.newPart(
          fields.map((f) => ({ name: f.name, value: f.value.text })),
          e,
          ctx,
        ),
        fields.map((f) => f.value),
      );
    }
    case "object": {
      const fields = e.fields.map((f) => ({ name: f.name, value: rm(f.value) }));
      return compose(
        t.object(fields.map((f) => ({ name: f.name, value: f.value.text }))),
        fields.map((f) => f.value),
      );
    }
    case "paren": {
      const inner = rm(e.inner);
      return compose(`(${inner.text})`, [inner]);
    }
    case "unary": {
      const operand = rm(e.operand);
      return compose(t.unary(e.op, operand.text, e), [operand]);
    }
    case "binary": {
      const left = rm(e.left);
      const right = rm(e.right);
      return compose(t.binary(left.text, right.text, e), [left, right]);
    }
    case "ternary": {
      const cond = rm(e.cond);
      const then = rm(e.then);
      const otherwise = rm(e.otherwise);
      return compose(t.ternary(cond.text, then.text, otherwise.text), [cond, then, otherwise]);
    }
    case "convert": {
      const value = rm(e.value);
      return compose(t.convert(value.text, e), [value]);
    }
    case "duration": {
      const amount = rm(e.amount);
      return compose(t.duration(e.unit, amount.text, e, ctx), [amount]);
    }
    case "i18nFormat": {
      // Transparent — render the wrapped operand, drop the format.
      const inner = rm(e.inner);
      return compose(t.i18nFormat(inner.text), [inner]);
    }
    case "match": {
      if (e.subject) {
        const subject = rm(e.subject);
        if (e.subjectShape === "absence") {
          const isFailureArm = (a: (typeof e.variantArms)[number]) =>
            a.isError === true || a.varType.kind === "none";
          const successArm = e.variantArms.find((a) => !isFailureArm(a));
          const failureArm = e.variantArms.find(isFailureArm);
          const fallback = e.otherwise ? rm(e.otherwise) : undefined;
          const onPresent = successArm ? rm(successArm.value) : (fallback ?? subject);
          const onAbsent = failureArm ? rm(failureArm.value) : (fallback ?? subject);
          const text = t.ternary(t.absenceCheck(subject.text), onPresent.text, onAbsent.text);
          return compose(text, [subject, onPresent, onAbsent]);
        }
        const arms = e.variantArms.map((a) => {
          const bindingText = a.binding ? t.bindingRefText(a.binding, subject.text) : undefined;
          // EXTEND the inherited map, never replace it: `match` nests, and an
          // inner arm may read an OUTER arm's binding.  A fresh single-entry
          // map dropped every enclosing binding, so that read fell back to the
          // bare `.ddd` name — an identifier the target never declares (TS2304
          // and its per-backend twins).  Native-pattern backends escaped only
          // by coincidence, because their bound name IS the source name.
          const armCtx: Ctx =
            a.binding && bindingText !== undefined
              ? {
                  ...ctx,
                  matchBindings: new Map([...(ctx.matchBindings ?? []), [a.binding, bindingText]]),
                }
              : ctx;
          const value = renderExprWithMarks(a.value, t, armCtx);
          return {
            value,
            rendered: {
              tag: variantTag(a.varType),
              variantTypeName: variantTypeName(a),
              binding: a.binding,
              value: value.text,
              isError: a.isError ?? false,
            },
          };
        });
        const otherwise = e.otherwise ? rm(e.otherwise) : undefined;
        const text = t.matchVariant({
          subject: subject.text,
          arms: arms.map((a) => a.rendered),
          otherwise: otherwise?.text,
          unionName:
            e.subjectType?.kind === "union" ? unionInstanceName(e.subjectType.variants) : "",
        });
        return compose(text, [
          subject,
          ...arms.map((a) => a.value),
          ...(otherwise ? [otherwise] : []),
        ]);
      }
      const arms = e.arms.map((a) => ({ cond: rm(a.cond), value: rm(a.value) }));
      const otherwise = e.otherwise ? rm(e.otherwise) : undefined;
      const text = t.match(
        arms.map((a) => ({ cond: a.cond.text, value: a.value.text })),
        otherwise?.text,
      );
      return compose(text, [
        ...arms.flatMap((a) => [a.cond, a.value]),
        ...(otherwise ? [otherwise] : []),
      ]);
    }
    case "list": {
      const elements = e.elements.map(rm);
      return compose(t.list(elements.map((el) => el.text)), elements);
    }
    case "action-ref":
      throw new Error("renderExprWithMarks: 'action-ref' is not a domain expression");
    case "authz-filter":
      // See `renderExprWith` — a filter sentinel must never reach the generic
      // dispatcher; a backend's query-filter translator special-cases it first.
      throw new Error(
        "renderExprWithMarks: 'authz-filter' must be handled by the backend's query-filter translator, not the generic expression dispatcher",
      );
  }
}
