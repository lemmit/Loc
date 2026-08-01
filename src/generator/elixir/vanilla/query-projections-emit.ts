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
  ProjectionAggregateIR,
  ProjectionIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import {
  aggregateUsesPrincipalContextFilter,
  isQueryTimeProjection,
} from "../../../ir/types/loom-ir.js";
import {
  type AggregateSelect,
  aggregateCoercion,
  GROUP_KEY_TRANSFORM_INTRINSIC,
  type GroupKeySelect,
  groupedAggregates,
  groupKeyOf,
  wholeTableAggregates,
} from "../../../ir/util/projection-aggregate.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { projectionRowModule, stateModule } from "../dispatch-emit.js";
import { ECTO_INTRINSIC_FRAGMENTS, type RenderCtx, renderExpr } from "../render-expr.js";
import { combineWhere, vanillaCapabilityFilter } from "./capability-filter.js";
import { denialOverrides, denialResponse } from "./denial.js";
import { hasRefColls, preloadSuffix } from "./ref-collection-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

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
  const wfsByName = new Map(ctx.workflows.map((w) => [w.name, w] as const));
  const projsByName = new Map(ctx.projections.map((p) => [p.name, p] as const));
  const refs: VanillaQueryProjectionRef[] = [];
  for (const proj of projs) {
    const path = `lib/${appName}/${ctxSnake}/query_projections/${snake(proj.name)}.ex`;
    const content = renderQueryProjectionModule(
      proj,
      appModule,
      contextModule,
      typesModule,
      ctx,
      aggsByName,
      wfsByName,
      projsByName,
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
  ctx: EnrichedBoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
  wfsByName: Map<string, WorkflowIR>,
  projsByName: Map<string, ProjectionIR>,
): string {
  const query = proj.query!;
  const source = query.source!;
  const moduleName = `${contextModule}.QueryProjections.${upperFirst(proj.name)}`;
  // A workflow-sourced projection reads the workflow's persisted saga-state
  // Ecto schema (`<Wf>State`) — NON-event-sourced by validation — not an
  // aggregate schema module; it has no aggregate capability filter to honour.
  const wf = query.sourceKind === "workflow" ? wfsByName.get(source) : undefined;
  // A projection-sourced projection reads the SOURCE folded projection's
  // materialized read-model Ecto schema (`<Proj>Row`) — not an aggregate schema
  // module; it has no aggregate capability filter to honour.
  const srcProj = query.sourceKind === "projection" ? projsByName.get(source) : undefined;
  const sourceMod = wf
    ? stateModule(contextModule, wf)
    : srcProj
      ? projectionRowModule(contextModule, srcProj)
      : `${contextModule}.${upperFirst(source)}`;
  const sourceAgg = wf || srcProj ? undefined : aggsByName.get(source);

  // SHORTHAND projection (`projection P { from <Agg> as a where … }` — no
  // declared fields, no `select`): the enriched `<Proj>Row` shape equals the
  // SOURCE AGGREGATE's full wire shape, so each row must be that aggregate's own
  // domain→wire serialization (exactly what its findAll returns per record) —
  // NOT an empty select-projected map.  Detected only for an aggregate source
  // (workflow/projection sources always carry selects).  Falls back to the
  // existing select-projection path when the source aggregate can't be resolved.
  const isShorthand =
    sourceAgg !== undefined &&
    (query.sourceKind === undefined || query.sourceKind === "aggregate") &&
    (query.selects?.length ?? 0) === 0;

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

  // A shorthand row is the source aggregate's own wire serialization, so any
  // reference-collection relationships must be preloaded on the source read (the
  // aggregate's own findAll preloads them too) for `__ref_ids/1` to project ids.
  const preload = isShorthand && sourceAgg ? preloadSuffix(sourceAgg).trim() : "";

  const lines: string[] = [];
  lines.push(principal ? "" : "    _ = current_user");

  // GROUPED AGGREGATION (M-T4.2) — `group by` present: ONE ROW PER DISTINCT
  // GROUP, computed in SQL as a single Ecto query with `group_by:` over the
  // grouping columns and the aggregates in the `select`.  `order_by:` over the
  // same columns is REQUIRED — deterministic cross-backend reads.  The response
  // is the LIST shape (like the per-row read), never the singleton map.
  const grouped = groupedAggregates(proj);
  if (grouped) {
    // One renderer for every key position (SELECT, `group_by:`, `order_by:`)
    // so the three can't disagree — Postgres matches a grouped select against
    // the GROUP BY expression syntactically, and a bare column in the select
    // with a truncated column in the group_by is a hard SQL error.  A COMPUTED
    // key (M-T4.2 date bucket) reuses the SAME Ecto fragment the `where`
    // position emits for that intrinsic, so a `group by o.placedAt.startOfDay()`
    // and a `where o.placedAt.startOfDay() == …` render byte-identically.
    const keyExpr = (e: ExprIR): string => {
      const key = groupKeyOf(e);
      if (key === null) {
        throw new Error(
          "internal: a grouped projection's key must name a source column — the IR validator should have rejected this projection",
        );
      }
      const col = `record.${snake(key.column)}`;
      if (key.transform === undefined) return col;
      const frag = ECTO_INTRINSIC_FRAGMENTS[GROUP_KEY_TRANSFORM_INTRINSIC[key.transform]];
      if (!frag) {
        throw new Error(`internal: no Ecto fragment for grouping-key transform '${key.transform}'`);
      }
      return frag(col, []);
    };
    const groupCols = grouped.groupBy.map(keyExpr);
    const groupClause = groupCols.length === 1 ? groupCols[0]! : `[${groupCols.join(", ")}]`;
    const selectCols = [
      ...grouped.keys.map((k) => `${k.field}: ${keyExpr(k.expr)}`),
      ...grouped.aggregates.map((a) => `${a.field}: ${ectoAggregate(a.aggregate)}`),
    ].join(", ");
    lines.push("    rows =");
    lines.push(
      where
        ? `      from(record in ${sourceMod}, where: ${where}, group_by: ${groupClause}, order_by: ${groupClause}, select: %{${selectCols}})`
        : `      from(record in ${sourceMod}, group_by: ${groupClause}, order_by: ${groupClause}, select: %{${selectCols}})`,
    );
    lines.push(`      |> Repo.all()`);
    lines.push(`    Enum.map(rows, fn row ->`);
    lines.push(`      %{`);
    const entries = [
      ...grouped.keys.map(
        (k) =>
          `${k.field}: ${ectoKeyCoerce(k, `row.${k.field}`, groupKeyOf(k.expr)?.transform !== undefined)}`,
      ),
      ...grouped.aggregates.map((a) => `${a.field}: ${ectoCoerce(a, `row.${a.field}`)}`),
    ];
    const needsUtcHelper = grouped.keys.some((k) => {
      const inner = k.type.kind === "optional" ? k.type.inner : k.type;
      return (
        groupKeyOf(k.expr)?.transform !== undefined &&
        inner.kind === "primitive" &&
        inner.name === "datetime"
      );
    });
    entries.forEach((e, i) => {
      lines.push(`        ${e}${i === entries.length - 1 ? "" : ","}`);
    });
    lines.push(`      }`);
    lines.push(`    end)`);
    return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Query-time projection: ${upperFirst(proj.name)}
  Source aggregate: ${upperFirst(source)}
  Form: query-time GROUPED aggregation (one row per group, computed in SQL).
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the grouped aggregation and return one projected row per group."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
${lines.filter((l) => l !== "").join("\n")}
  end
${
  needsUtcHelper
    ? `
  # A bucketed grouping key is SELECTed as a raw \`fragment\`, which bypasses
  # Ecto's schema type mapping — Postgrex returns a \`%NaiveDateTime{}\` with
  # microsecond precision where the schema-typed \`:utc_datetime\` field would
  # give a second-precision \`%DateTime{}\`.  Without this the key serialised
  # \`2026-08-01T00:00:00.000000\` instead of \`2026-08-01T00:00:00Z\`, diverging
  # from the other four backends.  Accepts either shape so a driver that
  # already hands back a \`%DateTime{}\` stays correct.
  defp group_key_utc(%DateTime{} = dt), do: DateTime.truncate(dt, :second)

  defp group_key_utc(%NaiveDateTime{} = ndt),
    do: ndt |> DateTime.from_naive!("Etc/UTC") |> DateTime.truncate(:second)
`
    : ""
}end
`;
  }

  // WHOLE-TABLE AGGREGATION (M-T1.3 Phase 0) — ONE Ecto query with
  // `count`/`sum`/`avg`/`min`/`max` in the `select`, no rows loaded.  The shape
  // exists precisely to avoid the naive read: `Repo.all/1` over the whole table
  // with every row hydrated into a struct to produce one integer.
  const aggregates = wholeTableAggregates(proj);
  if (aggregates) {
    const cols = aggregates.map((a) => `${a.field}: ${ectoAggregate(a.aggregate)}`).join(", ");
    lines.push("    row =");
    lines.push(
      where
        ? `      from(record in ${sourceMod}, where: ${where}, select: %{${cols}})`
        : `      from(record in ${sourceMod}, select: %{${cols}})`,
    );
    lines.push(`      |> Repo.one()`);
    lines.push("    %{");
    aggregates.forEach((a, i) => {
      const tail = i === aggregates.length - 1 ? "" : ",";
      lines.push(`      ${a.field}: ${ectoCoerce(a, `row.${a.field}`)}${tail}`);
    });
    lines.push("    }");
    return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Query-time projection: ${upperFirst(proj.name)}
  Source aggregate: ${upperFirst(source)}
  Form: query-time WHOLE-TABLE AGGREGATION (one row, computed in SQL).
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the whole-table aggregation and return the single projected row."
  @spec run(any()) :: map()
  def run(current_user \\\\ nil) do
${lines.filter((l) => l !== "").join("\n")}
  end
end
`;
  }

  lines.push("    rows =");
  if (where) {
    lines.push(`      from(record in ${sourceMod}, where: ${where})`);
    lines.push(`      |> Repo.all()`);
  } else {
    lines.push(`      Repo.all(${sourceMod})`);
  }
  if (preload) lines.push(`      ${preload}`);

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

  // Shorthand: reuse the aggregate's OWN wireShape-driven `serialize/1` (+ its
  // nested part/VO helpers, and `__ref_ids/1` when the aggregate has reference
  // collections) so each row == the aggregate wire shape (id / props / derived /
  // version), byte-identical to what its findAll returns.  Emitted as private
  // functions on this module and mapped over the source rows.
  let projectionHelpers = "";
  if (isShorthand && sourceAgg) {
    lines.push(`    Enum.map(rows, &serialize/1)`);
    const wire = renderWireSerialize(sourceAgg, ctx, { contextModule });
    const refIds = hasRefColls(sourceAgg)
      ? `

  defp __ref_ids(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_ids(records) when is_list(records), do: Enum.map(records, & &1.id)
  defp __ref_ids(_), do: []`
      : "";
    projectionHelpers = `\n\n${wire.serialize}${
      wire.helpers.length > 0 ? `\n\n${wire.helpers.join("\n\n")}` : ""
    }${refIds}`;
  } else {
    const selects = query.selects ?? [];
    lines.push(`    Enum.map(rows, fn record ->`);
    lines.push(`      %{`);
    selects.forEach((s, i) => {
      const tail = i === selects.length - 1 ? "" : ",";
      lines.push(`        ${s.field}: ${renderSelectEcto(s.expr, aliasMap, renderCtx)}${tail}`);
    });
    lines.push(`      }`);
    lines.push(`    end)`);
  }

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  Query-time projection: ${upperFirst(proj.name)}

  ${wf ? "Source workflow" : srcProj ? "Source projection" : "Source aggregate"}: ${upperFirst(source)}${wf ? " (saga instance state)" : srcProj ? " (read-model rows)" : ""}
  Form: query-time (live read — no folded read-model table)
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the query-time projection and return the projected rows."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
${lines.filter((l) => l !== "").join("\n")}
  end${projectionHelpers}
end
`;
}

/** The Ecto aggregate call for one `select`.  `count` counts ROWS (Ecto needs a
 *  column, so it counts the primary key — equivalent to `COUNT(*)` for a table
 *  whose id is non-null); the rest take the aggregated column off `record`. */
function ectoAggregate(agg: ProjectionAggregateIR): string {
  if (agg.op === "count" || !agg.arg) return "count(record.id)";
  const arg = agg.arg;
  if (arg.kind !== "member") {
    throw new Error(
      "internal: a whole-table aggregation argument must be a source column reference",
    );
  }
  return `${agg.op}(record.${snake(arg.member)})`;
}

/** Coerce one aggregate result to the row's declared wire type.
 *
 *  Ecto returns a numeric aggregate over a `:decimal` column as a `%Decimal{}`
 *  and `nil` over an empty table.  `money` rides the Elixir wire as a STRING
 *  (Jason encodes a bare `%Decimal{}` as one, which is exactly what money
 *  wants); a plain `decimal` must ship as a NUMBER (RS-24), so it goes through
 *  `Decimal.to_float/1` — the same split `wire-serialize.ts` makes, and getting
 *  it wrong would put a string where the other four backends put a number. */
function ectoCoerce(s: AggregateSelect, read: string): string {
  const c = aggregateCoercion(s);
  const inner = s.type.kind === "optional" ? s.type.inner : s.type;
  if (c.isCount) return `${read} || 0`;
  if (c.asString) {
    return c.optional
      ? `if(is_nil(${read}), do: nil, else: to_string(${read}))`
      : `to_string(${read} || 0)`;
  }
  if (inner.kind === "primitive" && inner.name === "decimal") {
    const num = `Decimal.to_float(Decimal.new(to_string(${read})))`;
    return c.optional
      ? `if(is_nil(${read}), do: nil, else: ${num})`
      : `if(is_nil(${read}), do: 0.0, else: ${num})`;
  }
  return c.optional ? read : `${read} || 0`;
}

/** Coerce one grouping-key value to the row's DECLARED wire type.
 *
 *  Ecto's map-`select` loads schema fields through their types exactly like a
 *  struct read, so most keys pass through as the per-row arm ships them: an
 *  `Ecto.Enum` field is an atom (Jason encodes it as the declared string), a
 *  `:binary_id` id is already a string, ints/strings/datetimes are themselves.
 *  The exceptions are the RS-24 split the per-row serializers make: `money`
 *  rides the Elixir wire as a STRING (`%Decimal{}` → `to_string`) and a plain
 *  `decimal` as a NUMBER (`Decimal.to_float`).  Keys are never zero-defaulted —
 *  a group's key value is whatever the column holds (nil only when optional). */
function ectoKeyCoerce(k: GroupKeySelect, read: string, viaFragment = false): string {
  const inner = k.type.kind === "optional" ? k.type.inner : k.type;
  const optional = k.type.kind === "optional";
  // A TRANSFORMED key is selected as a raw `fragment`, which bypasses Ecto's
  // schema type mapping: Postgrex hands back a `%NaiveDateTime{}` with
  // microsecond precision, so the key serialised `2026-08-01T00:00:00.000000`
  // where a schema-typed `:utc_datetime` field (and every other backend)
  // gives `2026-08-01T00:00:00Z`.  Normalise back onto the field convention.
  if (viaFragment && inner.kind === "primitive" && inner.name === "datetime") {
    const norm = `group_key_utc(${read})`;
    return optional ? `if(is_nil(${read}), do: nil, else: ${norm})` : norm;
  }
  if (inner.kind === "primitive" && inner.name === "money") {
    return optional
      ? `if(is_nil(${read}), do: nil, else: to_string(${read}))`
      : `to_string(${read})`;
  }
  if (inner.kind === "primitive" && inner.name === "decimal") {
    const num = `Decimal.to_float(Decimal.new(to_string(${read})))`;
    return optional ? `if(is_nil(${read}), do: nil, else: ${num})` : num;
  }
  return read;
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
  const webModule = `${appModule}Web`;
  // Read-side `requires` authorization gate (default-deny): a 403 returned
  // before the query runs when the `currentUser`-only predicate fails — the
  // read-side analogue of a repository `find … requires <gate>` (mirrors
  // `renderFindActions`).  Ungated projections stay byte-identical.
  const gate = proj.query?.requires
    ? renderExpr(proj.query.requires, {
        thisName: "record",
        contextModule,
        foundation: "vanilla",
      })
    : null;
  if (gate) {
    return `  @doc "GET /api/projections/${slug}"
  def ${slug}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)

    if not (${gate}) do
      ${denialResponse(
        "forbidden",
        JSON.stringify(`Forbidden: projection ${proj.name}`),
        denialOverrides(ctx),
        `${webModule}.ProblemDetails`,
      )}
    else
      data = ${projModule}.run(current_user)
      json(conn, data)
    end
  end`;
  }
  return `  @doc "GET /api/projections/${slug}"
  def ${slug}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)
    data = ${projModule}.run(current_user)
    json(conn, data)
  end`;
}
