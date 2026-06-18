// ---------------------------------------------------------------------------
// Vanilla foundation — `view` emission (vanilla-foundation-tdd-plan.md slice 5;
// D-VANILLA-PHOENIX-FOUNDATION).
//
// On `foundation: vanilla` a `view` is a plain Ecto query — no `Ash.Query`,
// no `Ash.read!`.  Two forms, mirroring the ash path's `view-emit.ts`:
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
// `GET /api/views/<snake>` per view, matching the ash path's route shape;
// the routes are spliced into the `/api` scope by `shell-emit.ts`.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  ViewIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { stateModule } from "../dispatch-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  aggregateUsesPrincipalContextFilter,
  combineWhere,
  vanillaCapabilityFilter,
} from "./capability-filter.js";

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
): void {
  if (ctx.views.length === 0) return;
  const ctxSnake = snake(ctx.name);
  const aggsByName = new Map(ctx.aggregates.map((a) => [a.name, a] as const));
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const typesModule = `${appModule}.Types`;

  for (const view of ctx.views) {
    // Workflow-sourced view (workflow-instance-views.md): a curated saga
    // projection over the persisted correlation state — a plain Ecto read of
    // the workflow's `<Wf>State` schema, the read-side sibling of the instance
    // endpoints (workflow-instances-emit.ts).  Only observable (correlation-
    // bearing, non-eventSourced) workflows have an `instanceWireShape`.
    if (view.source.kind === "workflow") {
      const wf = ctx.workflows.find((w) => w.name === view.source.name);
      if (!wf?.instanceWireShape) continue; // validator gated / not observable
      out.set(
        `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`,
        renderVanillaWorkflowView(view, wf, appModule, contextModule, typesModule),
      );
      continue;
    }
    const agg = aggsByName.get(view.source.name);
    if (!agg) continue; // validator already errored / non-aggregate source
    out.set(
      `lib/${appName}/${ctxSnake}/views/${snake(view.name)}.ex`,
      renderVanillaView(view, agg, appModule, contextModule, typesModule),
    );
  }
}

/** A workflow-sourced view module — a shorthand Ecto read of the saga-state
 *  schema with the view's filter, projecting `instanceWireShape` (camelCase
 *  wire key ← snake struct field; Jason ISO-encodes any datetime).  `run/1`
 *  returns plain maps, so the project-wide `ViewsController` action's
 *  `serialize/1` is the identity on them — no struct handling needed.  Full-form
 *  workflow views are rejected upstream (`loom.view-workflow-fullform-unsupported`),
 *  so this only handles the shorthand (filter-only) form. */
function renderVanillaWorkflowView(
  view: ViewIR,
  wf: WorkflowIR,
  appModule: string,
  contextModule: string,
  typesModule: string,
): string {
  const moduleName = `${contextModule}.Views.${upperFirst(view.name)}`;
  const stateMod = stateModule(contextModule, wf);
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule,
    typesModule,
    foundation: "vanilla",
  };
  const query = view.filter
    ? `    from(record in ${stateMod}, where: ${renderExpr(view.filter, renderCtx)})
    |> Repo.all()`
    : `    Repo.all(${stateMod})`;
  const proj = (wf.instanceWireShape ?? [])
    .map((f) => `${f.name}: record.${snake(f.name)}`)
    .join(", ");
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  View: ${upperFirst(view.name)}

  Source workflow: ${upperFirst(wf.name)} (saga instance state)
  Form: shorthand
  Foundation: vanilla (plain Ecto).
  """

  import Ecto.Query
  alias ${appModule}.Repo

  @doc "Execute the view query and return the matching saga instances."
  @spec run(any()) :: [map()]
  def run(current_user \\\\ nil) do
    _ = current_user
${query}
    |> Enum.map(fn record -> %{${proj}} end)
  end
end
`;
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
  const cap = vanillaCapabilityFilter(agg, contextModule, { actor: principal });
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
  const where = combineWhere(view.filter ? renderExpr(view.filter, ctx) : null, cap);
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

  const where = combineWhere(view.filter ? renderExpr(view.filter, ctx) : null, cap);
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
    lines.push(`        ${snake(bind.name)}: ${renderExpr(bind.expr, ctx)}${tail}`);
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

  defp serialize(%{__struct__: _} = record) do
    record
    |> Map.from_struct()
    |> Map.drop([:__meta__, :__struct__])
  end

  defp serialize(record) when is_map(record), do: record
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
  const viewModule = `${appModule}.${upperFirst(ctx.name)}.Views.${upperFirst(view.name)}`;
  return `  @doc "GET /api/views/${viewSnake}"
  def ${viewSnake}(conn, _params) do
    current_user = Map.get(conn.assigns, :current_user)
    data = ${viewModule}.run(current_user) |> Enum.map(&serialize/1)
    json(conn, %{data: data})
  end`;
}
