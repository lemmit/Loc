// ---------------------------------------------------------------------------
// Vanilla foundation — workflow-instance read endpoints (vanilla-foundation
// -tdd-plan.md; workflow-instance-visibility.md).
//
// This retires the deferred-Phoenix workflow-instance-views gap.  On
// `platform: elixir` a correlation-bearing workflow is observable as a
// plain Ecto read:
//
//   - saga-state Ecto schema — reused verbatim from `dispatch-emit.ts`
//     (`emitWorkflowStateSchemas`); plain Ecto that agrees byte-for-byte
//     with the saga table the migrations builder derives.
//   - `<App>Web.WorkflowInstancesController` — `GET /workflows/<snake>/
//     instances` (list) + `.../instances/:id` (by-id) reading that schema
//     via `<App>.Repo.all` / `.get`, projecting the cross-backend
//     `instanceWireShape` (camelCase keys ← snake struct fields).  A missing
//     id returns an RFC-7807 404 via the vanilla `ProblemDetails` module
//
// The 404 `detail` names the WORKFLOW (`"<Wf> <id> not found"`), not
// `"<Wf> instance <id> not found"` as it did until M-T6.31.  Elixir was the only
// backend spelling it that way; node and python already emitted the workflow
// name, on the reviewed RS-27 extension recorded in the Hono emitter ("a
// workflow INSTANCE read is addressed by id, so its 404 carries the same
// sentence the aggregate getById route does"), and .NET/java joined it in the
// same change.  A `detail` that differs per backend is exactly what RS-28
// closed on the aggregate read.
//
// This is the read-side analogue the visibility proposal promised.
// ---------------------------------------------------------------------------

import type { EnrichedBoundedContextIR, WorkflowIR } from "../../../ir/types/loom-ir.js";
import { exprUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { emitWorkflowStateSchemas, stateModule } from "../dispatch-emit.js";
import { renderExpr } from "../render-expr.js";
import { denialOverrides, denialResponse } from "./denial.js";
import { renderPathIdCastPlug } from "./problem-details-emit.js";

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
  // Saga-state Ecto schemas — reused.  Emitted for every
  // correlation-bearing workflow (idempotent with the future vanilla dispatch
  // slice, same path / same content).
  emitWorkflowStateSchemas(appName, ctx, appModule, out);

  const observable = ctx.workflows.filter((wf) => wf.instanceWireShape);
  if (observable.length === 0) return [];

  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const webModule = `${appModule}Web`;
  const actions = observable
    .map((wf) => renderInstanceActions(contextModule, appModule, wf, ctx))
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

${renderPathIdCastPlug()}

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
function renderInstanceActions(
  contextModule: string,
  appModule: string,
  wf: WorkflowIR,
  ctx: EnrichedBoundedContextIR,
): string {
  const slug = snake(wf.name);
  const mapFields = (wf.instanceWireShape ?? [])
    .map((f) => `${f.name}: row.${snake(f.name)}`)
    .join(", ");
  // The instance-READ gate (`workflow X requires <expr>`) — 403 before the read
  // on BOTH actions, mirroring the projection controller's gate.  `current_user`
  // is bound only when the predicate reads it: an unused binding fails
  // `mix compile --warnings-as-errors`.
  const gate = wf.instanceReadGate;
  const gateExpr = gate ? renderExpr(gate, { thisName: "record", contextModule }) : null;
  const cuBind =
    gate && exprUsesCurrentUser(gate)
      ? "    current_user = Map.get(conn.assigns, :current_user)\n"
      : "";
  const denial = denialResponse(
    "forbidden",
    JSON.stringify(`Forbidden: workflow ${wf.name} instances`),
    denialOverrides(ctx),
  );
  /** Wrap one action body in the gate, or return it unchanged when ungated
   *  (so an ungated workflow stays byte-identical). */
  const wrap = (head: string, body: string): string =>
    gateExpr
      ? `${head}
${cuBind}    if not (${gateExpr}) do
      ${denial}
    else
${body.replace(/^ {4}/gm, "      ")}
    end
  end`
      : `${head}
${body}
  end`;
  if (wf.eventSourced) {
    const streamMod = `${contextModule}.Workflows.${upperFirst(wf.name)}Stream`;
    return `${wrap(
      `  @doc "GET /api/workflows/${slug}/instances"
  def ${slug}_instances(conn, _params) do`,
      `    data = Enum.map(${streamMod}.list_instances(), fn row -> %{${mapFields}} end)
    json(conn, data)`,
    )}

${wrap(
  `  @doc "GET /api/workflows/${slug}/instances/:id"
  def ${slug}_instance(conn, %{"id" => id}) do`,
  `    case ${streamMod}.instance_by_id(id) do
      nil ->
        ProblemDetails.not_found_response(conn, "${upperFirst(wf.name)}", id)

      row ->
        json(conn, %{${mapFields}})
    end`,
)}`;
  }
  const stateMod = stateModule(contextModule, wf);
  return `${wrap(
    `  @doc "GET /api/workflows/${slug}/instances"
  def ${slug}_instances(conn, _params) do`,
    `    data = Enum.map(${appModule}.Repo.all(${stateMod}), fn row -> %{${mapFields}} end)
    json(conn, data)`,
  )}

${wrap(
  `  @doc "GET /api/workflows/${slug}/instances/:id"
  def ${slug}_instance(conn, %{"id" => id}) do`,
  `    case ${appModule}.Repo.get(${stateMod}, id) do
      nil ->
        ProblemDetails.not_found_response(conn, "${upperFirst(wf.name)}", id)

      row ->
        json(conn, %{${mapFields}})
    end`,
)}`;
}
