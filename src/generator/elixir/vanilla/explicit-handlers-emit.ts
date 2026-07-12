// ---------------------------------------------------------------------------
// Explicit application/transport layer → plain Ecto/Phoenix emission
// (unfoldable-api-derivation.md, Layers 3-4; A2 slice — the Phoenix sibling of
// the .NET A1 emitter in `src/generator/dotnet/explicit-handlers-emit.ts`).
//
// Reads the explicit `commandHandler` / `queryHandler` context members and the
// `route <METHOD> "<path>" -> <Ctx>.<Handler>` api bindings shipped in #1756.
// The concept is the same as .NET's (per-context handler emission + one route
// controller per served api), but the SHAPE is Phoenix-idiomatic and this
// backend is the most divergent: it has no shared workflow spine, only the
// bespoke `with`-chain engine in `workflow-execution-emit.ts`.  We REUSE that
// engine's `lowerStatements` seam (each fallible step becomes a `<-` clause
// threaded through a `with ... do ... end`) but write our own handler shell:
//
//   commandHandler / queryHandler  → `<App>.<Ctx>.Handlers.<Name>` module with
//     `run/1`: destructure the referenced params off the string-keyed map, run
//     the lowered with-chain, and end the do-branch with `{:ok, <returnValue>}`.
//   route <M> <p>                  → one `<Api>RoutesController` per served api
//     with a `def <snake(handler)>(conn, params)` per route calling
//     `<HandlerMod>.run(params)` through a shared `respond/2`.
//
// savesAtExit — the workflow model's "load → mutate → save at exit" — has no
// Phoenix analog: a named operation's context fn (`<op>_<agg>`) ALREADY persists
// its mutation via `persist_change` / `Repo.update` (see context-emit.ts
// `renderNamedOpFunction`).  So an `op-call` in a handler body persists on its
// own; we emit NO redundant `update_<agg>` clause (unlike the .NET path, whose
// op-calls are pure in-memory mutations that need an explicit `SaveAsync`).  A
// handler's `return <expr>` reads the pre-op struct — sound for the common
// id-projection case (`return o.id`); a return of a MUTATED field is a v1
// limitation, matching the workflow op-call's `{:ok, _} <-` discard.
// ---------------------------------------------------------------------------

import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  QueryHandlerIR,
  RouteIR,
} from "../../../ir/types/loom-ir.js";
import { snake, upperFirst } from "../../../util/naming.js";
import type { ApiRoute } from "../api-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  type BodyLine,
  collectParamRefs,
  collectWorkflowStmtParamRefs,
  lowerStatements,
} from "./workflow-execution-emit.js";

type Handler = CommandHandlerIR | QueryHandlerIR;

/** The declared handler-params referenced anywhere in the body (statements or
 *  the terminal `return`), in declaration order (stable output).  Only these
 *  are destructured off the `run/1` map — an unused binding would trip
 *  `mix compile --warnings-as-errors`. */
function referencedParams(h: Handler): string[] {
  const refs = new Set<string>();
  for (const st of h.statements) collectWorkflowStmtParamRefs(st, refs);
  collectParamRefs(h.returnValue, refs);
  return h.params.map((p) => p.name).filter((n) => refs.has(n));
}

/** Compose the lowered body lines into the `run/1` inner body: the with-chain of
 *  fallible clauses, whose `do`-branch runs any `emit` side-effects then returns
 *  `{:ok, <returnValue>}`.  When the body has no fallible clause (a pure
 *  `return <literal>`), there is no `with` — just the result (and emits). */
function assembleHandlerBody(lines: BodyLine[], resultExpr: string): string {
  const withClauses = lines.filter((l) => l.kind === "with-clause");
  const emitLines = lines.filter((l) => l.kind === "emit");
  const doLines = [...emitLines.map((l) => l.text), `{:ok, ${resultExpr}}`];
  if (withClauses.length === 0) {
    return doLines.map((l) => `    ${l}`).join("\n");
  }
  const clauseBlock = withClauses
    .map((l, i) => (i === 0 ? `    with ${l.text}` : `         ${l.text}`))
    .join(",\n");
  return `${clauseBlock} do\n${doLines.map((l) => `      ${l}`).join("\n")}\n    end`;
}

/** Render one handler module — `<App>.<Ctx>.Handlers.<Name>` exposing `run/1`. */
function renderHandlerModule(
  h: Handler,
  kindLabel: "Command handler" | "Query handler",
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  resourceModules: Map<string, string>,
): string {
  const ctxModule = upperFirst(ctx.name);
  const contextModuleFq = `${appModule}.${ctxModule}`;
  const moduleName = `${contextModuleFq}.Handlers.${upperFirst(h.name)}`;

  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: contextModuleFq,
    foundation: "vanilla",
    resourceModules,
  };

  const lines = lowerStatements(h.statements, contextModuleFq, renderCtx, ctx);
  const hasContextCall = lines.some((l) => l.kind === "with-clause");
  const resultExpr = h.returnValue ? renderExpr(h.returnValue, renderCtx) : ":ok";
  const body = assembleHandlerBody(lines, resultExpr);
  // Rewrite the fully-qualified context module to the `Context` alias (kept
  // tidy + short-line-safe), exactly as the workflow emitter does.  Only when
  // there is a context call — otherwise the alias would be unused (-Werror).
  const aliasedBody = hasContextCall ? body.replaceAll(contextModuleFq, "Context") : body;

  const params = referencedParams(h);
  const paramDestructure =
    params.length > 0
      ? `    %{${params.map((n) => `"${snake(n)}" => ${snake(n)}`).join(", ")}} = params\n`
      : "";
  const contextAlias = hasContextCall ? `\n  alias ${contextModuleFq}, as: Context` : "";

  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  ${kindLabel} \`${h.name}\` — plain Elixir (application layer).
  """
${contextAlias}

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
${paramDestructure}${aliasedBody}
  end
end
`;
}

