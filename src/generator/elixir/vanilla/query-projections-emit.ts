// ---------------------------------------------------------------------------
// Vanilla foundation — query-time projection emission
// (read-path-architecture.md rev.13, § "projection generalises").
//
// A QUERY-TIME projection (`from <Agg> [as a] where … join … select …`, no
// `on(e)` folds) is the always-current read model of the query-time projection
// read.  Unlike a FOLDED projection it has NO physical `<Proj>Row` table — it
// reads live, the query-time comprehension:
//
//   - source rows come from `from(record in <SourceAgg>, where: <filter+cap>)
//     |> Repo.all()` (the projection `where`, AND-ed with the source
//     aggregate's capability filter — same read guard every other read honours);
//   - each `join <Agg> as a on <idRef>` is a batched bulk-load-by-id: Elixir
//     `X id` fields are plain FK columns (`:binary_id`), NOT `belongs_to`
//     associations, so there is no Ecto preload to follow — the join loads the
//     referenced aggregates through `Repo.all()` into an id→struct `Map` (the
//     analogue of Hono's `findManyByIds` map / Python's `find_many_by_ids`);
//   - each `select f = <expr>` projects one row: a member read on a join alias
//     (`c.name`) rewrites to `Map.get(<mapVar>, <idRow>).name`, everything else
//     renders off the source `record`.
//
// One module per projection (`lib/<app>/<ctx>/query_projections/<snake>.ex`)
// exposing `run/1`, plus a project-wide `QueryProjectionsController` with a
// `GET /api/projections/<slug>` action per projection (sibling of
// `ViewsController`; the folded read model keeps its own `ProjectionsController`
// at the same `/projections` prefix — distinct projection names ⇒ distinct
// slugs ⇒ no route collision).  Only backends in `PROJECTION_QT_SUPPORTED`
// (`src/ir/validate/checks/system-checks.ts`) are permitted a query-time
// projection by the IR validator; elixir joins node/python here.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  EnrichedBoundedContextIR,
  ExprIR,
  ProjectionIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesPrincipalContextFilter,
  isQueryTimeProjection,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import { combineWhere, vanillaCapabilityFilter } from "./capability-filter.js";

/** One project-wide query-time projection, paired with its owning context. */
export interface VanillaQueryProjectionRef {
  ctx: EnrichedBoundedContextIR;
  proj: ProjectionIR;
}

/** Emit the per-projection `run/1` module for every query-time projection in a
 *  context (`lib/<app>/<ctx>/query_projections/<snake>.ex`), collecting the
 *  `{ ctx, proj }` refs the project-wide controller is built from. */
export function emitVanillaQueryProjectionModules(
  appName: string,
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  sourcemap?: SourceMapRecorder,
): VanillaQueryProjectionRef[] {
  const projs = ctx.projections.filter(isQueryTimeProjection);
  if (projs.length === 0) return [];
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const typesModule = `${appModule}.Types`;
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const refs: VanillaQueryProjectionRef[] = [];
  for (const proj of projs) {
    const path = `lib/${appName}/${ctxSnake}/query_projections/${snake(proj.name)}.ex`;
    const content = renderQueryProjectionModule(
      proj,
      appModule,
      contextModule,
      typesModule,
      aggsByName,
    );
    out.set(path, content);
    sourcemap?.file(path, content, proj.origin, `${ctx.name}.${proj.name}`);
    refs.push({ ctx, proj });
  }
  return refs;
}

/** A query-time projection module: source find + per-`join` bulk-load-by-id map
 *  + per-`select` projection.  Returns plain maps (camelCase atom keys → wire
 *  keys), so the controller `json/2`s them directly (no `serialize/1`). */
