// criteria-emit — reified `criterion` declarations as Domain-layer
// `Criterion<T>` specifications (the *evaluate* face: `IsSatisfiedBy`).
//
// Reified-criteria Slice 1 (additive, .NET-only, compile-gated). Today
// criteria are inlined at lowering with no use-site provenance (see
// `inlineCriterion` in `src/ir/lower/lower-expr.ts`), so this slice only
// *emits* the reified specification classes — it does NOT yet rewire
// invariants / preconditions onto them (that needs a `criterion-ref`
// `ExprIR` node, a later slice) nor add the query face (`ToExpression()` /
// EF `Specification<T>`). The classes exist and compile under
// `dotnet build /warnaserror`, the same precedent PR3-A set for `run<Name>`.
//
// Eligibility: entity-candidate criteria whose body does not reference
// `currentUser`. Ambient (`of bool`) criteria and principal-referencing
// ones are skipped — their binding belongs in the spec *factory*, a later
// slice — so the emitted set always compiles.

import type { BoundedContextIR, CriterionIR, ExprIR } from "../../ir/types/loom-ir.js";
import { firstNonQueryableNode } from "../../ir/validate/validate.js";
import { lines } from "../../util/code-builder.js";
import { plural, upperFirst } from "../../util/naming.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "./render-expr.js";

/** The `IsSatisfiedBy` parameter name — matches the abstract base
 *  declaration verbatim so the analyzer (CA1725) is happy.  Criterion
 *  parameters are stored as constructor-injected fields on the subclass
 *  (not as method parameters), so no collision with this identifier
 *  is possible from the user's DSL surface. */
const CANDIDATE = "candidate";

export function emitCriteria(ctx: BoundedContextIR, ns: string, out: Map<string, string>): void {
  const eligible = ctx.criteria.filter((c) => candidateName(c, ctx) !== undefined);
  if (eligible.length === 0) return;
  out.set("Domain/Common/Criterion.cs", renderCriterionBase(ns));
  for (const c of eligible) {
    out.set(
      `Domain/Criteria/${upperFirst(c.name)}Criterion.cs`,
      renderCriterion(c, candidateName(c, ctx)!, ns),
    );
  }
}

/** Does `criterionName` have an emitted `Criterion<aggName>` class *with* a
 *  `ToExpression()` query face? — i.e. it's Slice-1a eligible (entity
 *  candidate named `aggName`, no `currentUser`) and in the queryable subset.
 *  Lets the retrieval/find emitters decide whether to consume `ToExpression()`
 *  (reified) or fall back to the inlined predicate. */
export function canEmitToExpressionFor(
  criterionName: string,
  ctx: BoundedContextIR,
  aggName: string,
): boolean {
  const crit = ctx.criteria.find((c) => c.name === criterionName);
  if (!crit) return false;
  if (candidateName(crit, ctx) !== aggName) return false;
  return firstNonQueryableNode(crit.body) === null;
}

/** The aggregate name a criterion is a `Criterion<T>` over, or `undefined`
 *  when it isn't eligible for Slice-1 emission: ambient (`of bool`)
 *  criteria have no candidate, a missing aggregate can't be referenced,
 *  and a body that reads `currentUser` needs the (not-yet-emitted) factory
 *  to bind the principal. */
function candidateName(c: CriterionIR, ctx: BoundedContextIR): string | undefined {
  if (c.targetType.kind !== "entity") return undefined;
  const name = c.targetType.name;
  if (!ctx.aggregates.some((a) => a.name === name)) return undefined;
  if (refsCurrentUser(c.body)) return undefined;
  return name;
}

function renderCriterionBase(ns: string): string {
  return lines(
    "// Auto-generated.",
    `namespace ${ns}.Domain.Common;`,
    "",
    "/// <summary>",
    "/// Reified specification predicate — Evans's <c>Specification&lt;T&gt;.isSatisfiedBy</c>,",
    "/// the in-memory *evaluate* face of a Loom <c>criterion</c>. Generated from",
    "/// <c>criterion</c> declarations. Queryable criteria additionally carry a",
    "/// <c>ToExpression()</c> *query* face (<c>Expression&lt;Func&lt;T,bool&gt;&gt;</c>) for EF;",
    "/// use-site consumption (find/view/filter) lands in a later slice.",
    "/// </summary>",
    "public abstract class Criterion<T>",
    "{",
    "    public abstract bool IsSatisfiedBy(T candidate);",
    "}",
  );
}

