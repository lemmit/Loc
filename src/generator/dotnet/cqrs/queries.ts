import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { projectEntityExpr } from "../dto-mapping.js";
import { renderQuery, renderQueryHandler } from "../emit.js";
import { renderCsType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Get-by-id query (returns Response | null)
// ---------------------------------------------------------------------------

export function emitGetByIdQueryAndHandler(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  out.set(
    `Application/${aggFolder}/Queries/Get${agg.name}ByIdQuery.cs`,
    renderQuery({
      ns,
      aggName: agg.name,
      queryName: `Get${agg.name}ByIdQuery`,
      queryParams: `${agg.name}Id Id`,
      returnType: `${agg.name}Response?`,
    }),
  );
  out.set(
    `Application/${aggFolder}/Queries/Get${agg.name}ByIdHandler.cs`,
    renderQueryHandler({
      ns,
      aggName: agg.name,
      handlerName: `Get${agg.name}ByIdHandler`,
      queryName: `Get${agg.name}ByIdQuery`,
      returnType: `${agg.name}Response?`,
      body:
        `        var found = await _repo.GetByIdAsync(query.Id, cancellationToken);\n` +
        `        return found is null ? null : ${projectEntityExpr("found", agg, ctx)};\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Repository-defined finds → queries
// ---------------------------------------------------------------------------

export function emitFindQueriesAndHandlers(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
): void {
  if (!repo) return;
  for (const find of repo.finds) {
    const queryReturn = renderResponseReturnType(find.returnType, agg);
    const usesUser = findUsesCurrentUser(find);
    // A paged return references `Paged<T>` from the shared runtime.
    const pagedUsings = pagedReturn(find.returnType) ? [`${ns}.Domain.Common`] : [];
    out.set(
      `Application/${aggFolder}/Queries/${upperFirst(find.name)}Query.cs`,
      renderQuery({
        ns,
        aggName: agg.name,
        queryName: `${upperFirst(find.name)}Query`,
        queryParams: [
          ...find.params.map((p) => `${renderCsType(p.type)} ${upperFirst(p.name)}`),
          // A paged find's query carries the pagination controls (P3b).
          ...(pagedReturn(find.returnType) ? ["int Page", "int PageSize"] : []),
        ].join(", "),
        returnType: queryReturn,
        extraUsings: pagedUsings,
      }),
    );
    out.set(
      `Application/${aggFolder}/Queries/${upperFirst(find.name)}Handler.cs`,
      renderQueryHandler({
        ns,
        aggName: agg.name,
        handlerName: `${upperFirst(find.name)}Handler`,
        queryName: `${upperFirst(find.name)}Query`,
        returnType: queryReturn,
        body: buildFindHandlerBody(find, agg, ctx, usesUser),
        extraDeps: usesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [],
        extraUsings: [...(usesUser ? [`${ns}.Auth`] : []), ...pagedUsings],
      }),
    );
  }
}

function buildFindHandlerBody(
  find: FindIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  usesUser: boolean = false,
): string {
  const baseArgs = find.params.map((p) => `query.${upperFirst(p.name)}`);
  const allArgs = usesUser ? [...baseArgs, "_currentUser.User"] : baseArgs;
  // The repository signature ends with `CancellationToken cancellationToken`; drop the
  // separator when there are no domain params, so the auto-included
  // zero-arg `all` find compiles cleanly.
  const argList = allArgs.join(", ");
  const callArgs = argList.length > 0 ? `${argList}, cancellationToken` : `cancellationToken`;
  if (pagedReturn(find.returnType)) {
    // Repo returns `Paged<Agg>` (domain); map each item to its response DTO
    // and re-wrap, preserving the page metadata (P3b).
    const pagedArgs = [
      ...baseArgs,
      "query.Page",
      "query.PageSize",
      ...(usesUser ? ["_currentUser.User"] : []),
    ];
    const pagedCall = `${pagedArgs.join(", ")}, cancellationToken`;
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${pagedCall});\n` +
      `        return new Paged<${agg.name}Response>(domain.Items.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);\n`
    );
  }
  if (find.returnType.kind === "array") {
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
    `        return ${projectEntityExpr("domain", agg, ctx)};\n`
  );
}

function renderResponseReturnType(t: TypeIR, agg: AggregateIR): string {
  if (pagedReturn(t)) {
    // The wire-side paged envelope wraps the response DTO (P3b).
    return `Paged<${agg.name}Response>`;
  }
  if (t.kind === "array") {
    return `IReadOnlyList<${agg.name}Response>`;
  }
  if (t.kind === "optional") {
    return `${agg.name}Response?`;
  }
  return `${agg.name}Response`;
}