function renderQueryProjectionModule(
  proj: ProjectionIR,
  appModule: string,
  contextModule: string,
  typesModule: string,
  aggsByName: Map<string, AggregateIR>,
): string {
  const query = proj.query!;
  const source = query.source!;
  const sourceMod = `${contextModule}.${upperFirst(source)}`;
  const moduleName = `${contextModule}.QueryProjections.${upperFirst(proj.name)}`;
  const sourceAgg = aggsByName.get(source);

  // In-memory projection context (enum → declared atom); the `where` below uses
  // a `filterArgs` clone (enum → dumped declared string — Ecto won't cast an
  // inline atom through `Ecto.Enum`).
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    foundation: "vanilla",
  };
  const queryCtx: RenderCtx = { ...renderCtx, filterArgs: true };

  // The source read honours the source aggregate's capability filter (soft
  // delete / tenancy) exactly like every other read; a principal (tenancy)
  // filter scopes by the `current_user` the controller threads into `run/1`.
  const principal = sourceAgg ? aggregateUsesPrincipalContextFilter(sourceAgg) : false;
  // A projection `… ignoring <Cap>` / `ignoring *` OMITS the named capability
  // filter(s) on the source aggregate for this read only (plain Ecto drops the
  // bypassed `where:` conjunct).
  const cap = sourceAgg
    ? vanillaCapabilityFilter(sourceAgg, contextModule, {
        actor: principal,
        bypass:
          query.bypassAll || (query.bypassCaps?.length ?? 0) > 0
            ? { bypassAll: query.bypassAll, bypassCaps: query.bypassCaps }
            : undefined,
      })
    : null;
  const filter = query.filter ? renderExpr(query.filter, queryCtx) : null;
  const where = combineWhere(filter, cap);

  const lines: string[] = [];
  lines.push(principal ? "" : "    _ = current_user");
  lines.push("    rows =");
  if (where) {
    lines.push(`      from(record in ${sourceMod}, where: ${where})`);
    lines.push(`      |> Repo.all()`);
  } else {
    lines.push(`      Repo.all(${sourceMod})`);
  }

  // Each `join <Agg> as a on <idRef>` → a batched id→struct map.  The alias `a`
  // is bound to `{ mapVar, idRow }` so a `select … = a.field` reads through it.
  const aliasMap = new Map<string, { mapVar: string; idRow: string }>();
  const joins = query.joins;
  const auxes = query.auxiliaries;
  for (let i = 0; i < auxes.length; i++) {
    const aux = auxes[i]!;
    const join = joins[i];
    const mapVar = snake(aux.mapVar);
    const followMod = `${contextModule}.${upperFirst(aux.aggName)}`;
    const idRow = join ? renderExpr(join.idRef, renderCtx) : `record.${snake(aux.path[0] ?? "id")}`;
    lines.push(`    ${mapVar} =`);
    lines.push(
      `      from(row in ${followMod}, where: row.id in ^Enum.map(rows, fn record -> ${idRow} end))`,
    );
    lines.push(`      |> Repo.all()`);
    lines.push(`      |> Map.new(&{&1.id, &1})`);
    if (join) aliasMap.set(join.alias, { mapVar, idRow });
  }

  const selects = query.selects ?? [];
  lines.push(`    Enum.map(rows, fn record ->`);
  lines.push(`      %{`);
  selects.forEach((s, i) => {
    const tail = i === selects.length - 1 ? "" : ",";
    lines.push(`        ${s.field}: ${renderSelectEcto(s.expr, aliasMap, renderCtx)}${tail}`);
  });
  lines.push(`      }`);
  lines.push(`    end)`);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Query-time projection: ${upperFirst(proj.name)}

  Source aggregate: ${upperFirst(source)}
  Form: query-time (live read — no folded read-model table)
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the query-time projection and return the projected rows."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
${lines.filter((l) => l !== "").join("\n")}
  end
end
`;
}

/** Render one `select` expression against the source `record` and the join
 *  alias maps.  A member read on a join alias (`c.name`, where `c` is a `join
 *  Customer as c on <idRef>`) rewrites to `Map.get(<mapVar>, <idRow>).name` —
 *  the loaded-by-id aggregate for this row.  Source-candidate reads (`o.id`,
 *  bare `lineCount`) lower to `this`/row refs and render off `record`. */
function renderSelectEcto(
  expr: ExprIR,
  aliasMap: Map<string, { mapVar: string; idRow: string }>,
  ctx: RenderCtx,
): string {
  if (expr.kind === "member" && expr.receiver.kind === "ref") {
    const alias = aliasMap.get(expr.receiver.name);
    if (alias) return `Map.get(${alias.mapVar}, ${alias.idRow}).${snake(expr.member)}`;
  }
  return renderExpr(expr, ctx);
}

/** The single project-wide `QueryProjectionsController` over every hosted
 *  context's query-time projections (sibling of `ViewsController`), plus the
 *  read routes (`GET /projections/<slug>` per projection).  Returns `[]` (and
 *  emits nothing) when there are no query-time projections. */
export function emitVanillaQueryProjectionsController(
  appName: string,
  appModule: string,
  projections: VanillaQueryProjectionRef[],
  out: Map<string, string>,
): ApiRoute[] {
  if (projections.length === 0) return [];
  const webModule = `${appModule}Web`;
  const actions = projections
    .map(({ ctx, proj }) => renderQueryProjectionAction(ctx, proj, appModule))
    .join("\n\n");

  out.set(
    `lib/${appName}_web/controllers/query_projections_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.QueryProjectionsController do
  use ${webModule}, :controller

  @moduledoc """
  Read-only HTTP entry points for query-time projections
  (read-path-architecture.md).  Each action delegates to the matching
  projection module's run/1 (a live read — source find + join bulk-loads +
  select projection) and encodes the projected rows.
  """

${actions}
end
`,
  );

  return projections.map(({ proj }) => ({
    method: "get" as const,
    path: `/projections/${snake(proj.name)}`,
    controller: "QueryProjectionsController",
    action: `:${snake(proj.name)}`,
  }));
}

function renderQueryProjectionAction(
  ctx: EnrichedBoundedContextIR,
  proj: ProjectionIR,
  appModule: string,
): string {
  const slug = snake(proj.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const projModule = `${contextModule}.QueryProjections.${upperFirst(proj.name)}`;
  return `  @doc "GET /api/projections/${slug}"
  def ${slug}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)
    data = ${projModule}.run(current_user)
    json(conn, data)
  end`;
}
