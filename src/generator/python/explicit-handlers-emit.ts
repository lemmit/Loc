// ---------------------------------------------------------------------------
// Explicit application/transport layer → Python / FastAPI emission
// (unfoldable-api-derivation.md, Layers 3-4; A2 slice — the Python sibling of
// the .NET A1 emitter in ../dotnet/explicit-handlers-emit.ts).
//
// Reads the explicit `commandHandler` / `queryHandler` context members and the
// `route <METHOD> "<path>" -> <Ctx>.<Handler>` api bindings shipped in #1756:
//
//   commandHandler / queryHandler → `app/application/<snake(name)>.py`, an
//       `async def` that constructs the repos its body touches, runs the
//       WorkflowStmtIR body (load → mutate → save), then `return <returnValue>`.
//   route <M> <p>                 → one `app/http/<snake(api)>_routes.py`
//       APIRouter whose path-op coerces each wire path param into its domain
//       type and calls the handler function.
//
// PARALLEL emitter: it reuses the workflow body machinery (`pyWorkflowStmtTarget`
// + `renderWorkflowStmtChunks`, exported from workflows-builder.ts) and the
// wire→domain coercion (`pyWireToDomain`, from routes-builder.ts), but writes its
// own handler/router shells, so the shipped workflow / routes emitters stay
// byte-identical.  The handler body renders the workflow statements, then
// `return <returnValue>` (the IR field the workflow stmt target has no arm for).
//
// FORK (differs from .NET, noted deliberately): Python has no mediator, so a
// handler is a plain `async def` in `app/application/` and the router calls it
// directly.  Path params carry the wire type; the router coerces
// (`OrderId(order_id)`) before the call, so the handler receives domain-typed
// params — mirroring the .NET controller→handler split without a message bus.
//
// v1 scope (mirrors .NET A1): handler params are ids / scalars (the common REST
// case); response projection is a `{ "result": <value> }` envelope.
//
// C2 (Python sibling of .NET C1/#1830): a handler whose return type resolves to
// an aggregate/entity projects the domain instance to its wire shape via the
// repo's `to_wire(...)` (the same projection the auto-derived read routes use) and
// annotates `-> dict[str, object]`, so the route serialises the contract, not the
// raw SQLAlchemy row.  Id / scalar / void returns are unchanged.
// ---------------------------------------------------------------------------

import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  ParamIR,
  QueryHandlerIR,
  RouteIR,
  WorkflowStmtIR,
} from "../../ir/types/loom-ir.js";
import { operationUsesCurrentUser } from "../../ir/types/loom-ir.js";
import { wireTypeInfo } from "../../ir/types/wire-types.js";
import { normalizeHandlerReturn, requestRecordFor } from "../../ir/util/handler-contracts.js";
import { walkExpr } from "../../ir/validate/checks/shared.js";
import { lines } from "../../util/code-builder.js";
import { plural, snake } from "../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../util/scaffold-once.js";
import { renderWorkflowStmtChunks } from "../_workflow/stmt-target.js";
import { requestPyType } from "./emit/http-models.js";
import { type PyRenderContext, renderPyExpr, renderPyType } from "./render-expr.js";
import { pyWireToDomain } from "./routes-builder.js";
import { collectUsedLetNames, pyWorkflowStmtTarget } from "./workflows-builder.js";

type Handler = CommandHandlerIR | QueryHandlerIR;

/** A handler's params FLATTENED for the FastAPI `def` signature + request body:
 *  a `command`/`query` RECORD param (M-T5.10 handler-param rewrite) expands to
 *  its fields (so the record's fields become the flat `def`/`<Handler>Body`
 *  fields, byte-identical to the flat-param form); every other param (a
 *  path-bound id / scalar / value object) passes through.  An extern handler
 *  keeps its raw params — its scaffold-once impl owns the signature. */
function flatHandlerParams(h: Handler, ctx: EnrichedBoundedContextIR): ParamIR[] {
  if (h.extern) return h.params.map((p) => ({ name: p.name, type: p.type }));
  const out: ParamIR[] = [];
  for (const p of h.params) {
    const rec = requestRecordFor(p.type, ctx);
    if (rec) for (const f of rec.fields) out.push({ name: f.name, type: f.type });
    else out.push({ name: p.name, type: p.type });
  }
  return out;
}

/** The record-param NAMES of a handler — the body refs whose `.<field>` access
 *  resolves to the flattened field local rather than attribute access (fed to
 *  the Python render context as `recordParamNames`). */
