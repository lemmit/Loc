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
import { renderCsExpr, renderCsType } from "../render-expr.js";

// ---------------------------------------------------------------------------
// Get-by-id query (returns Response | null)
// ---------------------------------------------------------------------------

/** The side-effect-free companions of `when`-gated operations: per op a
 *  `Can<Op>Query(Id) : IQuery<CanResponse>` + handler (load → evaluate the
 *  predicate → `{ allowed }`), plus one `CanResponse` record per aggregate
 *  folder.  The canCommand pattern, criterion.md use site 2. */
export function emitCanOpQueriesAndHandlers(
  agg: EnrichedAggregateIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
): void {
  const gated = agg.operations.filter((op) => op.when && op.visibility === "public");
  if (gated.length === 0) return;
  out.set(
    `Application/${aggFolder}/Responses/CanResponse.cs`,
    `// Auto-generated.\n` +
      `using System.ComponentModel.DataAnnotations;\n\n` +
      `namespace ${ns}.Application.${aggFolder}.Responses;\n\n` +
      `public sealed record CanResponse([property: Required] bool Allowed);\n`,
  );
  for (const op of gated) {
    const opName = upperFirst(op.name);
    const pred = renderCsExpr(op.when!, { thisName: "aggregate" });
    out.set(
      `Application/${aggFolder}/Queries/Can${opName}Query.cs`,
      renderQuery({
        ns,
        aggName: agg.name,
        queryName: `Can${opName}Query`,
        queryParams: `${idClass} Id`,
        returnType: "CanResponse",
      }),
    );
    out.set(
      `Application/${aggFolder}/Queries/Can${opName}Handler.cs`,
      renderQueryHandler({
        ns,
        aggName: agg.name,
        handlerName: `Can${opName}Handler`,
        queryName: `Can${opName}Query`,
        returnType: "CanResponse",
        extraUsings: [`${ns}.Domain.Common`],
        body:
          `        var aggregate = await _repo.GetByIdAsync(query.Id, cancellationToken)\n` +
          `            ?? throw new AggregateNotFoundException($"${agg.name} {query.Id} not found");\n` +
          `        return new CanResponse(${pred});\n`,
      }),
    );
  }
}

export function emitGetByIdQueryAndHandler(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
): void {
  out.set(
    `Application/${aggFolder}/Queries/Get${agg.name}ByIdQuery.cs`,
    renderQuery({
      ns,
      aggName: agg.name,
      queryName: `Get${agg.name}ByIdQuery`,
      queryParams: `${idClass} Id`,
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
          // A paged find's query carries the pagination + sort controls (P3b /
          // M-T2.6): `Sort` names a whitelisted column, `Dir` the direction.
          ...(pagedReturn(find.returnType)
            ? ["int Page", "int PageSize", "string Sort", "string Dir"]
            : []),
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
      "query.Sort",
      "query.Dir",
      ...(usesUser ? ["_currentUser.User"] : []),
    ];
    const pagedCall = `${pagedArgs.join(", ")}, cancellationToken`;
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${pagedCall});\n` +
      `        return new Paged<${agg.name}Response>(domain.Items.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList(), domain.Page, domain.PageSize, domain.Total, domain.TotalPages);\n`
    );
  }
  if (find.returnType.kind === "union") {
    // A single-success union find (`Agg or Err`) is handled exactly like an
    // optional find: the repository returns the optional twin (`Agg?`) and the
    // handler projects a found row into `<Agg>Response` or returns null.  The
    // 200 body is the SUCCESS variant DIRECTLY (exception-less.md §4) — the
    // error/absent variant is a status response the CONTROLLER emits (Problem
    // at its mapped status, or a 404 for `none`), never part of the 200 schema —
    // so no tagged union DTO is produced.  (Multi-success unions, which would
    // need a `oneOf`, are rejected for finds at IR validation.)
    return (
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
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
  // A single-success union find returns the SUCCESS variant's `<Agg>Response`
  // (nullable — absence is the error/`none` variant the controller maps to a
  // status), identical to an optional find (exception-less.md §4).
  if (t.kind === "union") return `${agg.name}Response?`;
  if (t.kind === "array") {
    return `IReadOnlyList<${agg.name}Response>`;
  }
  if (t.kind === "optional") {
    return `${agg.name}Response?`;
  }
  return `${agg.name}Response`;
}
