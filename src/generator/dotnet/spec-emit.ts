// spec-emit — reified retrievals as Ardalis `Specification<T>` objects (the
// query *bundle*: where + sort). The headline reified-criteria payoff on
// .NET: a `retrieval` becomes a constructed Specification consumed by the
// repository via `.WithSpecification(spec)`, rather than a hand-inlined LINQ
// chain.
//
// EF-Core-only: Ardalis.Specification.EntityFrameworkCore evaluates these
// against `IQueryable`; the Dapper persistence axis has no `IQueryable`, so it
// keeps rendering SQL fragments (the csproj gates the Ardalis dependency on
// `persistence: efcore`).
//
// The spec holds where + sort; call-site `page` (offset/limit) stays LINQ on
// the spec-filtered query in the repository method (`Skip`/`Take`). When the
// `where` is exactly a named, eligible criterion the spec consumes that
// criterion's `ToExpression()` (Slice 2b); otherwise it inlines the predicate.

import type { BoundedContextIR, EnrichedAggregateIR, RetrievalIR } from "../../ir/types/loom-ir.js";
import { lines } from "../../util/code-builder.js";
import { plural, upperFirst } from "../../util/naming.js";
import { canEmitToExpressionFor, refsCurrentUser } from "./criteria-emit.js";
import {
  AMBIENT_CURRENT_USER,
  collectCsExprUsings,
  renderCsExpr,
  renderCsType,
} from "./render-expr.js";

/** The C# class name for a retrieval's Ardalis specification. */
export function specClassName(retrievalName: string): string {
  return `${upperFirst(retrievalName)}Spec`;
}

/** The shared `IQueryable<T>.ApplyPaging(page)` extension — applies the
 *  call-site `(offset, limit)` page to a spec-filtered query, keeping the
 *  `Skip`/`Take` out of every `Run<Name>Async`.  Returns `IQueryable<T>` so
 *  materialisation (`.ToListAsync`) stays explicit at the call site (and so
 *  the name can't be confused with the project's `Paged<T>` result wrapper).
 *  Emitted once per project when any retrieval exists. */
export function renderPagingExtension(ns: string): string {
  return lines(
    "// Auto-generated.",
    "using System.Linq;",
    "",
    `namespace ${ns}.Infrastructure.Persistence;`,
    "",
    "/// <summary>Applies a call-site (offset, limit) page to a query.</summary>",
    "internal static class QueryablePagingExtensions",
    "{",
    "    public static IQueryable<T> ApplyPaging<T>(this IQueryable<T> query, (int? offset, int? limit)? page)",
    "    {",
    "        if (page is { } p)",
    "        {",
    "            if (p.offset is { } off) query = query.Skip(off);",
    "            if (p.limit is { } lim) query = query.Take(lim);",
    "        }",
    "        return query;",
    "    }",
    "}",
  );
}

export function emitRetrievalSpecs(
  agg: EnrichedAggregateIR,
  retrievals: RetrievalIR[],
  ctx: BoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  for (const r of retrievals) {
    out.set(`Domain/${plural(agg.name)}/${specClassName(r.name)}.cs`, renderSpec(r, agg, ctx, ns));
  }
}

function renderSpec(
  r: RetrievalIR,
  agg: EnrichedAggregateIR,
  ctx: BoundedContextIR,
  ns: string,
): string {
  const reified = !!(r.criterionRef && canEmitToExpressionFor(r.criterionRef.name, ctx, agg.name));
  // A retrieval whose `where` references the principal (`currentUser.<field>`,
  // e.g. a tenancy criterion) is built once inside the `Specification<T>`
  // constructor — a static position with no request-scoped `currentUser` local.
  // Resolve it through the same ambient accessor the EF query-filter capability
  // filters use (`AMBIENT_CURRENT_USER`), so the principal has one source on the
  // whole backend; without this the inlined predicate names an unbound
  // `currentUser` and the spec fails to compile (CS0103). The reified branch
  // never hits this — `canEmitToExpressionFor` excludes principal criteria, so
  // they fall to the inline path here, where the binding lives.
  const refsPrincipal = !reified && refsCurrentUser(r.where);
  const wherePredicate = reified
    ? `new ${upperFirst(r.criterionRef!.name)}Criterion(${r
        .criterionRef!.args.map((a) => renderCsExpr(a, { thisName: "x", agg }))
        .join(", ")}).ToExpression()`
    : `x => ${renderCsExpr(r.where, { thisName: "x", agg, currentUserExpr: refsPrincipal ? AMBIENT_CURRENT_USER : undefined })}`;

  const usings = new Set<string>([
    "Ardalis.Specification",
    `${ns}.Domain.Enums`,
    `${ns}.Domain.ValueObjects`,
    `${ns}.Domain.Ids`,
  ]);
  if (reified) usings.add(`${ns}.Domain.Criteria`);
  // The ambient accessor (`RequestContext`) lives in `<ns>.Domain.Common`;
  // import it only when the predicate actually resolves the principal.
  if (refsPrincipal) usings.add(`${ns}.Domain.Common`);
  for (const u of collectCsExprUsings(r.where)) usings.add(u);

  const ctorParams = r.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
  return lines(
    "// Auto-generated.",
    ...[...usings].map((u) => `using ${u};`),
    "",
    // The aggregate type lives in this same namespace (Domain/<Plural>), so
    // no extra using is needed to reference it.
    `namespace ${ns}.Domain.${plural(agg.name)};`,
    "",
    `public sealed class ${specClassName(r.name)} : Specification<${agg.name}>`,
    "{",
    `    public ${specClassName(r.name)}(${ctorParams})`,
    "    {",
    `        Query.Where(${wherePredicate})${orderByChain(r)};`,
    "    }",
    "}",
  );
}

/** `.OrderBy(x => x.A).ThenByDescending(x => x.B)` for a retrieval's sort
 *  terms (empty when unsorted) — Ardalis's builder mirrors LINQ's names, so
 *  this is the same chain `find-emit.ts:orderByClauseFor` produces. Only the
 *  first path segment is used (a direct column), matching validateRetrievals. */
function orderByChain(r: RetrievalIR): string {
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
