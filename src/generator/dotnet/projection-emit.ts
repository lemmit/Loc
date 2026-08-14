import { deriveEventSubscriptions } from "../../ir/enrich/enrichments.js";
import type {
  EnrichedBoundedContextIR,
  ProjectionIR,
  ProjectionOnIR,
  TypeIR,
  WireField,
} from "../../ir/types/loom-ir.js";
import { exprUsesCurrentUser, isMaterializedProjection } from "../../ir/types/loom-ir.js";
import { resolveErrorStatus } from "../../util/error-defaults.js";
import { snake, upperFirst } from "../../util/naming.js";
import {
  collectWireUsings,
  csIdValueClrType,
  dtoParam,
  projectToResponse,
  wireType,
} from "./dto-mapping.js";
import { dotnetNotFoundThrow } from "./emit/common.js";
import { dapperProjectionColumns } from "./emit/dapper-workflow.js";
import {
  projectionRowClass,
  projectionRowDbSet,
  projectionRowTable,
} from "./projection-state-emit.js";
import { collectCsExprUsings, renderCsExpr } from "./render-expr.js";
import { renderExprWithEventParam } from "./workflow-emit.js";

// ---------------------------------------------------------------------------
// Projection dispatch + read routes (.NET / ASP.NET + EF Core), projection.md.
//
//   - fold handler: one Mediator `INotificationHandler<TEvent>` per (projection,
//     event) — load-or-allocate the read-model row keyed by the correlation
//     column, write each `:=`, SaveChanges.  Every event allocates (a projection
//     has no route-or-drop split), and the body is pure (no emit, no saves).
//     Mediator auto-discovers the handler by assembly scan, so no DI wiring.
//   - read routes: a `<Ctx>ProjectionsController` exposing GET
//     /<prefix>projections/<snake> (list) + /<snake>/{key} (one by correlation
//     id, 404 if absent), projecting each row through the projection wireShape.
//
// Subscriptions are re-derived WITH projections (like python's
// `dispatchSubscriptionsOf`) because the enricher-stored `ctx.eventSubscriptions`
// omits folds — index.ts also OR-s projections into `hasSubscriptions` so a
// projection-only context still gets the Mediator dispatcher + IDomainEvent
// notification plumbing.
// ---------------------------------------------------------------------------

/** Every non-key column is nullable → wrap the wire field's type as optional so
 *  the DTO field (`Guid?` / `OrderStatus?`) + the null-safe `projectToResponse`
 *  projection match the nullable read-model row (python-parity).  The
 *  correlation field (`source: "id"`) stays non-nullable (the NOT NULL key). */
export function wireFieldType(f: WireField): TypeIR {
  if (f.source === "id" || f.type.kind === "optional") return f.type;
  return { kind: "optional", inner: f.type };
}

/** The correlation id's value type (drives the `{key}` route-param CLR type). */
function projectionCorrValueType(
  proj: ProjectionIR,
): import("../../ir/types/loom-ir.js").IdValueType {
  const corrField = proj.stateFields.find((f) => f.name === proj.correlationField);
  const t =
    corrField && corrField.type.kind === "optional" ? corrField.type.inner : corrField?.type;
  return t && t.kind === "id" ? t.valueType : "guid";
}

// ---------------------------------------------------------------------------
// Fold dispatch
// ---------------------------------------------------------------------------

/** Emit one `INotificationHandler<TEvent>` per projection fold.  No-op when the
 *  context declares no projection (byte-identical). */
export function emitProjectionDispatch(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  const subs = deriveEventSubscriptions(ctx.channels, ctx.workflows, ctx.projections);
  for (const s of subs) {
    if (!s.projection) continue;
    const proj = ctx.projections.find((p) => p.name === s.projection);
    if (!proj) continue;
    const on = proj.handlers.find((h) => h.event === s.event && h.param === s.param);
    if (!on) continue;
    const cls = projectionHandlerClass(proj, on);
    out.set(`Application/Workflows/${cls}.cs`, renderProjectionFoldHandler(cls, proj, on, ns));
  }
}

function projectionHandlerClass(proj: ProjectionIR, on: ProjectionOnIR): string {
  return `${upperFirst(proj.name)}On${upperFirst(on.event)}Handler`;
}