/** Emit the `run/1` handler modules for every explicit `commandHandler` /
 *  `queryHandler` in a context.  A no-op for a context with none.  Routes are
 *  NOT collected here — they ride on the served `Api`'s `RouteIR`s and are
 *  emitted by `emitExplicitRoutesController` after the per-context loop. */
export function emitExplicitHandlers(
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  resourceModules: Map<string, string> = new Map(),
): void {
  const ctxSnake = snake(ctx.name);
  const appSnake = appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());
  for (const h of ctx.commandHandlers ?? []) {
    out.set(
      `lib/${appSnake}/${ctxSnake}/handlers/${snake(h.name)}.ex`,
      renderHandlerModule(h, "Command handler", appModule, ctx, resourceModules),
    );
  }
  for (const h of ctx.queryHandlers ?? []) {
    out.set(
      `lib/${appSnake}/${ctxSnake}/handlers/${snake(h.name)}.ex`,
      renderHandlerModule(h, "Query handler", appModule, ctx, resourceModules),
    );
  }
}

/** Resolve a `route`'s `Context.Handler` target to the handler's IR + kind. */
function resolveRoute(
  r: RouteIR,
  byName: Map<string, EnrichedBoundedContextIR>,
): { ctx: EnrichedBoundedContextIR; handler: Handler } | undefined {
  const ctx = byName.get(r.target.context);
  if (!ctx) return undefined;
  const cmd = (ctx.commandHandlers ?? []).find((h) => h.name === r.target.handler);
  const qry = (ctx.queryHandlers ?? []).find((h) => h.name === r.target.handler);
  const handler = cmd ?? qry;
  return handler ? { ctx, handler } : undefined;
}

/** Rewrite a `{braced}` RouteIR path template into the Phoenix `:snake` form,
 *  snake-casing each param so it matches the handler's `run/1` destructure key
 *  (`{orderId}` → `:order_id`, keyed as `"order_id"` in `params`). */
function phoenixPath(path: string): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => `:${snake(name)}`);
}

/** Emit one `<Api>RoutesController` per served api whose route list is
 *  non-empty: each `route` becomes a `def <snake(handler)>(conn, params)` that
 *  runs the target handler's `run/1` through the shared `respond/2`.  Returns
 *  the `ApiRoute`s to splice into the router `scope "/api"`.  A no-op (empty
 *  route list) for an api that declares no explicit `route`s. */
export function emitExplicitRoutesController(
  appName: string,
  appModule: string,
  apiName: string,
  routes: readonly RouteIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  out: Map<string, string>,
): ApiRoute[] {
  if (routes.length === 0) return [];
  const byName = new Map<string, EnrichedBoundedContextIR>(contexts.map((c) => [c.name, c]));
  const webModule = `${appModule}Web`;
  const controller = `${upperFirst(apiName)}RoutesController`;
  const apiRoutes: ApiRoute[] = [];
  const actions: string[] = [];
  for (const r of routes) {
    const resolved = resolveRoute(r, byName);
    if (!resolved) continue;
    const { ctx, handler } = resolved;
    const action = snake(handler.name);
    const handlerMod = `${appModule}.${upperFirst(ctx.name)}.Handlers.${upperFirst(handler.name)}`;
    actions.push(`  def ${action}(conn, params) do
    respond(conn, ${handlerMod}.run(params))
  end`);
    apiRoutes.push({
      method: r.method.toLowerCase() as ApiRoute["method"],
      path: phoenixPath(r.path),
      controller,
      action: `:${action}`,
    });
  }
  if (actions.length === 0) return [];

  out.set(
    `lib/${appName}_web/controllers/${snake(apiName)}_routes_controller.ex`,
    `# Auto-generated.
defmodule ${webModule}.${controller} do
  use ${webModule}, :controller
  alias ${webModule}.ProblemDetails

  @moduledoc """
  HTTP entry points for the explicit \`route ... -> <Ctx>.<Handler>\` bindings
  of api \`${apiName}\`.
  """

${actions.join("\n\n")}

  # Shared result handler.  Each handler's run/1 result flows through here;
  # keeping the dispatch in one multi-clause function (rather than a case
  # inlined per action) keeps Elixir 1.18's type checker from narrowing the
  # scrutinee to a single handler's exact result shape and flagging the error
  # branches that handler can't produce.
  def respond(conn, {:ok, result}) do
    conn
    |> put_status(200)
    |> json(%{result: serialize(result)})
  end

  def respond(conn, {:error, %Ecto.Changeset{} = changeset}),
    do: ProblemDetails.validation_error_response(conn, changeset)

  def respond(conn, {:error, :not_found}),
    do: ProblemDetails.problem_response(conn, 404, "Not Found", "Resource not found")

  def respond(conn, {:error, :forbidden}),
    do: ProblemDetails.problem_response(conn, 403, "Forbidden", "Handler guard rejected the request")

  def respond(conn, {:error, :precondition_failed}),
    do: ProblemDetails.problem_response(conn, 422, "Precondition Failed", "Handler precondition rejected the request")

  def respond(conn, {:error, reason}),
    do: ProblemDetails.problem_response(conn, 400, "Bad Request", inspect(reason))

  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
  defp serialize(other), do: other
end
`,
  );
  return apiRoutes;
}
