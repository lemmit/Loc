// ---------------------------------------------------------------------------
// Vanilla foundation — workflow-instance read endpoints (vanilla-foundation
// -tdd-plan.md slice 5; workflow-instance-visibility.md).
//
// This retires the deferred-Phoenix workflow-instance-views gap.  On
// `foundation: vanilla` a correlation-bearing workflow is observable as a
// plain Ecto read:
//
//   - saga-state Ecto schema — reused verbatim from `dispatch-emit.ts`
//     (`emitWorkflowStateSchemas`); it is already plain Ecto (off the Ash
//     action surface) and agrees byte-for-byte with the saga table the
//     migrations builder derives.
//   - `<App>Web.WorkflowInstancesController` — `GET /workflows/<snake>/
//     instances` (list) + `.../instances/:id` (by-id) reading that schema
//     via `<App>.Repo.all` / `.get`, projecting the cross-backend
//     `instanceWireShape` (camelCase keys ← snake struct fields).  A missing
//     id returns an RFC-7807 404 via the vanilla `ProblemDetails` module
//     (slice 4).
//
// No `Ash.*` anywhere — this is the read-side analogue the visibility
// proposal promised for the vanilla path.
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR, WorkflowIR } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { emitWorkflowStateSchemas, stateModule } from "../dispatch-emit.js";

/** Emit the saga-state schema(s) + the `WorkflowInstancesController` for one
 *  context, returning the instance read routes (`GET /workflows/<snake>/
 *  instances[/:id]`).  Returns `[]` (and emits no controller) when the
 *  context has no observable workflow. */
export function emitVanillaWorkflowInstances(
  appName: string,
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
): ApiRoute[] {
  // Saga-state Ecto schemas — reused, foundation-agnostic.  Emitted for every
  // correlation-bearing workflow (idempotent with the future vanilla dispatch
  // slice, same path / same content).
  emitWorkflowStateSchemas(appName, ctx, appModule, out);

  const observable = ctx.workflows.filter((wf) => wf.instanceWireShape);
  if (observable.length === 0) return [];

  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const webModule = `${appModule}Web`;
  const actions = observable
    .map((wf) => renderInstanceActions(contextModule, appModule, wf))
    .join("\n\n");

  out.set(
    `lib/${appName}_web/controllers/workflow_instances_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.WorkflowInstancesController do
  use ${webModule}, :controller
  alias ${webModule}.ProblemDetails

  @moduledoc """
  Read-only HTTP entry points for running workflow instances (saga state),
  vanilla foundation.  Each action reads the workflow's persisted
  correlation-state Ecto schema via the app Repo and encodes the
  cross-backend wire shape (camelCase keys).
  """

${actions}
end
`,
  );

  const routes: ApiRoute[] = [];
  for (const wf of observable) {
    const slug = snake(wf.name);
    routes.push({
      method: "get",
      path: `/workflows/${slug}/instances`,
      controller: "WorkflowInstancesController",
      action: `:${slug}_instances`,
    });
    routes.push({
      method: "get",
      path: `/workflows/${slug}/instances/:id`,
      controller: "WorkflowInstancesController",
      action: `:${slug}_instance`,
    });
  }
  return routes;
}

/** The list + by-id actions for one observable workflow.  The read body
 *  diverges on `wf.eventSourced`: a state-based saga reads its `<Wf>State` Ecto
 *  schema through `<App>.Repo` (`all` / `get`), while an event-sourced workflow
 *  folds the per-correlation `<wf>_events` stream via `<Wf>Stream` —
 *  `list_instances/0` (load-all + group-by-stream_id + fold each, mirroring the
 *  ES-aggregate repository `list/0`) for LIST, `instance_by_id/1` (single-stream
 *  load + fold, nil if empty) for byId.  The projection reads `row.<field>`
 *  identically on the Ecto row and the folded `<Wf>State` struct, so the wire
 *  keys, route paths, and action names stay identical to the state path. */
function renderInstanceActions(contextModule: string, appModule: string, wf: WorkflowIR): string {
  const slug = snake(wf.name);
  const mapFields = (wf.instanceWireShape ?? [])
    .map((f) => `${f.name}: row.${snake(f.name)}`)
    .join(", ");
  if (wf.eventSourced) {
    const streamMod = `${contextModule}.Workflows.${upperFirst(wf.name)}Stream`;
    return `  @doc "GET /api/workflows/${slug}/instances"
  def ${slug}_instances(conn, _params) do
    data = Enum.map(${streamMod}.list_instances(), fn row -> %{${mapFields}} end)
    json(conn, %{data: data})
  end

  @doc "GET /api/workflows/${slug}/instances/:id"
  def ${slug}_instance(conn, %{"id" => id}) do
    case ${streamMod}.instance_by_id(id) do
      nil ->
        ProblemDetails.not_found_response(conn, "${upperFirst(wf.name)} instance", id)

      row ->
        json(conn, %{${mapFields}})
    end
  end`;
  }
  const stateMod = stateModule(contextModule, wf);
  return `  @doc "GET /api/workflows/${slug}/instances"
  def ${slug}_instances(conn, _params) do
    data = Enum.map(${appModule}.Repo.all(${stateMod}), fn row -> %{${mapFields}} end)
    json(conn, %{data: data})
  end

  @doc "GET /api/workflows/${slug}/instances/:id"
  def ${slug}_instance(conn, %{"id" => id}) do
    case ${appModule}.Repo.get(${stateMod}, id) do
      nil ->
        ProblemDetails.not_found_response(conn, "${upperFirst(wf.name)} instance", id)

      row ->
        json(conn, %{${mapFields}})
    end
  end`;
}
