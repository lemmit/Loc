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

import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  ExprIR,
  QueryHandlerIR,
  RouteIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { requestRecordFor } from "../../../ir/util/handler-contracts.js";
import { snake, upperFirst } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import type { ApiRoute } from "../api-emit.js";
import { type RenderCtx, renderExpr } from "../render-expr.js";
import {
  type BodyLine,
  collectParamRefs,
  collectWorkflowStmtParamRefs,
  lowerStatements,
} from "./workflow-execution-emit.js";

type Handler = CommandHandlerIR | QueryHandlerIR;

/** One `"snake_key" => snake_var` binding of the `run/1` string-keyed params
 *  destructure.  `key` is the wire field name (snake) the request arrives under;
 *  `var` is the bound local (same snake token — the destructure introduces it). */
interface Destructure {
  key: string;
  var: string;
}

/** The `command`/`query` RECORD param names of a handler — the params whose
 *  `.field` access FLATTENS to a per-field destructured local (M-T5.10).  A
 *  plain id/scalar param is not a record. */
function recordParamNames(h: Handler, ctx: EnrichedBoundedContextIR): Set<string> {
  return new Set(h.params.filter((p) => requestRecordFor(p.type, ctx)).map((p) => p.name));
}

/** Collect every `<record>.<field>` member access on a RECORD param reachable
 *  from `e` into `acc` (record-param name → the field names read).  A record
 *  param is flattened into exactly the fields the body reads, so only referenced
 *  fields are destructured — an unused binding would trip
 *  `mix compile --warnings-as-errors`.  The receiver of a matched member is the
 *  bare record ref, so recursion stops there. */
function collectRecordFieldAccess(
  e: ExprIR | undefined,
  records: ReadonlySet<string>,
  acc: Map<string, Set<string>>,
): void {
  if (!e) return;
  if (
    e.kind === "member" &&
    e.receiver.kind === "ref" &&
    e.receiver.refKind === "param" &&
    records.has(e.receiver.name)
  ) {
    let fields = acc.get(e.receiver.name);
    if (!fields) {
      fields = new Set<string>();
      acc.set(e.receiver.name, fields);
    }
    fields.add(e.member);
    return;
  }
  switch (e.kind) {
    case "member":
      collectRecordFieldAccess(e.receiver, records, acc);
      return;
    case "method-call":
      collectRecordFieldAccess(e.receiver, records, acc);
      for (const a of e.args) collectRecordFieldAccess(a, records, acc);
      return;
    case "call":
      for (const a of e.args) collectRecordFieldAccess(a, records, acc);
      return;
    case "lambda":
      collectRecordFieldAccess(e.body, records, acc);
      return;
    case "new":
    case "object":
      for (const f of e.fields) collectRecordFieldAccess(f.value, records, acc);
      return;
    case "list":
      for (const el of e.elements) collectRecordFieldAccess(el, records, acc);
      return;
    case "paren":
      collectRecordFieldAccess(e.inner, records, acc);
      return;
    case "unary":
      collectRecordFieldAccess(e.operand, records, acc);
      return;
    case "binary":
      collectRecordFieldAccess(e.left, records, acc);
      collectRecordFieldAccess(e.right, records, acc);
      return;
    case "ternary":
      collectRecordFieldAccess(e.cond, records, acc);
      collectRecordFieldAccess(e.then, records, acc);
      collectRecordFieldAccess(e.otherwise, records, acc);
      return;
    case "convert":
      collectRecordFieldAccess(e.value, records, acc);
      return;
    case "match":
      for (const arm of e.arms) {
        collectRecordFieldAccess(arm.cond, records, acc);
        collectRecordFieldAccess(arm.value, records, acc);
      }
      collectRecordFieldAccess(e.otherwise, records, acc);
      return;
  }
}

/** Statement driver for {@link collectRecordFieldAccess} — mirrors the shape of
 *  `collectWorkflowStmtParamRefs`, feeding every expression of every
 *  `WorkflowStmtIR` kind through the record-field walker. */