function recordParamNames(h: Handler, ctx: EnrichedBoundedContextIR): Set<string> {
  return new Set(h.params.filter((p) => requestRecordFor(p.type, ctx)).map((p) => p.name));
}

// --- Extern handler (bodyless) — scaffold-once user impl module -------------
// An `extern` handler has no DSL body: the generated `app/application/<snake>.py`
// dispatch still exists (the router imports it unchanged), but instead of a
// rendered load→mutate→save body it delegates to a scaffold-once, user-owned
// impl at `app/application/impl/<snake>_impl.py`.  The path/name is
// DETERMINISTIC and stable forever (renames orphan user code).

/** The user impl module's file path (`out.set` key). */
const externImplPath = (name: string): string => `app/application/impl/${snake(name)}_impl.py`;
/** The impl function name (`PlaceOrder` → `place_order_impl`). */
const externImplFn = (name: string): string => `${snake(name)}_impl`;

/** Domain-type import lines for a handler's params/return signature — the
 *  ids / value objects / enums the signature actually names (ids/scalars is the
 *  v1 handler scope, so entity imports aren't derived here). */
function pyDomainImportLines(signatureText: string, ctx: EnrichedBoundedContextIR): string[] {
  const scan = signatureText.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const idNames = ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter((n, i, arr) => refersTo(n) && arr.indexOf(n) === i)
    .sort();
  const voEnumNames = [
    ...new Set([...ctx.enums.map((e) => e.name), ...ctx.valueObjects.map((v) => v.name)]),
  ]
    .filter(refersTo)
    .sort();
  const out: string[] = [];
  if (idNames.length > 0) out.push(`from app.domain.ids import ${idNames.join(", ")}`);
  if (voEnumNames.length > 0) {
    out.push(`from app.domain.value_objects import ${voEnumNames.join(", ")}`);
  }
  return out;
}

/** The generated extern DISPATCH module: same `async def <snake>(session, …)`
 *  the router already imports, but its body delegates to the user impl.  For a
 *  void command it awaits without returning; otherwise it returns the impl's
 *  value verbatim (the impl owns the return contract). */
function renderPyExternDispatch(h: Handler, ctx: EnrichedBoundedContextIR): string {
  const fnName = snake(h.name);
  const implFn = externImplFn(h.name);
  const paramSig = h.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  const params = ["session: AsyncSession", ...paramSig].join(", ");
  const ret = h.returnType ? renderPyType(h.returnType) : "None";
  const callArgs = h.params.map((p) => snake(p.name)).join(", ");
  const call = `${implFn}(${callArgs})`;
  const bodyLine = h.returnType ? `    return await ${call}` : `    await ${call}`;
  const sigText = `${paramSig.join(" ")} ${ret}`;
  return lines(
    `"""${h.name} application handler (extern dispatch).  Auto-generated."""`,
    "",
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    `from app.application.impl.${implFn} import ${implFn}`,
    ...pyDomainImportLines(sigText, ctx),
    "",
    "",
    `async def ${fnName}(${params}) -> ${ret}:`,
    bodyLine,
    "",
  );
}

/** The scaffold-once user impl stub — `app/application/impl/<snake>_impl.py`.
 *  Raises loudly until the user fills it in (marker on line 1 → the CLI writer
 *  preserves it on regen). */
function renderPyExternImpl(h: Handler, ctx: EnrichedBoundedContextIR): string {
  const implFn = externImplFn(h.name);
  const paramSig = h.params.map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`);
  const ret = h.returnType ? renderPyType(h.returnType) : "None";
  const kind = (ctx.queryHandlers ?? []).includes(h as QueryHandlerIR)
    ? "queryHandler"
    : "commandHandler";
  const msg = `extern ${kind} '${h.name}' is not implemented — fill in ${externImplPath(h.name)}`;
  const importLines = pyDomainImportLines(`${paramSig.join(" ")} ${ret}`, ctx);
  return lines(
    `# ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first`,
    "# `generate` and NEVER overwrites it again, so your implementation survives every",
    "# regenerate.  Replace the `raise` with the extern handler's real logic.",
    '"""Hand-written extern handler implementation."""',
    "",
    ...(importLines.length > 0 ? [...importLines, ""] : []),
    "",
    `async def ${implFn}(${paramSig.join(", ")}) -> ${ret}:`,
    `    raise NotImplementedError(`,
    `        ${JSON.stringify(msg)}`,
    `    )`,
    "",
  );
}

