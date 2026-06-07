import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../ir/stdlib/generics.js";
import { unionInstanceName } from "../../ir/stdlib/unions.js";
import type { BoundedContextIR, DeployableIR, SystemIR, TypeIR } from "../../ir/types/loom-ir.js";
import { plural, snake, upperFirst } from "../../util/naming.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";
import { type UnionMember, unionMembers } from "../_payload/union-wire.js";

// ---------------------------------------------------------------------------
// API controller emission for Phoenix LiveView / Ash.
//
// Emits controller files (when applicable) and a companion route list
// that the orchestrator (index.ts) can splice into router.ex:
//
//   lib/<app>_web/controllers/workflows_controller.ex
//     — one action per workflow; delegates to <App>.<Ctx>.Workflows.<Wf>.run/1
//
//   lib/<app>_web/controllers/views_controller.ex
//     — one action per view; delegates to <App>.<Ctx>.Views.<View>.run/1
//
//   lib/<app>_web/controllers/<aggs_snake>_controller.ex
//     — ONE FILE PER AGGREGATE.  Module name `<App>Web.<Aggs>Controller`
//       (matches .NET's `<Aggs>Controller`).  Actions:
//         list / create / get / update / destroy   — CRUD
//         <op_snake>                                — one per public operation
//         <find_snake>                              — one per non-"all" find
//
//   lib/<app>_web/controllers/health_controller.ex
//     — ALWAYS emitted; two actions:
//       liveness/2  → GET /health  (cheap, no DB)
//       readiness/2 → GET /ready   (Ecto ping)
//
// Route injection convention
// --------------------------
// The `apiRoutes` array returned here carries routes that land INSIDE the
// `scope "/api"` block.  Routes whose path starts with the sentinel prefix
// `!root:` (e.g. `!root:/health`) are OUTSIDE the api scope; the orchestrator
// must strip the prefix and place them at the router's root level.
//
// Concretely:
//   apiRoutes entries with path "/workflows/…" or "/views/…"
//     → splice as `post|get "<path>", WorkflowsController|ViewsController, :<action>`
//       inside `scope "/api", …Web do … end`
//   apiRoutes entries with path "!root:/health" or "!root:/ready"
//     → strip "!root:" prefix; emit as bare `get "/health", HealthController, :liveness`
//       at the router's top level (outside any scope block).
// ---------------------------------------------------------------------------

export interface ApiEmitArgs {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
  /** snake_case application name, e.g. "phoenix_app" */
  appName: string;
  /** PascalCase module prefix, e.g. "PhoenixApp" */
  appModule: string;
  /** Compile-time --trace switch.  When true, each AggregatesController
   *  CRUD action emits a `wire_in` Logger.debug right after `params`
   *  binding so the parsed key set surfaces on the structured stream.
   *  Off keeps the action bodies byte-identical to the pre-trace shape. */
  emitTrace?: boolean;
}

/** Standard CRUD action/define names the Phoenix backend emits for a served
 *  aggregate (list/get/create/update/destroy).  A public operation whose
 *  snake name collides with one of these (e.g. crudish's canonical `update`)
 *  is the **canonical cross-backend form** — Hono/.NET serve it as
 *  `POST /<plural>/:id/<op>` with a per-op request schema (`UpdateXRequest`),
 *  and the conformance gate compares that schema across backends.  Phoenix
 *  must match it.  So when an op claims a CRUD-verb name, the **operation
 *  wins**: the per-op route/controller `def`/domain `define`/OpenAPI path are
 *  kept, and the redundant **standard** CRUD action of that name (which is
 *  Phoenix-controller-only — never in the OpenAPI or Hono) is suppressed, so
 *  the two don't collide into a duplicate `def <verb>/2` clause / duplicate
 *  Ash code-interface define.  `crudOpNames(agg)` returns the set to suppress. */
export const CRUD_VERB_NAMES: ReadonlySet<string> = new Set([
  "list",
  "get",
  "create",
  "update",
  "destroy",
]);