function renderCriterion(c: CriterionIR, candidate: string, ns: string): string {
  // Only fields the body actually reads — an unused private field is a
  // CS0169 warning, which `/warnaserror` would turn into a build failure.
  const usedParams = c.params.filter((p) => refsParam(c.body, p.name));
  const className = `${upperFirst(c.name)}Criterion`;
  const ctorParams = c.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
  // Candidate fields render against `__candidate` (this-prop → `__candidate.Prop`);
  // parameters render as bare names, which resolve to the fields below.  The
  // same rendered body serves both faces — `IsSatisfiedBy(c) => body` and the
  // `c => body` lambda of `ToExpression()`.
  const body = renderCsExpr(c.body, { thisName: CANDIDATE, efQuery: true });
  // The *query* face is emitted only for criteria in the queryable subset —
  // `ToExpression()` is meant for EF `IQueryable`/`Where`, so a body that
  // can't translate to SQL gets the evaluate face only.
  const queryable = firstNonQueryableNode(c.body) === null;
  // Namespaces beyond the SDK implicit-usings set the body reaches into
  // (e.g. `matches` → `System.Text.RegularExpressions`).
  const usings = new Set<string>([
    `${ns}.Domain.Common`,
    `${ns}.Domain.${plural(candidate)}`,
    `${ns}.Domain.Enums`,
    `${ns}.Domain.ValueObjects`,
    `${ns}.Domain.Ids`,
    "System.Linq",
  ]);
  for (const u of collectCsExprUsings(c.body)) usings.add(u);
  if (queryable) usings.add("System.Linq.Expressions");
  return lines(
    "// Auto-generated.",
    ...[...usings].map((u) => `using ${u};`),
    "",
    `namespace ${ns}.Domain.Criteria;`,
    "",
    `public sealed class ${className} : Criterion<${candidate}>`,
    "{",
    ...usedParams.map((p) => `    private readonly ${renderCsType(p.type)} ${p.name};`),
    c.params.length > 0 ? `    public ${className}(${ctorParams})` : null,
    c.params.length > 0 ? "    {" : null,
    ...usedParams.map((p) => `        this.${p.name} = ${p.name};`),
    c.params.length > 0 ? "    }" : null,
    c.params.length > 0 ? "" : null,
    `    public override bool IsSatisfiedBy(${candidate} ${CANDIDATE}) => ${body};`,
    // Query face — for `find`/`view`/`filter`/`retrieval` consumption (a
    // later slice). Selectability decides: only queryable criteria carry it.
    queryable ? "" : null,
    queryable
      ? `    public Expression<Func<${candidate}, bool>> ToExpression() => ${CANDIDATE} => ${body};`
      : null,
    "}",
  );
}

// --- tiny ExprIR ref walk (mirrors collectCsExprUsings in render-expr.ts) --

export function refsCurrentUser(e: ExprIR): boolean {
  // `currentUser` is the magic principal identifier. With a `user { … }`
  // block it lowers to `refKind: "current-user"`; without one it falls
  // through to an `unknown` ref still *named* `currentUser` (the lowering's
  // own guard, lower-expr.ts). Match both — either way `IsSatisfiedBy` has
  // no `currentUser` in scope, so a principal criterion is excluded from
  // `Criterion<T>` reification. The reified-retrieval spec consumes the SAME
  // predicate to decide when to bind the ambient principal in its inline
  // `where` (spec-emit.ts), so the skip-here / bind-there decisions stay
  // coupled — a criterion this excludes always gets its principal bound there.
  return anyRef(e, (r) => r.refKind === "current-user" || r.name === "currentUser");
}

function refsParam(e: ExprIR, name: string): boolean {
  return anyRef(e, (r) => r.refKind === "param" && r.name === name);
}

type RefNode = Extract<ExprIR, { kind: "ref" }>;

function anyRef(e: ExprIR, pred: (r: RefNode) => boolean): boolean {
  switch (e.kind) {
    case "ref":
      return pred(e);
    case "member":
      return anyRef(e.receiver, pred);
    case "method-call":
      return anyRef(e.receiver, pred) || e.args.some((a) => anyRef(a, pred));
    case "call":
      return e.args.some((a) => anyRef(a, pred));
    case "unary":
      return anyRef(e.operand, pred);
    case "binary":
      return anyRef(e.left, pred) || anyRef(e.right, pred);
    case "paren":
      return anyRef(e.inner, pred);
    case "ternary":
      return anyRef(e.cond, pred) || anyRef(e.then, pred) || anyRef(e.otherwise, pred);
    case "lambda":
      return e.body !== undefined && anyRef(e.body, pred);
    case "new":
    case "object":
      return e.fields.some((f) => anyRef(f.value, pred));
    case "convert":
      return anyRef(e.value, pred);
    case "match":
      return (
        e.arms.some((a) => anyRef(a.cond, pred) || anyRef(a.value, pred)) ||
        (e.otherwise !== undefined && anyRef(e.otherwise, pred))
      );
    case "list":
      return e.elements.some((x) => anyRef(x, pred));
    default:
      // literal | this | id — leaves with no sub-expressions.
      return false;
  }
}