/** Aggregate names a handler body constructs via `<Agg>.create(...)` (a
 *  `factory-let` — the scaffolded `create` handler's shape).  Their domain
 *  module must be imported (`from app.domain.<snake> import <Agg>`), mirroring
 *  the workflow builder's factory-let import derivation. */
function collectFactoryAggs(
  stmts: readonly WorkflowStmtIR[],
  into: Set<string> = new Set(),
): Set<string> {
  for (const s of stmts) {
    if (s.kind === "factory-let") into.add(s.aggName);
    else if (s.kind === "for-each") collectFactoryAggs(s.body, into);
    else if (s.kind === "if-let") {
      collectFactoryAggs(s.thenBody, into);
      collectFactoryAggs(s.elseBody ?? [], into);
    }
  }
  return into;
}

/** The repos a handler body references (repo loads + exit-saves), keyed by
 *  repo name → aggregate name.  The handler constructs `<Agg>Repository(...)`
 *  for each and the workflow stmt target names the handle `snake(repoName)`. */
function collectRepos(h: Handler): Map<string, string> {
  const repos = new Map<string, string>();
  const walk = (stmts: readonly WorkflowStmtIR[]): void => {
    for (const s of stmts) {
      if (s.kind === "repo-let" || s.kind === "repo-run" || s.kind === "repo-delete")
        repos.set(s.repoName, s.aggName);
      else if (s.kind === "for-each") {
        walk(s.body);
        for (const sv of s.savesPerIteration) repos.set(sv.repoName, sv.aggName);
      } else if (s.kind === "if-let") {
        repos.set(s.repoName, s.aggName);
        walk(s.thenBody);
        walk(s.elseBody ?? []);
        for (const sv of [...s.savesInThen, ...s.savesInElse]) repos.set(sv.repoName, sv.aggName);
      }
    }
  };
  walk(h.statements);
  for (const save of h.savesAtExit) repos.set(save.repoName, save.aggName);
  return repos;
}

function lookupGatedOp(ctx: EnrichedBoundedContextIR, aggName: string, opName: string): boolean {
  const op = ctx.aggregates
    .find((a) => a.name === aggName)
    ?.operations.find((o) => o.name === opName);
  return !!op && operationUsesCurrentUser(op);
}

/** Whether the handler body calls a currentUser-gated operation — the op's
 *  method takes a trailing `current_user`, so the handler (and its caller
 *  route) must bind the actor.  v1 handlers are ids/scalars, so this is inert
 *  for the common case (byte-identical to a no-user handler). */
function handlerUsesUser(h: Handler, ctx: EnrichedBoundedContextIR): boolean {
  const walk = (sts: readonly WorkflowStmtIR[]): boolean =>
    sts.some((s) => {
      if (s.kind === "op-call") return lookupGatedOp(ctx, s.aggName, s.op);
      if (s.kind === "for-each") return walk(s.body);
      if (s.kind === "if-let") return walk(s.thenBody) || walk(s.elseBody ?? []);
      return false;
    });
  return walk(h.statements);
}

/** Render the handler `async def` body: repo construction, the WorkflowStmtIR
 *  sequence, exit-saves, then `return <returnValue>`. */