function collectRecordFieldsInStmt(
  st: WorkflowStmtIR,
  records: ReadonlySet<string>,
  acc: Map<string, Set<string>>,
): void {
  switch (st.kind) {
    case "precondition":
    case "requires":
    case "expr-let":
      collectRecordFieldAccess(st.expr, records, acc);
      return;
    case "assign":
      collectRecordFieldAccess(st.value, records, acc);
      return;
    case "factory-let":
    case "emit":
      for (const f of st.fields) collectRecordFieldAccess(f.value, records, acc);
      return;
    case "op-call":
      for (const a of st.args) collectRecordFieldAccess(a, records, acc);
      return;
    case "repo-let":
      for (const a of st.args) collectRecordFieldAccess(a, records, acc);
      return;
    case "repo-delete":
      collectRecordFieldAccess(st.entity, records, acc);
      return;
    case "resource-call":
      collectRecordFieldAccess(st.call, records, acc);
      return;
    case "domain-service-call":
      if (st.call.kind === "call")
        for (const a of st.call.args) collectRecordFieldAccess(a, records, acc);
      return;
    case "repo-run":
      for (const a of st.retrievalArgs) collectRecordFieldAccess(a, records, acc);
      collectRecordFieldAccess(st.page?.offset, records, acc);
      collectRecordFieldAccess(st.page?.limit, records, acc);
      return;
    case "for-each":
      collectRecordFieldAccess(st.iterable, records, acc);
      for (const inner of st.body) collectRecordFieldsInStmt(inner, records, acc);
      return;
    case "if-let":
      for (const a of st.retrievalArgs) collectRecordFieldAccess(a, records, acc);
      for (const inner of st.thenBody) collectRecordFieldsInStmt(inner, records, acc);
      for (const inner of st.elseBody ?? []) collectRecordFieldsInStmt(inner, records, acc);
      return;
  }
}

/** The `run/1` params destructure of a handler, wire-preserving under the
 *  M-T5.10 handler-param rewrite.  A plain id/scalar param binds from its own
 *  snake key exactly as before; a `command`/`query` RECORD param is FLATTENED —
 *  each field the body reads (`cmd.<field>`) binds from the SAME snake key an
 *  equivalent flat param used, so the request wire is byte-identical.  Only
 *  referenced fields/params are bound (unused → `--warnings-as-errors`).  Also
 *  returns the record-param name set so the body renderer can rewrite
 *  `cmd.<field>` → the flat local. */
function handlerDestructure(
  h: Handler,
  ctx: EnrichedBoundedContextIR,
): { entries: Destructure[]; records: Set<string> } {
  const records = recordParamNames(h, ctx);
  // Non-record (id/scalar) params referenced anywhere in the body/return.  This
  // set also contains record param NAMES (their member receiver is a param ref),
  // but those are handled via the flattened field path below, not as scalars.
  const scalarRefs = new Set<string>();
  for (const st of h.statements) collectWorkflowStmtParamRefs(st, scalarRefs);
  collectParamRefs(h.returnValue, scalarRefs);
  // Record-param field accesses (`cmd.<field>`) → which fields to destructure.
  const fieldRefs = new Map<string, Set<string>>();
  for (const st of h.statements) collectRecordFieldsInStmt(st, records, fieldRefs);
  collectRecordFieldAccess(h.returnValue, records, fieldRefs);

  const entries: Destructure[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    const key = snake(name);
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ key, var: key });
  };
  for (const p of h.params) {
    const rec = requestRecordFor(p.type, ctx);
    if (rec) {
      const used = fieldRefs.get(p.name);
      if (!used) continue;
      for (const f of rec.fields) if (used.has(f.name)) push(f.name);
    } else if (scalarRefs.has(p.name)) {
      push(p.name);
    }
  }
  return { entries, records };
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

/** The OTP app atom for `Application.get_env` — snake_case of the app module. */
const appAtom = (appModule: string): string =>
  appModule.replace(/([A-Z])/g, (_, c, i) => (i ? "_" : "") + c.toLowerCase());

/** The extern dispatch module — `<App>.<Ctx>.Handlers.<Name>` — whose `run/1`
 *  delegates to the scaffold-once user impl (`<Name>Impl`), resolved through
 *  `Application.get_env` so a test/prod config can swap the implementation.  No
 *  DSL body is rendered (extern is bodyless). */
