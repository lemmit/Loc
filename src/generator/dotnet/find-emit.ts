import type {
  BoundedContextIR,
  EnrichedAggregateIR,
  FindIR,
  RepositoryIR,
  RetrievalIR,
  TypeIR,
} from "../../ir/types/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { canEmitToExpressionFor } from "./criteria-emit.js";
import { bypassedFilterNames } from "./emit/efcore.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";

/** The `.IgnoreQueryFilters(…)` clause for an `ignoring`-bearing read
 *  (named-filter-bypass.md §11), inserted on the `_db.<Set>` IQueryable BEFORE
 *  the `.Where(...)`.  `ignoring *` → the parameterless overload (drop every
 *  query filter); `ignoring <Cap>` → `IgnoreQueryFilters(["Name1", …])` for the
 *  EF filters the bypassed capabilities contributed.  Returns "" when nothing
 *  is bypassed (a `*` on a filterless aggregate is a harmless no-op). */
export function ignoreFiltersClause(
  agg: EnrichedAggregateIR,
  bypass: { bypassAll?: boolean; bypassCaps?: string[] },
): string {
  if (bypass.bypassAll) return ".IgnoreQueryFilters()";
  const names = bypassedFilterNames(agg, bypass);
  if (names.length === 0) return "";
  return `.IgnoreQueryFilters([${names.map((n) => JSON.stringify(n)).join(", ")}])`;
}

// ---------------------------------------------------------------------------
// Repository find-method bodies.
//
// Two paths:
//   - Explicit `where Expression` clause on the find — render the IR
//     expression in a LINQ predicate context (`x => …`).  The standard
//     C# expression renderer accepts a `thisName` in its context, so
//     `this.Status` becomes `x.Status` automatically.
//   - No `where` — convention-based equality: each parameter is matched
//     to an aggregate property with the same name (or `<name>Id` →
//     `<name>` if the param's name strips an `Id` suffix), and an
//     `&&`-conjunction is emitted.
// ---------------------------------------------------------------------------

/** A union find (`Agg or NotFound` / `Agg option` — validator-pinned to the
 *  absence shape, `loom.union-find-shape-unsupported`) reaches the Domain
 *  repository as its **optional twin**: the same predicate as a single-row
 *  select returning `Agg?`.  The Application query handler owns the union —
 *  it maps `null` to the absent variant and projects a found row into the
 *  tagged DTO (P4c producer side) — so the Domain layer never names the
 *  Response-side union type.  CQRS emitters (queries/DTOs/controller) keep
 *  the original union return. */
export function unionFindAsOptionalTwin(find: FindIR, aggName: string): FindIR {
  if (find.returnType.kind !== "union") return find;
  const success = find.returnType.variants.find(
    (v) => v.kind === "entity" && v.name === aggName,
  ) ?? { kind: "entity" as const, name: aggName };
  return { ...find, returnType: { kind: "optional", inner: success } };
}

export function buildFindBodies(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx?: BoundedContextIR,
): Array<{ name: string; ignoreClause: string; filterClause: string; projectionClause: string }> {
  if (!repo) return [];
  return repo.finds.map((raw) => {
    const find = unionFindAsOptionalTwin(raw, agg.name);
    return {
      name: find.name,
      ignoreClause: ignoreFiltersClause(agg, find),
      filterClause: filterClauseFor(find, agg, ctx),
      projectionClause: projectionClauseFor(find.returnType),
    };
  });
}

/** Namespaces the find-filter predicates of `repo` reach into (e.g.
 *  System.Text.RegularExpressions for a `where … matches …` find) — the
 *  repository-impl emitter declares these as `using`s.  Pure mirror of
 *  what `filterClauseFor` renders. */
export function collectFindBodyUsings(
  repo: RepositoryIR | undefined,
  into: Set<string> = new Set(),
): Set<string> {
  for (const find of repo?.finds ?? []) {
    if (find.filter) collectCsExprUsings(find.filter, into);
  }
  return into;
}

/** LINQ clause fragments for a `retrieval`'s `Run<Name>Async` method
 *  (retrieval.md): the `where` predicate, the `sort` ordering, and the
 *  default-whole projection.  Paging (`Skip`/`Take`) is spliced from the
 *  call-site `page` argument by the impl emitter, not here. */