function renderHandlerModule(
  h: Handler,
  ctx: EnrichedBoundedContextIR,
  hasDispatch: boolean,
): string {
  // Extern handler: no DSL body — the dispatch delegates to the scaffold-once
  // user impl module (emitted separately in `emitPyExplicitHandlers`).
  if (h.extern) return renderPyExternDispatch(h, ctx);
  const fnName = snake(h.name);
  const usesUser = handlerUsesUser(h, ctx);

  // A `command`/`query` RECORD param (M-T5.10 handler-param rewrite) FLATTENS
  // into its fields — the `def` signature carries the flat domain-typed fields
  // (byte-identical to the flat-param form) — and the body's `cmd.<field>`
  // resolves to the flat field local via `recordParamNames` on the render ctx.
  const records = recordParamNames(h, ctx);
  const rctx: PyRenderContext = { thisName: "self", recordParamNames: records };
  const params = [
    "session: AsyncSession",
    ...flatHandlerParams(h, ctx).map((p) => `${snake(p.name)}: ${renderPyType(p.type)}`),
    ...(usesUser ? ["current_user: User"] : []),
  ].join(", ");

  const repos = collectRepos(h);
  const dispatcherExpr = hasDispatch ? "make_dispatcher(session)" : "NoopDomainEventDispatcher()";

  // C2 (Python sibling of .NET C1/#1830): a handler returning an aggregate/entity
  // projects the domain (SQLAlchemy) instance to its wire shape via the repo's
  // `to_wire(...)` — the same projection the auto-derived read routes use — so the
  // route serialises the contract, not the raw ORM row. Id / scalar / void returns
  // are unchanged. A scaffolded read DECLARES a `<Agg>Response` return, which
  // `normalizeHandlerReturn` maps back to the entity so the projection fires (and
  // a COLLECTION return maps each element). When projecting, the annotation becomes
  // `dict[str, object]` (or `list[dict[str, object]]`), NOT the aggregate class
  // (which would need a domain import the module never made).
  const normRet = normalizeHandlerReturn(h.returnType, ctx);
  let projectRepoHandle: string | undefined;
  let projectIsCollection = false;
  if (normRet) {
    const info = wireTypeInfo(normRet, "response");
    if (info.refKind === "entity") {
      projectIsCollection = info.isCollection;
      for (const [repo, agg] of repos) {
        if (agg === info.base) {
          projectRepoHandle = snake(repo);
          break;
        }
      }
      // The return aggregate was never loaded (e.g. a freshly created entity):
      // construct a repo purely to project it, keyed by its plural name.
      if (!projectRepoHandle) {
        projectRepoHandle = snake(plural(info.base));
        repos.set(plural(info.base), info.base);
      }
    }
  }
  const ret = projectRepoHandle
    ? projectIsCollection
      ? "list[dict[str, object]]"
      : "dict[str, object]"
    : normRet
      ? renderPyType(normRet)
      : "None";
  const repoLines = [...repos].map(
    ([repo, agg]) => `    ${snake(repo)} = ${agg}Repository(session, ${dispatcherExpr})`,
  );

  // A dead `let` would trip ruff F841 — keep the used set current by folding the
  // returnValue's let refs into it (the shared collector only scans statements).
  const usedLets = collectUsedLetNames(h.statements);
  walkExpr(h.returnValue, (n) => {
    if (n.kind === "ref" && n.refKind === "let") usedLets.add(n.name);
  });
  const stmtLines = renderWorkflowStmtChunks(
    h.statements,
    pyWorkflowStmtTarget(rctx, ctx, usedLets),
    "    ",
  ).flat();
  const saveLines = h.savesAtExit.map(
    (s) => `    await ${snake(s.repoName)}.save(${snake(s.name)})`,
  );
  const returnExpr = h.returnValue
    ? projectRepoHandle
      ? projectIsCollection
        ? `[${projectRepoHandle}.to_wire(__e) for __e in ${renderPyExpr(h.returnValue, rctx)}]`
        : `${projectRepoHandle}.to_wire(${renderPyExpr(h.returnValue, rctx)})`
      : renderPyExpr(h.returnValue, rctx)
    : null;
  const returnLine = returnExpr ? `    return ${returnExpr}` : null;

  const bodyLines = [...repoLines, ...stmtLines, ...saveLines, ...(returnLine ? [returnLine] : [])];
  const body = bodyLines.length > 0 ? bodyLines.join("\n") : "    pass";

  const def = `async def ${fnName}(${params}) -> ${ret}:\n${body}\n`;

  // Import scan: blank string literals, then look for whole-word references.
  const scan = def.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const repoAggs = [...new Set([...repos.values()])].sort();
  const idNames = ctx.aggregates
    .map((a) => `${a.name}Id`)
    .filter((n, i, arr) => refersTo(n) && arr.indexOf(n) === i)
    .sort();
  const enumNames = ctx.enums
    .map((e) => e.name)
    .filter(refersTo)
    .sort();
  const voNames = ctx.valueObjects
    .map((v) => v.name)
    .filter(refersTo)
    .sort();

  return lines(
    `"""${h.name} application handler.  Auto-generated."""`,
    "",
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    refersTo("datetime") ? "from datetime import UTC, datetime" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "",
    usesUser ? "from app.auth.user import User" : null,
    ...repoAggs.map(
      (agg) => `from app.db.repositories.${snake(agg)}_repository import ${agg}Repository`,
    ),
    hasDispatch ? "from app.dispatch import make_dispatcher" : null,
    hasDispatch ? null : "from app.domain.events import NoopDomainEventDispatcher",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    ...[...collectFactoryAggs(h.statements)]
      .filter((n) => refersTo(n))
      .sort()
      .map((n) => `from app.domain.${snake(n)} import ${n}`),
    [...enumNames, ...voNames].length > 0
      ? `from app.domain.value_objects import ${[...enumNames, ...voNames].sort().join(", ")}`
      : null,
    "",
    "",
    def,
  );
}