/** The pure fold: load-or-allocate the row for the event's key, apply each `:=`
 *  as `state.<Prop> = <expr>`, SaveChanges.  The correlation `:=` is skipped
 *  (the immutable key, seeded at allocation). */
function renderProjectionFoldHandler(
  className: string,
  proj: ProjectionIR,
  on: ProjectionOnIR,
  ns: string,
): string {
  const corr = proj.correlationField as string;
  const corrPascal = upperFirst(corr);
  const rowCls = projectionRowClass(proj);
  const usings = new Set<string>();
  // Routing key: the `by <expr>` value (event param → `notification`), else the
  // event field name-matching the correlation field (the omitted-`by` rule).
  const keyExpr = on.correlation
    ? renderExprWithEventParam(on.correlation, on.param)
    : `notification.${corrPascal}`;
  if (on.correlation) collectCsExprUsings(on.correlation, usings, ns);
  const assignLines: string[] = [];
  for (const s of on.statements) {
    if (s.kind !== "assign") continue;
    const seg = s.target.segments[0] ?? "";
    if (snake(seg) === snake(corr)) continue; // immutable key
    collectCsExprUsings(s.value, usings, ns);
    assignLines.push(
      `        state.${upperFirst(seg)} = ${renderExprWithEventParam(s.value, on.param, undefined, "state")};`,
    );
  }
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  return (
    `// Auto-generated.
using System.Threading;
using System.Threading.Tasks;${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using Mediator;
using ${ns}.Domain.Events;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence.Projections;

namespace ${ns}.Application.Workflows;

// Read-model fold via the domain IReadModelStore port (audit S7 Slice C), NOT
// the concrete AppDbContext.  FindAsync returns the EF change-TRACKED row, so
// the ` +
    "`state.<Prop> = …; SaveChangesAsync()`" +
    ` upsert persists unchanged;
// the EF adapter delegates to the same scoped DbContext.
public sealed class ${className} : INotificationHandler<${on.event}>
{
    private readonly global::${ns}.Domain.Common.IReadModelStore<${rowCls}> _readModel;
    public ${className}(global::${ns}.Domain.Common.IReadModelStore<${rowCls}> readModel) => _readModel = readModel;

    public async ValueTask Handle(${on.event} notification, CancellationToken cancellationToken)
    {
        var __key = ${keyExpr};
        var state = await _readModel.FindAsync(x => x.${corrPascal} == __key, cancellationToken);
        if (state is null)
        {
            state = new ${rowCls} { ${corrPascal} = __key };
            _readModel.Add(state);
        }
${assignLines.length > 0 ? assignLines.join("\n") + "\n" : ""}        await _readModel.SaveChangesAsync(cancellationToken);
    }
}
`
  );
}

// ---------------------------------------------------------------------------
// Read routes
// ---------------------------------------------------------------------------

/** Emit the `<Proj>Response` DTOs + the `<Ctx>ProjectionsController`.  No-op
 *  when the context declares no projection (byte-identical). */
export function emitProjectionReads(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
  options?: { routePrefix?: string; usingDapper?: boolean },
): void {
  // FOLDED (materialized) projections only — the event-folded read model with a
  // physical `<Proj>Row` table.  Query-time projections (read-path-architecture.md
  // rev.13) have no read-model row; they are served by `emitQueryProjections`.
  const folded = ctx.projections.filter(isMaterializedProjection);
  if (folded.length === 0) return;
  for (const proj of folded) {
    out.set(
      `Application/Workflows/${upperFirst(proj.name)}Response.cs`,
      renderProjectionResponseDto(proj, ctx, ns),
    );
  }
  out.set(
    `Api/${ctx.name}ProjectionsController.cs`,
    renderProjectionsController(ctx, ns, options?.routePrefix, !!options?.usingDapper),
  );
}

/** The `<Proj>Response` record — the projection wireShape projected to wire
 *  types, non-key fields nullable (partial read model). */
function renderProjectionResponseDto(
  proj: ProjectionIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  const params = (proj.wireShape ?? [])
    .map((f) =>
      dtoParam(wireType(wireFieldType(f), ctx, "response"), upperFirst(f.name), "response"),
    )
    .join(", ");
  return `// Auto-generated.
using System;
using System.ComponentModel.DataAnnotations;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;

namespace ${ns}.Application.Workflows;

public sealed record ${upperFirst(proj.name)}Response(${params});
`;
}