export function buildRetrievalBodies(
  agg: EnrichedAggregateIR,
  retrievals: RetrievalIR[],
  ctx: BoundedContextIR,
): Array<{ name: string; whereClause: string; orderByClause: string }> {
  return retrievals.map((r) => ({
    name: r.name,
    whereClause: retrievalWhereClause(r, agg, ctx),
    orderByClause: orderByClauseFor(r),
  }));
}

/** A retrieval's `.Where(...)` clause.  When the `where` is exactly a named
 *  criterion with an emitted reified class (Slice 2b), consume its
 *  `ToExpression()` — `.Where(new XCriterion(args).ToExpression())` — so the
 *  query is the reified Specification rather than an inlined predicate.
 *  Composed / anonymous / non-eligible `where`s fall back to the inline
 *  `x => …` form (byte-identical to before). */
function retrievalWhereClause(
  r: RetrievalIR,
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
): string {
  if (r.criterionRef && canEmitToExpressionFor(r.criterionRef.name, ctx, agg.name)) {
    const args = r.criterionRef.args
      .map((a) => renderCsExpr(a, { thisName: "x", agg, efQuery: true }))
      .join(", ");
    return `.Where(new ${upperFirst(r.criterionRef.name)}Criterion(${args}).ToExpression())`;
  }
  return `.Where(x => ${renderCsExpr(r.where, { thisName: "x", agg, efQuery: true })})`;
}

/** `.OrderBy(x => x.Col)[.ThenBy…]` for a retrieval's sort terms (empty
 *  when unsorted).  Only the first path segment is used in v1 (a direct
 *  column), matching the Hono emitter + validateRetrievals gating. */
function orderByClauseFor(r: RetrievalIR): string {
  if (r.sort.length === 0) return "";
  return r.sort
    .map((s, i) => {
      const col = upperFirst(s.path[0]!.name);
      const method =
        i === 0
          ? s.direction === "desc"
            ? "OrderByDescending"
            : "OrderBy"
          : s.direction === "desc"
            ? "ThenByDescending"
            : "ThenBy";
      return `.${method}(x => x.${col})`;
    })
    .join("");
}

/** Namespaces a retrieval's `where` predicates reach into — same role as
 *  `collectFindBodyUsings` for finds. */
export function collectRetrievalBodyUsings(
  retrievals: RetrievalIR[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const r of retrievals) collectCsExprUsings(r.where, into);
  return into;
}

function filterClauseFor(find: FindIR, agg: EnrichedAggregateIR, ctx?: BoundedContextIR): string {
  // A `where` that is exactly a named, eligible criterion consumes its
  // reified `ToExpression()` (Slice 2b, symmetric to the retrieval path).
  if (ctx && find.criterionRef && canEmitToExpressionFor(find.criterionRef.name, ctx, agg.name)) {
    const args = find.criterionRef.args
      .map((a) => renderCsExpr(a, { thisName: "x", agg, efQuery: true }))
      .join(", ");
    return `.Where(new ${upperFirst(find.criterionRef.name)}Criterion(${args}).ToExpression())`;
  }
  if (find.filter) {
    // `agg` is threaded so the renderer can resolve a
    // `this.<refColl>.contains(param)` predicate to its
    // AssociationIR and emit a join-table subquery.  See
    // `render-expr.ts:renderMethodCall`.
    return `.Where(x => ${renderCsExpr(find.filter, { thisName: "x", agg, efQuery: true })})`;
  }
  if (find.params.length === 0) return "";
  const conditions: string[] = [];
  for (const p of find.params) {
    const matchedField = agg.fields.find(
      (f) => f.name === p.name || `${f.name.replace(/Id$/, "")}Id` === p.name,
    );
    if (matchedField) {
      conditions.push(`x.${upperFirst(matchedField.name)} == ${p.name}`);
    }
  }
  if (conditions.length === 0) return "";
  return `.Where(x => ${conditions.join(" && ")})`;
}

function projectionClauseFor(t: TypeIR): string {
  if (t.kind === "array") return `.ToListAsync(cancellationToken)`;
  if (t.kind === "optional") return `.FirstOrDefaultAsync(cancellationToken)`;
  return `.FirstAsync(cancellationToken)`;
}