/** Emit `app/application/<snake(name)>.py` for every explicit handler in a
 *  context.  A no-op for a context with none. */
export function emitPyExplicitHandlers(
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
  hasDispatch: boolean,
): void {
  const handlers = [...(ctx.commandHandlers ?? []), ...(ctx.queryHandlers ?? [])];
  if (handlers.length === 0) return;
  out.set("app/application/__init__.py", "");
  const hasExtern = handlers.some((h) => h.extern);
  if (hasExtern) out.set("app/application/impl/__init__.py", "");
  for (const h of handlers) {
    out.set(`app/application/${snake(h.name)}.py`, renderHandlerModule(h, ctx, hasDispatch));
    // Extern: the scaffold-once user impl the dispatch above delegates to.
    if (h.extern) out.set(externImplPath(h.name), renderPyExternImpl(h, ctx));
  }
}

/** Snake-case the `{param}` placeholders of a route path (`/orders/{orderId}`
 *  → `/orders/{order_id}`) so the FastAPI path params match the emitted
 *  snake_case function params. */
function snakePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_m, name: string) => `{${snake(name)}}`);
}

const camelName = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

/** The `{token}` names in a route path — the params bound from the URL rather
 *  than the request body (mirrors the .NET `pathParamNames`). */
function pathParamNames(path: string): Set<string> {
  const names = new Set<string>();
  for (const m of path.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
  return names;
}

/** Emit one APIRouter per served api whose route list is non-empty:
 *  `app/http/<snake(api)>_routes.py`.  Each `route` becomes a path-op that
 *  coerces its wire path params into the domain types and calls the handler
 *  function.  Returns whether a file was emitted (so main can register it). */
export function emitPyExplicitRouteRouter(
  apiName: string,
  routes: readonly RouteIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  out: Map<string, string>,
): boolean {
  if (routes.length === 0) return false;
  const byName = new Map<string, EnrichedBoundedContextIR>(contexts.map((c) => [c.name, c]));

  const handlerImports = new Set<string>();
  const modelBlocks: string[] = [];
  const routeBlocks: string[] = [];
  let usesResponse = false;

  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((h) => h.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((h) => h.name === r.target.handler);
    const h: Handler | undefined = cmd ?? qry;
    if (!h) continue;
    handlerImports.add(h.name);

    const usesUser = handlerUsesUser(h, ctx);
    // Split params: those bound by a `{token}` in the route path stay URL path
    // params (wire type + call-site coercion); every other param rides in ONE
    // `body: <Handler>Body` request model. A bare Pydantic-model param would be
    // inferred as THE body (fields at top level) and a bare scalar as a query
    // param, so multiple body params must collect into a single model. (Python
    // sibling of the .NET `[FromBody] <Handler>Body` split — B1/#1822.)
    // A `command`/`query` RECORD param FLATTENS into its fields (the Pydantic
    // `<Handler>Body` + call args carry the flat fields, byte-identical to the
    // flat-param form; a record's field binds from the SAME request location an
    // equivalent flat param would — path if its name is a route `{token}`, else
    // the body). Then split on the route `{token}`s as before.
    const pathNames = pathParamNames(r.path);
    const effParams = flatHandlerParams(h, ctx);
    const pathParams = effParams.filter((p) => pathNames.has(p.name));
    const bodyParams = effParams.filter((p) => !pathNames.has(p.name));

    let bodyModelName: string | undefined;
    if (bodyParams.length > 0) {
      bodyModelName = `${h.name}Body`;
      modelBlocks.push(
        lines(
          `class ${bodyModelName}(BaseModel):`,
          ...bodyParams.map((p) => `    ${snake(p.name)}: ${requestPyType(p.type, ctx)}`),
        ),
      );
    }
    const sig = [
      ...pathParams.map((p) => `${snake(p.name)}: ${requestPyType(p.type, ctx)}`),
      ...(bodyModelName ? [`body: ${bodyModelName}`] : []),
      ...(usesUser ? ["request: Request"] : []),
      "session: SessionDep",
    ].join(", ");
    // Call args stay in flat declared order: path params coerce from the route
    // token, body params read off `body.<snake>` before coercing.
    const callArgs = [
      "session",
      ...effParams.map((p) =>
        pathNames.has(p.name)
          ? pyWireToDomain(snake(p.name), p.type, ctx)
          : pyWireToDomain(`body.${snake(p.name)}`, p.type, ctx),
      ),
      ...(usesUser ? ["current_user"] : []),
    ].join(", ");

    const method = r.method.toLowerCase();
    const path = snakePath(r.path);
    const opId = camelName(h.name);
    // A query always returns; a command returns iff its body yields a value
    // (`returnValue`) OR — for an extern command — it declares a returnType.
    const hasReturn = !!qry || !!cmd?.returnValue || !!(cmd?.extern && cmd.returnType);
    const routeName = `${snake(h.name)}_route`;

    if (hasReturn) {
      routeBlocks.push(
        lines(
          `@router.${method}("${path}", operation_id="${opId}")`,
          `async def ${routeName}(${sig}) -> dict[str, object]:`,
          usesUser ? "    current_user: User = request.state.current_user" : null,
          `    result = await ${snake(h.name)}(${callArgs})`,
          `    return {"result": result}`,
        ),
      );
    } else {
      usesResponse = true;
      routeBlocks.push(
        lines(
          `@router.${method}("${path}", status_code=204, operation_id="${opId}")`,
          `async def ${routeName}(${sig}) -> Response:`,
          usesUser ? "    current_user: User = request.state.current_user" : null,
          `    await ${snake(h.name)}(${callArgs})`,
          `    return Response(status_code=204)`,
        ),
      );
    }
  }
  if (routeBlocks.length === 0) return false;

  const body = [...modelBlocks, ...routeBlocks].join("\n\n\n");
  const scan = body.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const usesRequest = refersTo("request");

  // A body param typed as a value object rides as its wire model (`X as XModel`,
  // requestPyType's "Model" suffix); the call-site coercion still constructs the
  // DOMAIN class (`X(...)`), imported below from value_objects.
  const voModelImports = [...new Set(contexts.flatMap((c) => c.valueObjects.map((v) => v.name)))]
    .filter((n) => refersTo(`${n}Model`))
    .sort();

  // Every `X id` coercion wraps as `XId(...)`; offer every hosted context's
  // aggregate ids and keep the ones actually referenced.
  const idNames = [...new Set(contexts.flatMap((c) => c.aggregates.map((a) => `${a.name}Id`)))]
    .filter(refersTo)
    .sort();
  const voEnumNames = [
    ...new Set(
      contexts.flatMap((c) => [
        ...c.enums.map((e) => e.name),
        ...c.valueObjects.map((v) => v.name),
      ]),
    ),
  ]
    .filter(refersTo)
    .sort();

  const file = lines(
    `"""${apiName} explicit route bindings.  Auto-generated."""`,
    "",
    refersTo("Decimal") ? "from decimal import Decimal" : null,
    `from fastapi import ${[
      "APIRouter",
      "Depends",
      usesRequest ? "Request" : null,
      usesResponse ? "Response" : null,
    ]
      .filter(Boolean)
      .join(", ")}`,
    refersTo("BaseModel") ? "from pydantic import BaseModel" : null,
    "from sqlalchemy.ext.asyncio import AsyncSession",
    "from typing import Annotated",
    "",
    usesRequest ? "from app.auth.user import User" : null,
    ...[...handlerImports].sort().map((n) => `from app.application.${snake(n)} import ${snake(n)}`),
    "from app.db.engine import get_session",
    idNames.length > 0 ? `from app.domain.ids import ${idNames.join(", ")}` : null,
    voEnumNames.length > 0
      ? `from app.domain.value_objects import ${voEnumNames.join(", ")}`
      : null,
    voModelImports.length > 0
      ? `from app.http.wire_models import ${voModelImports.map((n) => `${n} as ${n}Model`).join(", ")}`
      : null,
    "",
    "SessionDep = Annotated[AsyncSession, Depends(get_session)]",
    "",
    "router = APIRouter()",
    "",
    "",
    body,
    "",
  );
  out.set(`app/http/${snake(apiName)}_routes.py`, file);
  return true;
}