/** The CRUD-verb names claimed by an aggregate's public operations — the
 *  standard CRUD actions/defines to suppress in favour of the operation. */
export function crudOpNames(agg: {
  operations: { name: string; visibility?: string }[];
}): ReadonlySet<string> {
  const out = new Set<string>();
  for (const op of agg.operations) {
    if (op.visibility !== "public") continue;
    const s = snake(op.name);
    if (CRUD_VERB_NAMES.has(s)) out.add(s);
  }
  return out;
}

export interface ApiRoute {
  method: "get" | "post" | "put" | "patch" | "delete";
  /**
   * Path inside `scope "/api"` — e.g. "/workflows/place_order".
   * Paths that start with `!root:` (e.g. `!root:/health`) are outside
   * the api scope; the orchestrator strips the prefix and splices them
   * at router root level.
   */
  path: string;
  /**
   * Controller module local name (without `<App>Web.` prefix),
   * e.g. "WorkflowsController".
   */
  controller: string;
  /** Action atom, e.g. ":place_order". */
  action: string;
}

export interface ApiEmitResult {
  files: Map<string, string>;
  apiRoutes: ApiRoute[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function emitApiControllers(args: ApiEmitArgs): ApiEmitResult {
  const { contexts, deployable, appName, appModule } = args;
  const files = new Map<string, string>();
  const apiRoutes: ApiRoute[] = [];

  const hasServes = deployable.serves.length > 0;

  // Collect all workflows and views across all contexts
  const allWorkflows: Array<{
    ctx: BoundedContextIR;
    wf: import("../../ir/types/loom-ir.js").WorkflowIR;
  }> = [];
  const allViews: Array<{
    ctx: BoundedContextIR;
    view: import("../../ir/types/loom-ir.js").ViewIR;
  }> = [];

  for (const ctx of contexts) {
    for (const wf of ctx.workflows) {
      allWorkflows.push({ ctx, wf });
    }
    for (const view of ctx.views) {
      allViews.push({ ctx, view });
    }
  }

  // --- Workflows controller --------------------------------------------------
  if (hasServes && allWorkflows.length > 0) {
    const controllerPath = `lib/${appName}_web/controllers/workflows_controller.ex`;
    files.set(controllerPath, renderWorkflowsController(allWorkflows, appModule));

    for (const { wf } of allWorkflows) {
      const actionSnake = snake(wf.name);
      apiRoutes.push({
        method: "post",
        path: `/workflows/${actionSnake}`,
        controller: "WorkflowsController",
        action: `:${actionSnake}`,
      });
    }
  }

  // --- Views controller ------------------------------------------------------
  if (hasServes && allViews.length > 0) {
    const controllerPath = `lib/${appName}_web/controllers/views_controller.ex`;
    files.set(controllerPath, renderViewsController(allViews, appModule));

    for (const { view } of allViews) {
      const actionSnake = snake(view.name);
      apiRoutes.push({
        method: "get",
        path: `/views/${actionSnake}`,
        controller: "ViewsController",
        action: `:${actionSnake}`,
      });
    }
  }

  // --- Per-aggregate controllers --------------------------------------------
  // One controller file + module per aggregate (e.g. `ProjectsController`).
  // Matches the .NET (`<Aggs>Controller`) and Hono (`http/<agg>.routes.ts`)
  // per-aggregate organisation, and keeps the per-op + per-find actions
  // scoped to their owning resource module.
  if (hasServes) {
    for (const ctx of contexts) {
      for (const agg of ctx.aggregates) {
        const aggsSnake = snake(plural(agg.name));
        const controllerLocal = `${upperFirst(plural(agg.name))}Controller`;
        const controllerPath = `lib/${appName}_web/controllers/${aggsSnake}_controller.ex`;
        files.set(controllerPath, renderAggregateController(ctx, agg, appModule, !!args.emitTrace));

        const aggPlural = aggsSnake;
        // CRUD-verb names claimed by a public operation (e.g. crudish
        // `update`) — the standard CRUD route of that name is suppressed so
        // the operation's `POST /:id/<verb>` route owns the action (and the
        // controller `def`s don't collide).  See CRUD_VERB_NAMES.
        const crudOps = crudOpNames(agg);
        // Route order matters: Phoenix matches the first declared route.
        // Literal-segment paths (`/<plural>/<find>`) MUST come before the
        // `:id`-parameterised member route (`/<plural>/:id`), otherwise
        // `:id` would shadow them.  Emission order:
        //   1. Collection: list / create
        //   2. Per-find:   GET /<plural>/<find>     (literal segments)
        //   3. Member:     get / update / destroy   (`:id` paths)
        //   4. Per-op:     POST /<plural>/:id/<op>  (member action; longer
        //                  than `:id` so no ambiguity)
        if (!crudOps.has("list")) {
          apiRoutes.push({
            method: "get",
            path: `/${aggPlural}`,
            controller: controllerLocal,
            action: ":list",
          });
        }
        if (!crudOps.has("create")) {
          apiRoutes.push({
            method: "post",
            path: `/${aggPlural}`,
            controller: controllerLocal,
            action: ":create",
          });
        }
        const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
        if (repo) {
          for (const find of repo.finds) {
            if (find.name === "all") continue;
            const findSnake = snake(find.name);
            apiRoutes.push({
              method: "get",
              path: `/${aggPlural}/${findSnake}`,
              controller: controllerLocal,
              action: `:${findSnake}`,
            });
          }
        }
        if (!crudOps.has("get")) {
          apiRoutes.push({
            method: "get",
            path: `/${aggPlural}/:id`,
            controller: controllerLocal,
            action: ":get",
          });
        }
        if (!crudOps.has("update")) {
          apiRoutes.push({
            method: "patch",
            path: `/${aggPlural}/:id`,
            controller: controllerLocal,
            action: ":update",
          });
        }
        if (!crudOps.has("destroy")) {
          apiRoutes.push({
            method: "delete",
            path: `/${aggPlural}/:id`,
            controller: controllerLocal,
            action: ":destroy",
          });
        }
        for (const op of agg.operations.filter((o) => o.visibility === "public")) {
          // URL segment from routeSlug (D-URLSTYLE); the Phoenix action
          // atom (and the matching controller `def`) stay the op verb so
          // `post "/cancels" → :cancel → def cancel` under :resource.
          const opSnake = snake(op.name);
          const opPath = snake(op.routeSlug ?? op.name);
          apiRoutes.push({
            method: "post",
            path: `/${aggPlural}/:id/${opPath}`,
            controller: controllerLocal,
            action: `:${opSnake}`,
          });
        }
      }
    }
  }

  // --- Health controller — always emitted ------------------------------------
  const healthPath = `lib/${appName}_web/controllers/health_controller.ex`;
  files.set(healthPath, renderHealthController(appModule));

  // Health/ready routes use the !root: sentinel so the orchestrator places
  // them outside the /api scope.
  apiRoutes.push({
    method: "get",
    path: "!root:/health",
    controller: "HealthController",
    action: ":liveness",
  });
  apiRoutes.push({
    method: "get",
    path: "!root:/ready",
    controller: "HealthController",
    action: ":readiness",
  });

  return { files, apiRoutes };
}

// ---------------------------------------------------------------------------
// WorkflowsController
// ---------------------------------------------------------------------------

function renderWorkflowsController(
  workflows: Array<{ ctx: BoundedContextIR; wf: import("../../ir/types/loom-ir.js").WorkflowIR }>,
  appModule: string,
): string {
  const webModule = `${appModule}Web`;

  const actions = workflows
    .map(({ ctx, wf }) => renderWorkflowAction(ctx, wf, appModule))
    .join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.WorkflowsController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all workflow code-interface functions.
  Each action delegates to the matching workflow module's run/1.

  Trace ID propagation: \`Plug.RequestId\` runs in the endpoint pipeline
  (see \`endpoint.ex\`) before this controller, so it has already set
  the \`x-request-id\` response header (and \`Logger.metadata(:request_id)\`).
  The \`error_response/2\` helper reads that header back to include the
  trace id in the JSON error envelope — matching the
  \`{error, trace_id}\` shape Hono and .NET emit on errors.
  """

${actions}

  # ---------------------------------------------------------------------------
  # Error helpers
  # ---------------------------------------------------------------------------

  # RFC 7807 problem body — application/problem+json + x-request-id header
  # (trace correlation off the body so it's byte-identical to Hono / .NET).
  # Status-aware:
  #   - \`%Ash.Error.Invalid{}\` (validation) → 422 with §3.2 \`errors[]\`
  #     extension via the shared ProblemDetails responder, consumed by
  #     the frontend ACL's \`applyServerErrors\` (Phase C of
  #     docs/proposals/validation-error-extension.md).
  #   - \`:forbidden\` (requires guard) → 403.
  #   - everything else → 400 domain error.
  defp error_response(conn, %Ash.Error.Invalid{} = err) do
    ${webModule}.ProblemDetails.validation_error_response(conn, err)
  end

  defp error_response(conn, reason) do
    {status, title} =
      case reason do
        :forbidden -> {403, "Forbidden"}
        _ -> {400, "Bad Request"}
      end

    ${webModule}.ProblemDetails.problem_response(conn, status, title, inspect(reason))
  end
end
`;
}

function renderWorkflowAction(
  ctx: BoundedContextIR,
  wf: import("../../ir/types/loom-ir.js").WorkflowIR,
  appModule: string,
): string {
  const wfSnake = snake(wf.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const workflowModule = `${contextModule}.Workflows.${upperFirst(wf.name)}`;

  // Build the permitted param key list from the workflow's declared
  // params.  Phoenix JSON params are STRING-keyed (`%{"name" => …}`), but
  // the workflow `run/2` head pattern-matches ATOM keys (`%{name: name}`),
  // so a string-keyed map crashes with FunctionClauseError in the head —
  // before the body's try/catch can run.  Build an atom-keyed map from the
  // declared params.  The keys come from the compile-time param list (not
  // user input), so `String.to_atom` here can't be abused for atom
  // exhaustion; an absent param maps to `nil` (the head still matches, and
  // a required-but-missing value surfaces as a precondition/guard failure
  // rather than a 500).
  const atomEntries = wf.params
    .map((p) => `${snake(p.name)}: params[${JSON.stringify(snake(p.name))}]`)
    .join(", ");
  const takeExpr = wf.params.length > 0 ? `%{${atomEntries}}` : `%{}`;

  return `  @doc "POST /api/workflows/${wfSnake}"
  def ${wfSnake}(conn, params) do
    # currentUser threading.  When the deployable has
    # \`auth: required\`, the Auth plug populates
    # \`conn.assigns.current_user\` from the JWT.  We pass it as the
    # second positional arg to run/2; workflows that don't reference
    # currentUser ignore it (the renderer emits a default value).
    current_user = Map.get(conn.assigns, :current_user)
    input = ${takeExpr}

    case ${workflowModule}.run(input, current_user) do
      {:ok, result} ->
        conn
        |> put_status(:ok)
        |> json(%{data: result})

      {:error, reason} ->
        error_response(conn, reason)
    end
  end`;
}

// ---------------------------------------------------------------------------
// ViewsController
// ---------------------------------------------------------------------------

function renderViewsController(
  views: Array<{ ctx: BoundedContextIR; view: import("../../ir/types/loom-ir.js").ViewIR }>,
  appModule: string,
): string {
  const webModule = `${appModule}Web`;

  const actions = views.map(({ ctx, view }) => renderViewAction(ctx, view, appModule)).join("\n\n");

  return `# Auto-generated.
defmodule ${webModule}.ViewsController do
  use ${webModule}, :controller

  @moduledoc """
  HTTP entry points for all view query modules.
  Each action delegates to the matching view module's run/1 and
  strips Ash internal fields before encoding the JSON response.
  """

${actions}
end
`;
}

function renderViewAction(
  ctx: BoundedContextIR,
  view: import("../../ir/types/loom-ir.js").ViewIR,
  appModule: string,
): string {
  const viewSnake = snake(view.name);
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const viewModule = `${contextModule}.Views.${upperFirst(view.name)}`;

  // Ash internal metadata fields to strip before JSON encoding
  const ashInternalKeys = `~w(__meta__ __struct__ __order__ __lateral_join_source__ calculations aggregates relationships)a`;

  return `  @doc "GET /api/views/${viewSnake}"
  def ${viewSnake}(conn, _params) do
    # currentUser available to views via run/1 first arg.
    # Views that don't reference currentUser ignore it (default value).
    current_user = Map.get(conn.assigns, :current_user)
    case ${viewModule}.run(current_user) do
      {:ok, records} ->
        data =
          Enum.map(records, fn record ->
            record
            |> Map.from_struct()
            |> Map.drop(${ashInternalKeys})
          end)

        conn
        |> put_status(:ok)
        |> json(%{data: data})

      {:error, reason} ->
        trace_id = get_resp_header(conn, "x-request-id") |> List.first("unknown")
        body = Jason.encode!(%{type: "about:blank", title: "Internal Server Error", status: 500, detail: inspect(reason), instance: conn.request_path})

        conn
        |> put_resp_content_type("application/problem+json")
        |> put_resp_header("x-request-id", trace_id)
        |> send_resp(500, body)
    end
  end`;
}

// ---------------------------------------------------------------------------
// Discriminated-union serialization (payload-transport-layer.md, P4d)
// ---------------------------------------------------------------------------

/** A find whose return type is a discriminated union — inline `A or B` or a
 *  named `payload Foo = …` reference.  Returns the serializer name + variants. */
function unionForFind(
  t: TypeIR,
  ctx: BoundedContextIR,
): { name: string; variants: TypeIR[] } | null {
  if (t.kind === "union") return { name: unionInstanceName(t.variants), variants: t.variants };
  if (t.kind === "entity") {
    const p = ctx.payloads.find((pl) => pl.name === t.name && pl.variants);
    if (p?.variants) return { name: p.name, variants: p.variants };
  }
  return null;
}

/** The private tagger function name for a union (`OrderOrCancel` → `tag_order_or_cancel`). */
function unionTagFn(name: string): string {
  return `tag_${snake(name)}`;
}

/** Emit `defp tag_<union>/1` — one struct-pattern clause per record variant
 *  (an Ash resource / embedded value object), mapping it to the cross-backend
 *  `%{type: tag, …fields}` wire (camelCase atom keys; snake struct access).  A
 *  final catch-all raises for an unhandled variant (a scalar / `none` value, or
 *  a struct the producer shouldn't have yielded). */
function renderUnionTagger(
  name: string,
  variants: TypeIR[],
  ctx: BoundedContextIR,
  contextModule: string,
): string {
  const fn = unionTagFn(name);
  const members = unionMembers(variants, ctx);
  const clauseFor = (m: UnionMember): string | null => {
    if (m.shape !== "record") return null; // scalar / none → catch-all
    const fields = m.fields.map((f) => `${f.name}: v.${snake(f.name)}`).join(", ");
    const body = fields
      ? `%{type: ${JSON.stringify(m.tag)}, ${fields}}`
      : `%{type: ${JSON.stringify(m.tag)}}`;
    return `  defp ${fn}(%${contextModule}.${upperFirst(m.tag)}{} = v), do: ${body}`;
  };
  const clauses = members.map(clauseFor).filter((c): c is string => c !== null);
  clauses.push(
    `  defp ${fn}(_other), do: raise(ArgumentError, message: "unhandled ${name} variant")`,
  );
  return clauses.join("\n");
}

// ---------------------------------------------------------------------------
// Per-aggregate controllers (`<Aggs>Controller`)
// ---------------------------------------------------------------------------

function renderAggregateController(
  ctx: BoundedContextIR,
  agg: import("../../ir/types/loom-ir.js").AggregateIR,
  appModule: string,
  emitTrace: boolean,
): string {
  const webModule = `${appModule}Web`;
  const aggSnake = snake(agg.name);
  const aggPlural = snake(plural(agg.name));
  const contextModule = `${appModule}.${upperFirst(ctx.name)}`;
  const controllerModule = `${webModule}.${upperFirst(plural(agg.name))}Controller`;

  // wire_in (debug, since Elixir's Logger has no `trace` — catalog's
  // trace level maps to Logger.debug per render-phoenix.ts) — emitted
  // only on --trace.  Mirrors Hono + .NET wire_in identity so a
  // cross-backend filter on `event="wire_in"` joins.
  const wireInLine = emitTrace
    ? `    ${renderPhoenixLogCall("wireIn", [{ name: "keys", valueExpr: "Map.keys(params)" }])}\n`
    : "";

  // Standard CRUD actions, keyed by name.  A CRUD verb claimed by a public
  // operation (e.g. crudish `update`) is dropped here — the per-op action
  // below owns that `def`, matching the cross-backend `POST /:id/<verb>` form
  // (so the two don't collide into a duplicate `def <verb>/2`).
  const crudOps = crudOpNames(agg);
  const crudSegments: { name: string; src: string }[] = [
    {
      name: "list",
      src: `  @doc "GET /api/${aggPlural}"
  def list(conn, _params) do
    records = ${contextModule}.list_${aggPlural}!()
    json(conn, records)
  end`,
    },
    {
      name: "get",
      src: `  @doc "GET /api/${aggPlural}/:id"
  def get(conn, %{"id" => id}) do
    record = ${contextModule}.get_${aggSnake}!(id)
    json(conn, record)
  end`,
    },
    {
      name: "create",
      src: `  @doc "POST /api/${aggPlural}"
  def create(conn, params) do
${wireInLine}    record = ${contextModule}.create_${aggSnake}!(params)
    ${renderPhoenixLogCall("aggregateCreated", [
      { name: "aggregate", valueExpr: `"${agg.name}"` },
      { name: "id", valueExpr: "record.id" },
    ])}
    conn
    |> put_status(:created)
    |> json(%{id: record.id})
  end`,
    },
    {
      name: "update",
      src: `  @doc "PATCH /api/${aggPlural}/:id"
  def update(conn, %{"id" => id} = params) do
${wireInLine}    attrs = Map.drop(params, ["id"])
    record = ${contextModule}.update_${aggSnake}!(id, attrs)
    json(conn, record)
  end`,
    },
    {
      name: "destroy",
      src: `  @doc "DELETE /api/${aggPlural}/:id"
  def destroy(conn, %{"id" => id}) do
    ${contextModule}.destroy_${aggSnake}!(id)
    send_resp(conn, 204, "")
  end`,
    },
  ];
  const crud = crudSegments
    .filter((s) => !crudOps.has(s.name))
    .map((s) => s.src)
    .join("\n\n");

  // Per-find actions.  Each delegates to `<Ctx>.<find>_<agg>` (positional
  // args extracted from query params; the Ash code-interface declared
  // them via `args: [...]` in the domain module).  Auto-`all` is skipped —
  // `list/2` above already serves it.
  const repo = ctx.repositories.find((r) => r.aggregateName === agg.name);
  const findActions: string[] = [];
  // Discriminated-union find returns (P4d): name → variants, deduped, so the
  // controller can emit one `tag_<union>/1` serializer (struct-pattern clauses
  // → the `%{type: tag, …}` wire) shared across finds that return it.
  const unionsUsed = new Map<string, TypeIR[]>();
  if (repo) {
    for (const find of repo.finds) {
      if (find.name === "all") continue;
      const findSnake = snake(find.name);
      // Code-interface call: `<Ctx>.<find>_<agg>!(arg1, arg2, ...)` —
      // positional from the GET query string.  Wire keys come in
      // camelCase per the cross-backend convention.
      const argReads = find.params
        .map((p) => `params[${JSON.stringify(snake(p.name))}]`)
        .join(", ");
      const union = unionForFind(find.returnType, ctx);
      if (union) {
        // Tagged-union return (P4d): the read yields the repo aggregate; the
        // controller tags it into the cross-backend `%{type: tag, …}` wire.
        // Producer-side variant selection (yielding a non-primary variant) is
        // developer logic — same boundary as the TS/.NET stubs.
        unionsUsed.set(union.name, union.variants);
        findActions.push(`  @doc "GET /api/${aggPlural}/${findSnake}"
  def ${findSnake}(conn, params) do
    _ = params
    result = ${contextModule}.${findSnake}_${aggSnake}!(${argReads})
    json(conn, ${unionTagFn(union.name)}(result))
  end`);
        continue;
      }
      if (pagedReturn(find.returnType)) {
        // Paged (P3b): read page/pageSize (1-based, defaults), pass Ash
        // offset pagination with `count: true`, and map the
        // `%Ash.Page.Offset{}` to the cross-backend envelope.  camelCase
        // atom keys serialize to the shared wire shape.
        const pageArgs = [
          ...find.params.map((p) => `params[${JSON.stringify(snake(p.name))}]`),
          "page: [limit: page_size, offset: offset, count: true]",
        ].join(", ");
        findActions.push(`  @doc "GET /api/${aggPlural}/${findSnake}"
  def ${findSnake}(conn, params) do
    page = String.to_integer(params["page"] || "${PAGED_DEFAULT_PAGE}")
    page_size = String.to_integer(params["pageSize"] || "${PAGED_DEFAULT_PAGE_SIZE}")
    offset = (page - 1) * page_size
    result = ${contextModule}.${findSnake}_${aggSnake}!(${pageArgs})
    total = result.count || 0
    total_pages = if page_size > 0, do: ceil(total / page_size), else: 0
    json(conn, %{items: result.results, page: page, pageSize: page_size, total: total, totalPages: total_pages})
  end`);
        continue;
      }
      findActions.push(`  @doc "GET /api/${aggPlural}/${findSnake}"
  def ${findSnake}(conn, params) do
    _ = params
    result = ${contextModule}.${findSnake}_${aggSnake}!(${argReads})
    json(conn, result)
  end`);
    }
  }

  // Per-operation actions.  POST /<plural>/:id/<op>; delegates to
  // `<Ctx>.<op>_<agg>!(id, arg1, arg2, ...)`.  Op params are read from
  // the JSON body (camelCase keys); a successful op returns 204 No
  // Content (matching the Hono/.NET convention — ops are side-
  // effecting and don't return the entity).
  const opActions: string[] = [];
  for (const op of agg.operations.filter((o) => o.visibility === "public")) {
    const opSnake = snake(op.name);
    const opPath = snake(op.routeSlug ?? op.name);
    const argReads = op.params.map((p) => `params[${JSON.stringify(snake(p.name))}]`).join(", ");
    const callArgs = argReads.length > 0 ? `id, ${argReads}` : "id";
    // Guarded operations (a `requires` clause) run under Ash authorization:
    // thread the JWT actor + authorize?: true so the resource's policy fires
    // (a failed guard → Ash.Error.Forbidden → HTTP 403, matching Hono/.NET).
    // Unguarded ops keep the plain call (no policies → no authorize? needed).
    const guarded = op.statements.some((s) => s.kind === "requires");
    const cuLine = guarded ? "    current_user = Map.get(conn.assigns, :current_user)\n" : "";
    const callOpts = guarded ? ", actor: current_user, authorize?: true" : "";
    opActions.push(`  @doc "POST /api/${aggPlural}/:id/${opPath}"
  def ${opSnake}(conn, %{"id" => id} = params) do
    _ = params
${cuLine}    ${contextModule}.${opSnake}_${aggSnake}!(${callArgs}${callOpts})
    send_resp(conn, 204, "")
  end`);
  }

  // One private tagger per distinct union returned by this aggregate's finds.
  const unionTaggers = [...unionsUsed].map(([name, variants]) =>
    renderUnionTagger(name, variants, ctx, contextModule),
  );

  const allActions = [crud, ...findActions, ...opActions, ...unionTaggers].join("\n\n");

  return `# Auto-generated.
defmodule ${controllerModule} do
  use ${webModule}, :controller
  # Plug.ErrorHandler intercepts raised exceptions from the bang
  # Ash code-interface calls below (\`create_${aggSnake}!\`, etc.).
  # When the raised reason is an \`Ash.Error.Invalid\`, we route to
  # the shared ProblemDetails responder which emits 422 + the §3.2
  # \`errors[]\` extension consumed by the frontend ACL's
  # \`applyServerErrors\` (matches Hono / .NET).  Anything else falls
  # through to Phoenix's default \`render_errors\` pipeline.
  # See docs/proposals/validation-error-extension.md (Phase C).
  use Plug.ErrorHandler

  # Catalog log events (aggregate_created on Create; see
  # docs/proposals/observability.md) reach Elixir's Logger via the
  # renderer in src/generator/_obs/render-phoenix.ts.
  require Logger

  @moduledoc """
  HTTP entry points for the ${agg.name} aggregate.
  CRUD + per-operation + per-find actions delegate to the matching
  Ash domain code-interface entries on ${contextModule}.
  """

${allActions}

  # ---------------------------------------------------------------------------
  # Plug.ErrorHandler — Ash.Error.Invalid → 422 ProblemDetails + errors[]
  # ---------------------------------------------------------------------------

  @impl Plug.ErrorHandler
  def handle_errors(conn, %{reason: %Ash.Error.Invalid{} = err}) do
    ${webModule}.ProblemDetails.validation_error_response(conn, err)
  end

  def handle_errors(conn, _assigns), do: conn
end
`;
}

// ---------------------------------------------------------------------------
// HealthController
// ---------------------------------------------------------------------------

function renderHealthController(appModule: string): string {
  const webModule = `${appModule}Web`;

  return `# Auto-generated.
defmodule ${webModule}.HealthController do
  use ${webModule}, :controller
  # Catalog log events (health_ok / db_error / health_degraded — see
  # docs/proposals/observability.md) — same identity the Hono /ready
  # arm emits, so cross-backend dashboards filter on one event name.
  require Logger

  @moduledoc """
  Liveness and readiness probes.

  GET /health — cheap liveness check; always returns 200 while the BEAM is running.
  GET /ready  — DB-aware readiness check; returns 503 when the database is unreachable.
  """

  @doc "GET /health — liveness probe (no DB dependency)."
  def liveness(conn, _params) do
    ${renderPhoenixLogCall("healthOk", [{ name: "checks", valueExpr: `["liveness"]` }])}
    json(conn, %{status: "ok"})
  end

  @doc "GET /ready — readiness probe (pings the database)."
  def readiness(conn, _params) do
    try do
      Ecto.Adapters.SQL.query!(${appModule}.Repo, "SELECT 1", [])
      ${renderPhoenixLogCall("healthOk", [{ name: "checks", valueExpr: `["readiness", "db"]` }])}
      json(conn, %{status: "ready"})
    rescue
      e ->
        ${renderPhoenixLogCall("dbError", [{ name: "error", valueExpr: "Exception.message(e)" }])}
        ${renderPhoenixLogCall("healthDegraded", [{ name: "checks", valueExpr: `["db"]` }])}
        conn
        |> put_status(:service_unavailable)
        |> json(%{status: "not_ready"})
    end
  end
end
`;
}
