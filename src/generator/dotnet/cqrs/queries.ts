import { pagedReturn } from "../../../ir/stdlib/generics.js";
import type {
  AggregateIR,
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  FindIR,
  RepositoryIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { findGateUsesCurrentUser, findUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { maskedHistoryFields } from "../../../ir/util/audit-history.js";
import { upperFirst } from "../../../util/naming.js";
import { projectEntityExpr, projectionNamesDomainCommon } from "../dto-mapping.js";
import {
  HISTORY_RETURN_TYPE,
  historyHandlerName,
  historyQueryName,
  renderHistoryEntryMapperLines,
} from "../emit/audit-history.js";
import { renderQuery, renderQueryHandler } from "../emit.js";
import { collectCsExprUsings, renderCsExpr, renderCsType } from "../render-expr.js";

/** `<ns>.Domain.Common` holds the types a DTO PROJECTION can name —
 *  `RequestContext` (a `mask unless` field's `maskWrap`) and `Provenanced<T>`
 *  (a `provenanced` field's wire carrier, M-T6.12).  A read handler inlines the
 *  projection into its own file, so it needs the using whenever either applies;
 *  `projectionNamesDomainCommon` is the single predicate both the mask and the
 *  carrier register with, so a third such type cannot be forgotten here. */
function projectionUsings(agg: EnrichedAggregateIR, ns: string): string[] {
  return projectionNamesDomainCommon(agg) ? [`${ns}.Domain.Common`] : [];
}

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
        // The predicate is an arbitrary expression rendered into THIS file and
        // scanned nowhere else, so it carries its own namespaces
        // (`System.Text.RegularExpressions` for `matches`, audit A17).
        extraUsings: [
          `${ns}.Domain.Common`,
          ...collectCsExprUsings(op.when!, new Set<string>(), ns),
        ],
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
      extraUsings: projectionUsings(agg, ns),
      body:
        `        var found = await _repo.GetByIdAsync(query.Id, cancellationToken);\n` +
        `        return found is null ? null : ${projectEntityExpr("found", agg, ctx)};\n`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Entity history — `GET /<agg>/{id}/history` (docs/audit.md)
// ---------------------------------------------------------------------------

/** The per-entity history read, as a Mediator query + handler.
 *
 *  Driven by the enrichment-derived `repo.historyFind`, which sits BESIDE
 *  `finds` (see `RepositoryIR.historyFind`) — so the generic find loop above
 *  never sees it and this is the one place it is emitted.
 *
 *  Three things make it safe, in order:
 *
 *  1. **The gate.** `historyFind.requires` is the aggregate's own list-read
 *     gate, copied at enrichment — so history is never easier to reach than the
 *     entity read it replays.  Fails → `ForbiddenException` → 403, BEFORE any
 *     query runs.
 *
 *  2. **Entity reachability.** `audit_records` is a cross-context machinery
 *     table: it carries `target_type`/`target_id` and NO tenant column, so
 *     there is nothing on it for a capability query-filter to scope.  Scoping
 *     is therefore done on the ENTITY: the handler resolves the row through
 *     `_repo.GetByIdAsync`, which already carries every capability predicate
 *     (EF applies the read query-filter automatically; the Dapper repository
 *     inlines it).  A row the caller cannot read yields 404 here — the same
 *     answer the entity read gives, so history discloses nothing about rows in
 *     another tenant, not even their existence.
 *
 *  3. **The mask.** The row → entry mapper drops each `mask unless` field's
 *     change entry for a caller who fails the predicate.
 *
 *  All three are needed: the gate alone leaks across tenants, reachability
 *  alone leaks masked fields to legitimate readers, and the mask alone leaves
 *  the endpoint open. */
export function emitHistoryQueryAndHandler(
  agg: EnrichedAggregateIR,
  repo: RepositoryIR | undefined,
  ns: string,
  aggFolder: string,
  out: Map<string, string>,
  idClass: string = `${agg.name}Id`,
): void {
  const find = repo?.historyFind;
  if (!find) return;
  const gateUsesUser = findGateUsesCurrentUser(find);
  const masked = maskedHistoryFields(agg);
  // `Application.Common` carries AuditEntry / AuditFieldChange / AuditSnapshot /
  // IAuditHistoryReader; `Domain.Common` carries AggregateNotFoundException, the
  // gate's ForbiddenException and (for the mask pass) RequestContext.
  const usings = new Set<string>([`${ns}.Application.Common`, `${ns}.Domain.Common`]);
  if (gateUsesUser) usings.add(`${ns}.Auth`);
  if (find.requires) collectCsExprUsings(find.requires, usings, ns);
  for (const f of masked) collectCsExprUsings(f.maskUnless!, usings, ns);
  out.set(
    `Application/${aggFolder}/Queries/${historyQueryName(agg)}.cs`,
    renderQuery({
      ns,
      aggName: agg.name,
      queryName: historyQueryName(agg),
      queryParams: `${idClass} Id`,
      returnType: HISTORY_RETURN_TYPE,
      extraUsings: [`${ns}.Application.Common`],
    }),
  );
  const body: string[] = [];
  if (find.requires) {
    // (1) — the inherited read gate, before the audit table is touched.
    if (gateUsesUser) body.push(`        var currentUser = _currentUser.User;`);
    body.push(
      `        if (!(${renderCsExpr(find.requires)}))`,
      `        {`,
      `            throw new ForbiddenException(${JSON.stringify(`Forbidden: find ${find.name}`)});`,
      `        }`,
    );
  }
  // (2) — capability scoping rides the ENTITY read, because the audit table has
  // no tenant column of its own to filter on.
  body.push(
    `        var __target = await _repo.GetByIdAsync(query.Id, cancellationToken);`,
    `        if (__target is null)`,
    `        {`,
    `            throw new AggregateNotFoundException($"${agg.name} {query.Id} not found");`,
    `        }`,
    `        var __rows = await _history.ReadAsync(${JSON.stringify(agg.name)}, query.Id.Value.ToString(), cancellationToken);`,
    `        var __entries = new List<AuditEntry>(__rows.Count);`,
    `        foreach (var row in __rows)`,
    `        {`,
    // (3) — the mask pass lives in the mapper, the only place a caller enters.
    ...renderHistoryEntryMapperLines(agg, "            "),
    `        }`,
    `        return __entries;`,
  );
  out.set(
    `Application/${aggFolder}/Queries/${historyHandlerName(agg)}.cs`,
    renderQueryHandler({
      ns,
      aggName: agg.name,
      handlerName: historyHandlerName(agg),
      queryName: historyQueryName(agg),
      returnType: HISTORY_RETURN_TYPE,
      body: `${body.join("\n")}\n`,
      extraDeps: [
        { type: "IAuditHistoryReader", field: "_history" },
        ...(gateUsesUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : []),
      ],
      extraUsings: [...usings],
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
  // A synthesized find (paged-run queryHandler support) exposes no CQRS
  // query/handler of its own — the paged queryHandler emits a dedicated one and
  // calls the repository method directly.  The repo method itself still emits.
  for (const find of repo.finds.filter((f) => !f.synthesized)) {
    const queryReturn = renderResponseReturnType(find.returnType, agg);
    const usesUser = findUsesCurrentUser(find);
    // A `requires` gate needs the principal accessor when it reads currentUser.
    const gateUsesUser = findGateUsesCurrentUser(find);
    const needsUser = usesUser || gateUsesUser;
    // A paged return references `Paged<T>` from the shared runtime; a gate needs
    // `ForbiddenException` from `Domain.Common` (→ 403 via DomainExceptionFilter).
    const pagedUsings = pagedReturn(find.returnType) ? [`${ns}.Domain.Common`] : [];
    const gateUsings = new Set<string>();
    if (find.requires) {
      gateUsings.add(`${ns}.Domain.Common`);
      collectCsExprUsings(find.requires, gateUsings, ns);
    }
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
        body: buildFindHandlerBody(find, agg, ctx, usesUser, gateUsesUser),
        extraDeps: needsUser ? [{ type: "ICurrentUserAccessor", field: "_currentUser" }] : [],
        extraUsings: [
          ...new Set([
            ...(needsUser ? [`${ns}.Auth`] : []),
            ...pagedUsings,
            ...gateUsings,
            ...projectionUsings(agg, ns),
          ]),
        ],
      }),
    );
  }
}

function buildFindHandlerBody(
  find: FindIR,
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
  usesUser: boolean = false,
  gateUsesUser: boolean = false,
): string {
  // Authorization gate (default-deny): a 403 when the `requires` predicate
  // fails, BEFORE the repository call.  ForbiddenException → 403 via the
  // DomainExceptionFilter — the read-side analogue of an operation `requires`
  // gate (render-stmt).  `var currentUser = _currentUser.User;` binds the local
  // the rendered predicate references (renderCsExpr → bare `currentUser`).
  let gate = "";
  if (find.requires) {
    if (gateUsesUser) gate += `        var currentUser = _currentUser.User;\n`;
    gate += `        if (!(${renderCsExpr(find.requires)})) throw new ForbiddenException(${JSON.stringify(
      `Forbidden: find ${find.name}`,
    )});\n`;
  }
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
      gate +
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
      gate +
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  if (find.returnType.kind === "array") {
    return (
      gate +
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain.Select(d => ${projectEntityExpr("d", agg, ctx)}).ToList();\n`
    );
  }
  if (find.returnType.kind === "optional") {
    return (
      gate +
      `        var domain = await _repo.${upperFirst(find.name)}(${callArgs});\n` +
      `        return domain is null ? null : ${projectEntityExpr("domain", agg, ctx)};\n`
    );
  }
  return (
    gate +
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