/** One controller per context exposing every projection as GET
 *  projections/<snake> + /<snake>/{key}, projecting each read-model row through
 *  the projection wireShape.
 *
 *  Persistence-gated (`usingDapper`, mirrors `emitWorkflowInstanceReads`): the EF
 *  path reads the EF-mapped `<Proj>Row` DbSet off the concrete `AppDbContext`;
 *  the Dapper path reads the `<Proj>Row` table with raw Npgsql SQL into a private
 *  `Row` DTO + `Map` to the same read-model POCO — the `wireShape` projection,
 *  operationIds, and route paths stay identical, so cross-backend OpenAPI parity
 *  holds. */
function renderProjectionsController(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  routePrefix?: string,
  usingDapper = false,
): string {
  const className = `${ctx.name}ProjectionsController`;
  const route = `${routePrefix ?? ""}projections`;
  const usings = new Set<string>();
  const blocks: string[] = [];
  // Dapper reads through NpgsqlDataSource with raw SQL: each projection SELECTs
  // its read-model table into a private `<T>DbRow` + `Map<T>` to the POCO (the
  // same `dapperProjectionColumns` shape the fold store persists — M-T6.9).
  const rowMapDecls: string[] = [];
  // Set when any projection's gate reads the principal — the controller then
  // takes `ICurrentUserAccessor` alongside its persistence handle.
  let needsCurrentUser = false;
  for (const proj of ctx.projections.filter(isMaterializedProjection)) {
    const slug = snake(proj.name);
    const T = upperFirst(proj.name);
    const dbSet = projectionRowDbSet(proj);
    const shape = proj.wireShape ?? [];
    for (const f of shape) collectWireUsings(wireFieldType(f), ctx, usings);
    const corr = shape.find((f) => f.source === "id");
    const corrName = upperFirst(proj.correlationField as string);
    const targetName = corr && corr.type.kind === "id" ? corr.type.targetName : "";
    // The `{key}` param binds the correlation id's CLR value type (Guid / int /
    // long / string), so Swashbuckle emits the matching param schema — parity
    // with the other backends by construction.
    const corrClr = csIdValueClrType(projectionCorrValueType(proj));
    const proj_ = (rowVar: string): string =>
      shape
        .map((f) => projectToResponse(`${rowVar}.${upperFirst(f.name)}`, wireFieldType(f), ctx))
        .join(", ");
    let listBody: string;
    let byIdBody: string;
    if (usingDapper) {
      const cols = dapperProjectionColumns(proj);
      const pkCol = snake(proj.correlationField as string);
      const table = projectionRowTable(proj);
      const pocoFqn = `global::${ns}.Infrastructure.Persistence.Projections.${projectionRowClass(proj)}`;
      const rowCls = `${T}DbRow`;
      const mapFn = `Map${T}`;
      rowMapDecls.push(
        `    private sealed class ${rowCls}\n    {\n` +
          cols
            .map(
              (c) =>
                `        public ${c.rowCs} ${c.col} { get; set; }${c.nullable ? "" : " = default!;"}`,
            )
            .join("\n") +
          `\n    }\n` +
          `    private static ${pocoFqn} ${mapFn}(${rowCls} r) => new()\n    {\n` +
          cols.map((c) => `        ${c.stateProp} = ${c.hydrate},`).join("\n") +
          `\n    };`,
      );
      const selCols = cols.map((c) => c.col).join(", ");
      listBody =
        `        await using var conn = await _db.OpenConnectionAsync();\n` +
        `        var rows = (await conn.QueryAsync<${rowCls}>(new CommandDefinition("SELECT ${selCols} FROM ${table}"))).Select(${mapFn});\n` +
        `        return Ok(rows.Select(x => new ${T}Response(${proj_("x")})));\n`;
      byIdBody =
        `        await using var conn = await _db.OpenConnectionAsync();\n` +
        `        var __row = await conn.QuerySingleOrDefaultAsync<${rowCls}>(new CommandDefinition("SELECT ${selCols} FROM ${table} WHERE ${pkCol} = @key", new { key }));\n` +
        // M-T6.31 — raise the shared carrier instead of `NotFound()`, so the app's
        // one 404 producer (`DomainExceptionFilter`) renders the envelope.  See
        // `dotnetNotFoundThrow`.
        `        if (__row is null) ${dotnetNotFoundThrow(ns, T, "key")}\n` +
        `        var x = ${mapFn}(__row);\n` +
        `        return Ok(new ${T}Response(${proj_("x")}));\n`;
    } else {
      listBody =
        `        var rows = await _db.${dbSet}.AsNoTracking().ToListAsync();\n` +
        `        return Ok(rows.Select(x => new ${T}Response(${proj_("x")})));\n`;
      byIdBody =
        `        var __key = new ${targetName}Id(key);\n` +
        `        var x = await _db.${dbSet}.AsNoTracking().FirstOrDefaultAsync(r => r.${corrName} == __key);\n` +
        `        if (x is null) ${dotnetNotFoundThrow(ns, T, "key")}\n` +
        `        return Ok(new ${T}Response(${proj_("x")}));\n`;
    }
    // Authorization gate (authorization.md) — the folded read model's twin of
    // the query-time projection's gate in `query-projection-emit.ts`: a
    // `currentUser`-only predicate evaluated BEFORE the read, throwing
    // `ForbiddenException` (→ 403 via the DomainExceptionFilter).  It guards
    // BOTH routes; on the by-key route it runs before the lookup, so a caller
    // who fails it cannot learn whether the key exists.
    const gate = proj.query?.requires;
    if (gate) {
      collectCsExprUsings(gate, usings);
      usings.add(`${ns}.Domain.Common`); // ForbiddenException
      if (exprUsesCurrentUser(gate)) {
        usings.add(`${ns}.Auth`); // ICurrentUserAccessor
        needsCurrentUser = true;
      }
    }
    const gateLines = gate
      ? (exprUsesCurrentUser(gate) ? `        var currentUser = _currentUser.User;\n` : "") +
        `        if (!(${renderCsExpr(gate)})) throw new ForbiddenException(${JSON.stringify(
          `Forbidden: projection ${proj.name}`,
        )});\n`
      : "";
    const forbiddenAttr = gate
      ? `    [ProducesResponseType(typeof(ProblemDetails), ${resolveErrorStatus(
          "Forbidden",
          ctx.structuralErrorStatuses,
        )})]\n`
      : "";
    blocks.push(
      `    [HttpGet("${slug}")]\n` +
        `    [ProducesResponseType(typeof(IEnumerable<${T}Response>), 200)]\n` +
        forbiddenAttr +
        `    public async Task<IActionResult> List${T}()\n` +
        `    {\n` +
        gateLines +
        listBody +
        `    }\n` +
        `    [HttpGet("${slug}/{key}")]\n` +
        `    [ProducesResponseType(typeof(${T}Response), 200)]\n` +
        forbiddenAttr +
        `    [ProducesResponseType(typeof(ProblemDetails), 404)]\n` +
        `    public async Task<IActionResult> Get${T}(${corrClr} key)\n` +
        `    {\n` +
        gateLines +
        byIdBody +
        `    }\n`,
    );
  }
  const extraUsings = [...usings].sort().map((n) => `using ${n};`);
  const persistenceUsings = usingDapper
    ? "using Dapper;\nusing Npgsql;"
    : "using Microsoft.EntityFrameworkCore;";
  const dbFieldType = usingDapper ? "NpgsqlDataSource" : "AppDbContext";
  const ctorField = needsCurrentUser
    ? `    private readonly ${dbFieldType} _db;\n` +
      `    private readonly ICurrentUserAccessor _currentUser;\n` +
      `    public ${className}(${dbFieldType} db, ICurrentUserAccessor currentUser)\n` +
      `    {\n        _db = db;\n        _currentUser = currentUser;\n    }`
    : `    private readonly ${dbFieldType} _db;\n    public ${className}(${dbFieldType} db) => _db = db;`;
  const memberDecls = usingDapper && rowMapDecls.length > 0 ? `${rowMapDecls.join("\n")}\n\n` : "";
  return `// Auto-generated.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
${persistenceUsings}${extraUsings.length > 0 ? "\n" + extraUsings.join("\n") : ""}
using ${ns}.Application.Workflows;
using ${ns}.Domain.Ids;
using ${ns}.Domain.ValueObjects;
using ${ns}.Domain.Enums;
using ${ns}.Infrastructure.Persistence;

namespace ${ns}.Api;

[ApiController]
[Route("${route}")]
public sealed class ${className} : ControllerBase
{
${ctorField}

${memberDecls}${blocks.join("\n")}
}
`;
}
