// ---------------------------------------------------------------------------
// Vanilla foundation — `view` emission (vanilla-foundation-tdd-plan.md slice 5;
// D-VANILLA-PHOENIX-FOUNDATION).
//
// A `view` is a plain Ecto query.  Two forms:
//
//   - Shorthand (`view X = Agg where filter`): emit
//       from(record in <Agg>, where: <filter>) |> Repo.all()
//     (or `Repo.all(<Agg>)` when there is no filter), returning the
//     aggregate's structs.
//   - Full form (`view X { fields ... bind ... }`): emit
//       from(record in <Agg>, where: <filter>)
//       |> Repo.all()
//       |> Repo.preload([:assoc, ...])      # only when binds traverse assocs
//       |> Enum.map(fn record -> %{ <binds> } end)
//
// The enum-value / `^arg` divergence is handled by render-expr's
// `foundation: "vanilla"` flag (slice 0): `status == Confirmed` renders as
// `record.status == "confirmed"` (string column), not `:confirmed` atoms.
//
// A single project-wide `<App>Web.ViewsController` exposes
// `GET /api/views/<snake>` per view; the routes are spliced into the `/api`
// scope by `shell-emit.ts`.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ProjectionIR,
  ViewIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { SourceMapRecorder } from "../../_trace/sourcemap.js";
import type { ApiRoute } from "../api-emit.js";
import { projectionRowModule, stateModule } from "../dispatch-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  aggregateUsesPrincipalContextFilter,
  combineWhere,
  vanillaCapabilityFilter,
} from "./capability-filter.js";
import { hasRefColls } from "./ref-collection-emit.js";
import { renderWireSerialize } from "./wire-serialize.js";

/** One project-wide view, paired with its owning context (for module-path
 *  resolution in the controller). */
export interface VanillaViewRef {
  ctx: BoundedContextIR;
  view: ViewIR;
}

/** Emit the per-view Ecto query modules for one context.
 *  `lib/<app>/<ctx>/views/<view>.ex`. */