function renderExternDispatchModule(
  h: Handler,
  kindLabel: "Command handler" | "Query handler",
  appModule: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const contextModuleFq = `${appModule}.${upperFirst(ctx.name)}`;
  const moduleName = `${contextModuleFq}.Handlers.${upperFirst(h.name)}`;
  const implModule = `${moduleName}Impl`;
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc """
  ${kindLabel} \`${h.name}\` — plain Elixir (application layer, extern).

  This handler is \`extern\`: it has no DSL body.  \`run/1\` delegates to the
  scaffold-once, user-owned \`${implModule}\` (yours — regeneration never
  overwrites it).  Override the implementation via config if needed:

      config :${appAtom(appModule)}, ${moduleName}, MyApp.SomeOtherImpl
  """

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
    Application.get_env(:${appAtom(appModule)}, __MODULE__, ${implModule}).run(params)
  end
end
`;
}

/** The scaffold-once user impl module — `<App>.<Ctx>.Handlers.<Name>Impl` —
 *  that raises loudly until filled in (marker on line 1 → CLI writer preserves
 *  it on regen). */
function renderExternImplModule(
  h: Handler,
  kindLabel: "commandHandler" | "queryHandler",
  appModule: string,
  ctx: EnrichedBoundedContextIR,
): string {
  const contextModuleFq = `${appModule}.${upperFirst(ctx.name)}`;
  const moduleName = `${contextModuleFq}.Handlers.${upperFirst(h.name)}Impl`;
  const appSnake = appAtom(appModule);
  const ctxSnake = snake(ctx.name);
  const fileRel = `lib/${appSnake}/${ctxSnake}/handlers/${snake(h.name)}_impl.ex`;
  return `# ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first
# \`generate\` and NEVER overwrites it again, so your implementation survives every
# regenerate.  Replace the \`raise\` with the extern handler's real logic (the one
# external-service call this handler wraps).
defmodule ${moduleName} do
  @moduledoc """
  Hand-written implementation for the extern ${kindLabel} \`${h.name}\`.  Receives
  the string-keyed request \`params\` map; return \`{:ok, result}\` or
  \`{:error, reason}\`.
  """

  @spec run(map()) :: {:ok, term()} | {:error, term()}
  def run(params) when is_map(params) do
    _ = params
    raise "extern ${kindLabel} \`${h.name}\` is not implemented — fill in ${fileRel}"
  end
end
`;
}

/** Render one handler module — `<App>.<Ctx>.Handlers.<Name>` exposing `run/1`. */
function renderHandlerModule(
  h: Handler,
  kindLabel: "Command handler" | "Query handler",
  appModule: string,
  ctx: EnrichedBoundedContextIR,
  resourceModules: Map<string, string>,
): string {
  // Extern handler: bodyless — the dispatch delegates to the scaffold-once impl.
  if (h.extern) return renderExternDispatchModule(h, kindLabel, appModule, ctx);
  const ctxModule = upperFirst(ctx.name);
  const contextModuleFq = `${appModule}.${ctxModule}`;
  const moduleName = `${contextModuleFq}.Handlers.${upperFirst(h.name)}`;

  // M-T5.10: flatten `command`/`query` record params into their referenced
  // fields (destructured off the string-keyed `run/1` map) and rewrite the
  // body's `cmd.<field>` reads to those flat locals via `renderCtx.recordParams`.
  const { entries, records } = handlerDestructure(h, ctx);
  const renderCtx: RenderCtx = {
    thisName: "record",
    contextModule: contextModuleFq,
    foundation: "vanilla",
    resourceModules,
    recordParams: records,
  };

  const lines = lowerStatements(h.statements, contextModuleFq, renderCtx, ctx);
  const hasContextCall = lines.some((l) => l.kind === "with-clause");
  const resultExpr = h.returnValue ? renderExpr(h.returnValue, renderCtx) : ":ok";
  const body = assembleHandlerBody(lines, resultExpr);
  // Rewrite the fully-qualified context module to the `Context` alias (kept
  // tidy + short-line-safe), exactly as the workflow emitter does.  Only when
  // there is a context call — otherwise the alias would be unused (-Werror).
  const aliasedBody = hasContextCall ? body.replaceAll(contextModuleFq, "Context") : body;

  const paramDestructure =
    entries.length > 0
      ? `    %{${entries.map((d) => `"${d.key}" => ${d.var}`).join(", ")}} = params\n`
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
  const emit = (h: Handler, kind: "Command handler" | "Query handler"): void => {
    out.set(
      `lib/${appSnake}/${ctxSnake}/handlers/${snake(h.name)}.ex`,
      renderHandlerModule(h, kind, appModule, ctx, resourceModules),
    );
    // Extern: the scaffold-once user impl the dispatch above delegates to.
    if (h.extern) {
      out.set(
        `lib/${appSnake}/${ctxSnake}/handlers/${snake(h.name)}_impl.ex`,
        renderExternImplModule(
          h,
          kind === "Command handler" ? "commandHandler" : "queryHandler",
          appModule,
          ctx,
        ),
      );
    }
  };
  for (const h of ctx.commandHandlers ?? []) emit(h, "Command handler");
  for (const h of ctx.queryHandlers ?? []) {
    // paged-run queryHandler: no `run/1` handler module — its route action calls
    // the aggregate context's synthesized paged FIND function directly and
    // renders the wire envelope (the generic handler body can't return a paged
    // carrier).  See `emitExplicitRoutesController`.
    if (!h.extern && h.returnType && pagedReturn(h.returnType)) continue;
    emit(h, "Query handler");
  }
}

/** Recover the synthesized `repo-run` statement of a paged-run queryHandler
 *  (`queryHandler H(...): <Agg> paged { let r = Repo.run(<Criterion>(args));
 *  return r }`) — carrying the aggregate + the paged FIND name (`retrievalName`
 *  = `findAllBy<Criterion>`) so the route can call its context function. */
function pagedRunStmt(
  h: Handler,
  ctx: EnrichedBoundedContextIR,
): Extract<WorkflowStmtIR, { kind: "repo-run" }> {
  const retName = h.returnValue?.kind === "ref" ? h.returnValue.name : undefined;
  const run = h.statements.find(
    (s): s is Extract<WorkflowStmtIR, { kind: "repo-run" }> =>
      s.kind === "repo-run" && !!s.synthCriterion && s.name === retName,
  );
  if (!run) {
    throw new Error(
      `internal: paged queryHandler '${h.name}' in '${ctx.name}' does not match the ` +
        "supported `let r = Repo.run(<Criterion>(args)); return r` shape. Please file a bug.",
    );
  }
  return run;
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
 *  the `ApiRoute`s to splice into the router root `scope "/"` (each carries the
 *  `!root:` sentinel — see `renderVanillaRouter`) so they serve at their
 *  absolute declared path, clear of the auto-CRUD `/api` routes.  A no-op (empty
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
  // Set when any route is a paged-run queryHandler — the controller then carries
  // a `page_param/3` coercion helper (Phoenix delivers query params as strings).
  let hasPaged = false;
  for (const r of routes) {
    const resolved = resolveRoute(r, byName);
    if (!resolved) continue;
    const { ctx, handler } = resolved;
    const action = snake(handler.name);
    // paged-run queryHandler: call the aggregate context's synthesized paged FIND
    // (`<find>_<agg>`) directly with the criterion params + page/pageSize/sort/dir
    // (coerced), then render the `{items,…}` wire envelope (items serialised).
    if (!handler.extern && handler.returnType && pagedReturn(handler.returnType)) {
      hasPaged = true;
      const run = pagedRunStmt(handler, ctx);
      const pathNames = new Set([...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
      const ctxFn = `${appModule}.${upperFirst(ctx.name)}.${snake(run.retrievalName)}_${snake(run.aggName)}`;
      const critArgs = handler.params.map(
        (p) => `params[${JSON.stringify(pathNames.has(p.name) ? snake(p.name) : p.name)}]`,
      );
      const callArgs = [
        ...critArgs,
        `page_param(params, "page", ${PAGED_DEFAULT_PAGE})`,
        `page_param(params, "pageSize", ${PAGED_DEFAULT_PAGE_SIZE})`,
        `Map.get(params, "sort", "id")`,
        `Map.get(params, "dir", "asc")`,
      ];
      actions.push(`  def ${action}(conn, params) do
    with {:ok, result} <-
           ${ctxFn}(
             ${callArgs.join(",\n             ")}
           ) do
      json(conn, %{result | items: Enum.map(result.items, &serialize/1)})
    end
  end`);
      apiRoutes.push({
        method: r.method.toLowerCase() as ApiRoute["method"],
        path: `!root:${phoenixPath(r.path)}`,
        controller,
        action: `:${action}`,
      });
      continue;
    }
    const handlerMod = `${appModule}.${upperFirst(ctx.name)}.Handlers.${upperFirst(handler.name)}`;
    actions.push(`  def ${action}(conn, params) do
    respond(conn, ${handlerMod}.run(params))
  end`);
    apiRoutes.push({
      method: r.method.toLowerCase() as ApiRoute["method"],
      // `!root:` splices the route into the router's root `scope "/"` (served at
      // its absolute declared path) rather than nesting it under `scope "/api"`.
      // The explicit `route "<path>" -> ...` path is already absolute (e.g.
      // `/orders/{id}`), so `/api` nesting both mis-served it (`/api/orders/...`)
      // AND collided with the always-on auto-CRUD routes (`/api/orders/:id`) —
      // Phoenix ignores param names, so the shadowed clause fails
      // `mix compile --warnings-as-errors`.  Root-scoping matches every other
      // backend (scaffold routes at `/orders/...`, auto-CRUD at `/api/orders/...`).
      path: `!root:${phoenixPath(r.path)}`,
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

  # A collection result (a find handler declaring an Agg-Response array, whose
  # body returns the raw entity list) projects each element — an Ecto schema
  # struct is not Jason-encodable as-is, so a bare list would 500 on encode.
  defp serialize(list) when is_list(list), do: Enum.map(list, &serialize/1)
  defp serialize(%_{} = struct), do: struct |> Map.from_struct() |> Map.drop([:__meta__, :__struct__])
  defp serialize(other), do: other${
    hasPaged
      ? `

  # 1-based page coercion for a paged-run queryHandler route (Phoenix delivers
  # query params as strings; a missing/blank/non-integer value falls back to the
  # shared default).
  defp page_param(params, key, default) do
    case params[key] do
      v when is_integer(v) -> v
      v when is_binary(v) ->
        case Integer.parse(v) do
          {n, _} when n >= 1 -> n
          _ -> default
        end

      _ -> default
    end
  end`
      : ""
  }
end
`,
  );
  return apiRoutes;
}