export function emitVanillaViewModules(
  appName: string,
  appModule: string,
  ctx: BoundedContextIR,
  out: Map<string, string>,
  sourcemap?: SourceMapRecorder,
): void {
  if (ctx.views.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const typesModule = `${appModule}.Types`;

  for (const view of ctx.views) {
    // Workflow-sourced view (workflow-instance-views.md): a curated saga
    // projection over the correlation instance read model, the read-side sibling
    // of the instance endpoints (workflow-instances-emit.ts).  Only observable
    // (correlation-bearing) workflows have an `instanceWireShape` — a state-table
    // saga reads its `<Wf>State` Ecto schema, an event-sourced workflow folds the
    // `<wf>_events` stream and filters the instances in memory
    // (renderVanillaWorkflowView branches on `wf.eventSourced`).
    if (view.source.kind === "workflow") {
      const wf = ctx.workflows.find((w) => w.name === view.source.name);
      if (!wf?.instanceWireShape) continue; // validator gated / not observable
      const path = `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`;
      const content = renderVanillaWorkflowView(view, wf, appModule, contextModule, typesModule);
      out.set(path, content);
      sourcemap?.file(path, content, view.origin, `${ctx.name}.${view.name}`);
      continue;
    }
    // Projection-sourced view (projection.md v1.1): rows come from a direct
    // `<Proj>Row` read-model table SELECT (the read-side sibling of the
    // projection LIST endpoint, projections-emit.ts) with the view filter pushed
    // into the query — no repository/context, like the state-based workflow arm
    // above.  Unlike a workflow view, the full-form (bind-projected) shape IS
    // supported, but the `<Proj>Row` schema is FLAT (no `belongs_to`), so an
    // `X id` bind-follow bulk-loads the foreign aggregate explicitly by id
    // (`from a in <Agg>, where: a.id in ^ids`) rather than `Repo.preload`ing an
    // association the row schema doesn't have.
    if (view.source.kind === "projection") {
      const proj = ctx.projections.find((p) => p.name === view.source.name);
      if (!proj) continue; // validator gated / non-projection source
      const path = `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`;
      const content = renderVanillaProjectionView(
        view,
        proj,
        appModule,
        contextModule,
        typesModule,
      );
      out.set(path, content);
      sourcemap?.file(path, content, view.origin, `${ctx.name}.${view.name}`);
      continue;
    }
    const agg = aggsByName.get(view.source.name);
    if (!agg) continue; // validator already errored / non-aggregate source
    const path = `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`;
    const content = renderVanillaView(view, agg, appModule, contextModule, typesModule);
    out.set(path, content);
    sourcemap?.file(path, content, view.origin, `${ctx.name}.${view.name}`);
  }
}

/** A workflow-sourced view module — a curated saga projection over the
 *  workflow's instance read model, projecting `instanceWireShape` (camelCase
 *  wire key ← snake struct field; Jason ISO-encodes any datetime).  `run/1`
 *  returns plain maps, so the project-wide `ViewsController` action's
 *  `serialize/1` is the identity on them — no struct handling needed.  Full-form
 *  workflow views are rejected upstream (`loom.view-workflow-fullform-unsupported`),
 *  so this only handles the shorthand (filter-only) form.
 *
 *  The read diverges on `wf.eventSourced`:
 *   - **state-based saga** — a plain Ecto read of the `<Wf>State` schema with the
 *     filter pushed into the query (`from(record in <State>, where: …)`);
 *   - **event-sourced** — has no `<Wf>State` table, so it group-folds the
 *     `<wf>_events` stream via `<Wf>Stream.list_instances/0` (the same helper the
 *     ES instance LIST uses) and applies the SAME filter IN-MEMORY through
 *     `Enum.filter`.  The folded `<Wf>State` struct exposes the same `record.<f>`
 *     fields, so projection / route paths / wire keys stay identical. */
function renderVanillaWorkflowView(
  view: ViewIR,
  wf: WorkflowIR,
  appModule: string,
  contextModule: string,
  typesModule: string,
): string {
  const moduleName = `${contextModule}.Views.${upperFirst(view.name)}`;
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    foundation: "vanilla",
  };
  const proj = (wf.instanceWireShape ?? [])
    .map((f) => `${f.name}: record.${snake(f.name)}`)
    .join(", ");
  let query: string;
  let preamble: string;
  if (wf.eventSourced) {
    // Group-fold the stream into instances, then filter in memory.  No Ecto.Query
    // / Repo here — the fold helper lives on the stream module.
    const streamMod = `${contextModule}.Workflows.${upperFirst(wf.name)}Stream`;
    const filtered = view.filter
      ? `    |> Enum.filter(fn record -> ${renderExpr(view.filter, renderCtx)} end)\n`
      : "";
    query = `    ${streamMod}.list_instances()\n${filtered}`;
    preamble = "";
  } else {
    const stateMod = stateModule(contextModule, wf);
    // The Ecto `where` is a QUERY context — enum literals must render as the
    // dumped declared STRING (Ecto won't cast an inline atom through Ecto.Enum),
    // so flag `filterArgs`.  The ES branch above stays in-memory (`Enum.filter`),
    // where the loaded field is the declared-case atom.
    const queryCtx: RenderCtx = { ...renderCtx, filterArgs: true };
    query =
      (view.filter
        ? `    from(record in ${stateMod}, where: ${renderExpr(view.filter, queryCtx)})
    |> Repo.all()`
        : `    Repo.all(${stateMod})`) + "\n";
    preamble = `  import Ecto.Query
  alias ${appModule}.Repo

`;
  }
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${upperFirst(view.name)}

  Source workflow: ${upperFirst(wf.name)} (saga instance state)
  Form: shorthand
  Foundation: vanilla (plain Ecto).
  """

${preamble}  @doc "Execute the view query and return the matching saga instances."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
    _ = current_user
${query}    |> Enum.map(fn record -> %{${proj}} end)
  end
end
`;
}

// ---------------------------------------------------------------------------
// Projection-sourced view (projection.md v1.1).
//
// Row acquisition mirrors the state-based workflow arm — a plain Ecto read of
// the `<Proj>Row` read-model schema with the filter pushed into the `where:`
// (enum literals render as the dumped declared STRING via `filterArgs`, since
// `Ecto.Enum` won't cast an inline atom in a query).  There is no capability
// filter (a projection is not an aggregate).
//
//   - Shorthand (no `output`) — project the projection `wireShape` (camelCase
//     wire key ← snake row field), identical to the `<Proj>ListResponse` the
//     v1 `GET /api/projections/<slug>` controller returns (projections-emit.ts).
//   - Full form (bind projection) — the aggregate-view tail, but the flat
//     `<Proj>Row` schema carries no `belongs_to`, so each `X id` follow
//     bulk-loads its foreign aggregate by id into a `%{id => struct}` map and
//     the bind rewrites `customer.name` → `Map.get(<map>, record.customer).name`
//     (the Elixir sibling of Hono's `findManyByIds` + `renderBindWithFollows`).
//
// `run/1` returns plain maps either way, so the project-wide `ViewsController`'s
// `serialize/1` is the identity `is_map` clause (no struct handling).
// ---------------------------------------------------------------------------

function renderVanillaProjectionView(
  view: ViewIR,
  proj: ProjectionIR,
  appModule: string,
  contextModule: string,
  typesModule: string,
): string {
  const moduleName = `${contextModule}.Views.${upperFirst(view.name)}`;
  const rowMod = projectionRowModule(contextModule, proj);
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    foundation: "vanilla",
  };
  // The `where:` is an Ecto QUERY context — enum literals render as the dumped
  // declared string (`filterArgs`); the projection binds below stay in-memory.
  const queryCtx: RenderCtx = { ...renderCtx, filterArgs: true };
  const isShorthand = !view.output;
  const body = isShorthand
    ? buildProjectionShorthandBody(view, proj, rowMod, queryCtx)
    : buildProjectionFullFormBody(view, rowMod, contextModule, renderCtx, queryCtx);

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${upperFirst(view.name)}

  Source projection: ${upperFirst(proj.name)} (read-model row)
  Form: ${isShorthand ? "shorthand" : "full (bind projection)"}
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the view query and return results."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
    _ = current_user
${body}
  end
end
`;
}

/** Shorthand projection view — filter only, projecting the projection
 *  `wireShape` (`f.name: record.<snake>`), the same shape the v1 projection
 *  LIST controller returns. */
function buildProjectionShorthandBody(
  view: ViewIR,
  proj: ProjectionIR,
  rowMod: string,
  queryCtx: RenderCtx,
): string {
  const proj_ = (proj.wireShape ?? []).map((f) => `${f.name}: record.${snake(f.name)}`).join(", ");
  const query = view.filter
    ? `    from(record in ${rowMod}, where: ${renderExpr(view.filter, queryCtx)})
    |> Repo.all()`
    : `    Repo.all(${rowMod})`;
  return `${query}
    |> Enum.map(fn record -> %{${proj_}} end)`;
}

/** Full-form projection view — the filtered `<Proj>Row` read, foreign-aggregate
 *  bulk-loads for every `X id` follow, then the bind projection with the
 *  follow rewrites. */
function buildProjectionFullFormBody(
  view: ViewIR,
  rowMod: string,
  contextModule: string,
  ctx: RenderCtx,
  queryCtx: RenderCtx,
): string {
  const output = view.output!;
  const lines: string[] = [];
  const query = view.filter
    ? `from(record in ${rowMod}, where: ${renderExpr(view.filter, queryCtx)})\n      |> Repo.all()`
    : `Repo.all(${rowMod})`;
  lines.push(`    rows =\n      ${query}`);

  // One `%{id => struct}` bulk-load per `X id` follow auxiliary, dependency
  // order (shortest path first — a length-1 path sources its ids from the rows,
  // a longer one from a prior map's values).
  const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
  for (const aux of output.auxiliaries) {
    const mapVar = snake(aux.mapVar);
    const aggMod = `${contextModule}.${upperFirst(aux.aggName)}`;
    const idsSource = projIdsSourceForAux(aux, pathToMap);
    lines.push(
      `    ${mapVar} =\n      Repo.all(from(a in ${aggMod}, where: a.id in ^${idsSource}))\n      |> Map.new(fn a -> {a.id, a} end)`,
    );
    pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
  }

  lines.push(`    Enum.map(rows, fn record ->`);
  lines.push(`      %{`);
  output.binds.forEach((bind, i) => {
    const tail = i === output.binds.length - 1 ? "" : ",";
    lines.push(
      `        ${bind.name}: ${renderProjBindWithFollows(bind.expr, "record", ctx, pathToMap)}${tail}`,
    );
  });
  lines.push(`      }`);
  lines.push(`    end)`);
  return lines.join("\n");
}

/** The id-source list for an auxiliary's bulk load.  Length-1 paths source from
 *  the row var (`Enum.map(rows, & &1.<field>)`); length-2+ paths source from the
 *  prior map's values (the auxiliary whose path is the current path's prefix). */
function projIdsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (aux.path.length === 1) {
    return `Enum.map(rows, & &1.${snake(aux.path[0]!)})`;
  }
  const prev = pathToMap.get(aux.path.slice(0, -1).join("."));
  if (!prev) return `[]`;
  const finalField = snake(aux.path[aux.path.length - 1]!);
  return `Enum.map(Map.values(${prev.mapVar}), & &1.${finalField})`;
}

/** Render a projection-view bind with chained `X id` follow rewriting.  At each
 *  `member` whose receiverType is `X id`, the access becomes
 *  `Map.get(<map>, <receiverRendered>).<member>`; a non-follow shape falls back
 *  to the standard in-memory `renderExpr` (a plain `record.<col>` read). */
function renderProjBindWithFollows(
  expr: ExprIR,
  thisName: string,
  ctx: RenderCtx,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = projIdFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const receiver = renderProjIdReceiver(expr.receiver, thisName, ctx, pathToMap);
        return `Map.get(${map.mapVar}, ${receiver}).${snake(expr.member)}`;
      }
    }
  }
  return renderExpr(expr, { ...ctx, thisName });
}

/** Render an Id-typed follow receiver — a `ref` (single hop, `record.<field>`)
 *  or a chain of Id-typed member accesses (multi-hop, each intermediate hop
 *  through its map's `Map.get(...)`). */
function renderProjIdReceiver(
  expr: ExprIR,
  thisName: string,
  ctx: RenderCtx,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") {
    return `${thisName}.${snake(expr.name)}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = projIdFollowPath(expr.receiver);
    if (path) {
      const map = pathToMap.get(path.join("."));
      if (map) {
        const inner = renderProjIdReceiver(expr.receiver, thisName, ctx, pathToMap);
        return `Map.get(${map.mapVar}, ${inner}).${snake(expr.member)}`;
      }
    }
  }
  return renderExpr(expr, { ...ctx, thisName });
}

/** Emission-time `X id` follow-path check (the local sibling of the lowering's
 *  helper, mirroring `view-routes-builder.ts:idFollowPath` on Hono). */
function projIdFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = projIdFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

function renderVanillaView(
  view: ViewIR,
  agg: AggregateIR,
  appModule: string,
  contextModule: string,
  typesModule: string,
): string {
  const moduleName = `${contextModule}.Views.${upperFirst(view.name)}`;
  const aggModule = `${contextModule}.${upperFirst(agg.name)}`;
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    foundation: "vanilla",
  };
  // The view reads its source aggregate, so it honours that aggregate's
  // capability filter (soft-delete / scoping) like every other read.  A
  // principal (tenancy) filter scopes by the `current_user` the controller
  // already threads into `run/1`; the predicate pins it (`^(current_user && …)`).
  const principal = aggregateUsesPrincipalContextFilter(agg);
  // An `ignoring` clause on the view drops the named capability filters from
  // this view's `where:` (the bypass rides the ViewIR — same as a find).
  const cap = vanillaCapabilityFilter(agg, contextModule, {
    actor: principal,
    bypass: { bypassAll: view.bypassAll, bypassCaps: view.bypassCaps },
  });
  const isShorthand = !view.output;
  const body = isShorthand
    ? buildShorthandBody(view, aggModule, renderCtx, cap)
    : buildFullFormBody(view, aggModule, renderCtx, cap);
  const runSpec = isShorthand
    ? `@spec run(any()) :: [${aggModule}.t()]`
    : "@spec run(any()) :: [map()]";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${upperFirst(view.name)}

  Source aggregate: ${upperFirst(agg.name)}
  Form: ${isShorthand ? "shorthand" : "full (bind projection)"}
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the view query and return results."
  ${runSpec}
  def run(current_user \\\\ nil) do
${principal ? "" : "    _ = current_user\n"}${body}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Shorthand form — filter only, returns the aggregate's structs.
// ---------------------------------------------------------------------------

function buildShorthandBody(
  view: ViewIR,
  aggModule: string,
  ctx: RenderCtx,
  cap: string | null,
): string {
  // The `where` is an Ecto QUERY context — enum literals render as the dumped
  // declared string (`filterArgs`); the in-memory `ctx` is for projections.
  const queryCtx: RenderCtx = { ...ctx, filterArgs: true };
  const where = combineWhere(view.filter ? renderExpr(view.filter, queryCtx) : null, cap);
  if (!where) {
    return `    Repo.all(${aggModule})`;
  }
  return `    from(record in ${aggModule}, where: ${where})
    |> Repo.all()`;
}

// ---------------------------------------------------------------------------
// Full form — filter + association preloads + Enum.map projection.
// ---------------------------------------------------------------------------

function buildFullFormBody(
  view: ViewIR,
  aggModule: string,
  ctx: RenderCtx,
  cap: string | null,
): string {
  const output = view.output!;
  const lines: string[] = [];

  // `where` is the Ecto QUERY (enum → dumped declared string via `filterArgs`);
  // the `bind` projections below stay in-memory (`ctx`, enum → declared atom).
  const queryCtx: RenderCtx = { ...ctx, filterArgs: true };
  const where = combineWhere(view.filter ? renderExpr(view.filter, queryCtx) : null, cap);
  if (where) {
    lines.push(`    from(record in ${aggModule}, where: ${where})`);
    lines.push(`    |> Repo.all()`);
  } else {
    lines.push(`    Repo.all(${aggModule})`);
  }

  const loadKeys = collectLoadKeys(view);
  if (loadKeys.length > 0) {
    const keyList = loadKeys.map((k) => `:${k}`).join(", ");
    lines.push(`    |> Repo.preload([${keyList}])`);
  }

  lines.push(`    |> Enum.map(fn record ->`);
  lines.push(`      %{`);
  output.binds.forEach((bind, i) => {
    const tail = i === output.binds.length - 1 ? "" : ",";
    // Key by the bind's declared (camelCase) name — the canonical wire key an
    // atom map encodes verbatim (`:projectId` → "projectId"), matching the
    // workflow-sourced view projection and every other backend.  (Was
    // `snake(bind.name)` → a multi-word bind shipped `project_id`.)
    lines.push(`        ${bind.name}: ${renderExpr(bind.expr, ctx)}${tail}`);
  });
  lines.push(`      }`);
  lines.push(`    end)`);
  return lines.join("\n");
}

/** Top-level association field names referenced by binds / `X id` follows —
 *  the keys to `Repo.preload` before projecting.  Deduped, order-preserving. */
function collectLoadKeys(view: ViewIR): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  if (!view.output) return keys;
  const add = (k: string | undefined) => {
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  for (const bind of view.output.binds) add(topLevelAssociation(bind.expr));
  for (const aux of view.output.auxiliaries) add(aux.path[0] ? snake(aux.path[0]) : undefined);
  return keys;
}

function topLevelAssociation(expr: ExprIR): string | undefined {
  if (expr.kind === "member") {
    const recv = expr.receiver;
    if (recv.kind === "ref" && (recv.refKind === "this-prop" || recv.refKind === "this-derived")) {
      const rt = expr.receiverType;
      if (rt.kind === "array" || rt.kind === "entity") return snake(recv.name);
    }
    return topLevelAssociation(recv);
  }
  if (expr.kind === "method-call" && expr.isCollectionOp) return topLevelAssociation(expr.receiver);
  return undefined;
}

// ---------------------------------------------------------------------------
// ViewsController — one project-wide module, one action per view.
// ---------------------------------------------------------------------------

/** Emit the single `<App>Web.ViewsController` and return its routes
 *  (`GET /views/<snake>` per view).  Returns `[]` (emits nothing) when
 *  there are no views. */
export function emitVanillaViewsController(
  appName: string,
  appModule: string,
  views: VanillaViewRef[],
  out: Map<string, string>,
): ApiRoute[] {
  if (views.length === 0) return [];
  const webModule = `${appModule}Web`;
  const actions = views.map(({ ctx, view }) => renderViewAction(ctx, view, appModule)).join("\n\n");

  // Shorthand aggregate views (`view X = Agg where …`) return the aggregate's
  // STRUCTS, so `serialize/1` must project each through that aggregate's
  // `wireShape` (camelCase keys, no timestamp leak) — the same canonical wire
  // the REST controller emits (#1628), not a raw `Map.from_struct` snake dump.
  // Full-form + workflow-sourced views already project a camelCase-keyed MAP in
  // their view module, handled by the `is_map` clause below.
  const structClauses: string[] = [];
  const helperByName = new Map<string, string>();
  const seenAgg = new Set<string>();
  let needsRefIds = false;
  for (const { ctx, view } of views) {
    if (view.output) continue; // full-form → map
    const agg = ctx.aggregates.find((a) => a.name === view.source.name);
    if (!agg) continue; // workflow-sourced (→ map) or non-aggregate source
    const aggModule = `${appModule}.${upperFirst(ctx.name)}.${upperFirst(agg.name)}`;
    if (seenAgg.has(aggModule)) continue;
    seenAgg.add(aggModule);
    if (hasRefColls(agg)) needsRefIds = true;
    const { body, helpers } = renderWireSerialize(agg, ctx, {
      contextModule: `${appModule}.${upperFirst(ctx.name)}`,
    });
    structClauses.push(`  defp serialize(%${aggModule}{} = record) do\n${body}\n  end`);
    for (const h of helpers) {
      const name = h.match(/defp (serialize_\w+)\(/)?.[1] ?? h;
      if (!helperByName.has(name)) helperByName.set(name, h);
    }
  }
  // `__ref_ids/1` backs an `X id[]` field's wire projection — the wireShape body
  // above calls it, so emit it once when any shorthand aggregate has one (the
  // same helper the REST controller defines).
  const refIdsHelper = needsRefIds
    ? `  # Project a loaded \`many_to_many\` relationship to its members' ids (an
  # unloaded relationship serializes as an empty list).
  defp __ref_ids(%Ecto.Association.NotLoaded{}), do: []
  defp __ref_ids(records) when is_list(records), do: Enum.map(records, & &1.id)
  defp __ref_ids(_), do: []`
    : null;
  const serializeClauses = [
    ...structClauses,
    "  defp serialize(record) when is_map(record), do: record",
    ...helperByName.values(),
    ...(refIdsHelper ? [refIdsHelper] : []),
  ].join("\n\n");

  out.set(
    `lib/${appName}_web/controllers/views_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.ViewsController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all view query modules (vanilla foundation).
  Each action delegates to the matching view module's run/1 and
  serialises the result before encoding the JSON response.
  """

${actions}

${serializeClauses}
end
`,
  );

  return views.map(({ view }) => ({
    method: "get" as const,
    path: `/views/${snake(view.name)}`,
    controller: "ViewsController",
    action: `:${snake(view.name)}`,
  }));
}

function renderViewAction(ctx: BoundedContextIR, view: ViewIR, appModule: string): string {
  const viewSnake = snake(view.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const viewModule = `${contextModule}.Views.${upperFirst(view.name)}`;
  // Read-side `requires` authorization gate (D-AUTH-OIDC / default-deny): a 403
  // returned before the query when the currentUser-only predicate fails — the
  // read-side analogue of an operation's `requires`.  The action already binds
  // `current_user`; an ungated view keeps its original shape.
  if (view.requires) {
    const webModule = `${appModule}Web`;
    const gate = renderExpr(view.requires, {
      thisName: "record",
      contextModule,
      foundation: "vanilla",
    });
    return `  @doc "GET /api/views/${viewSnake}"
  def ${viewSnake}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)

    if not (${gate}) do
      ${webModule}.ProblemDetails.problem_response(conn, 403, "Forbidden", ${JSON.stringify(
        `Forbidden: view ${view.name}`,
      )})
    else
      data = ${viewModule}.run(current_user) |> Enum.map(&serialize/1)
      json(conn, %{data: data})
    end
  end`;
  }
  return `  @doc "GET /api/views/${viewSnake}"
  def ${viewSnake}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)
    data = ${viewModule}.run(current_user) |> Enum.map(&serialize/1)
    json(conn, %{data: data})
  end`;
}
