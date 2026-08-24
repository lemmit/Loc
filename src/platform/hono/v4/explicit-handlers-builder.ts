import { renderHonoLogCall } from "../../../generator/_obs/render-hono.js";
// ---------------------------------------------------------------------------
// Explicit application/transport layer → Hono emission
// (unfoldable-api-derivation.md, Layers 3-4; A2 slice — the Hono sibling of the
// .NET A1 emitter in src/generator/dotnet/explicit-handlers-emit.ts).
//
// Reads the explicit `commandHandler` / `queryHandler` context members and the
// `route <METHOD> "<path>" -> <Ctx>.<Handler>` api bindings and emits one
// per-served-api router file:
//
//   commandHandler / queryHandler + route <M> <p> → an `app.openapi(createRoute
//     ({ method, path, ... }), async (httpCtx) => { ... })` route whose body
//     runs the handler's workflow-statement body directly.
//
// PARALLEL emitter (like the .NET one): it reuses the Hono workflow body
// renderer (`honoWorkflowStmtTarget` + `renderExprWithParams` +
// `collectReposForWorkflow`, exported from workflow-builder.ts) but writes its
// own router shell, so the shipped workflow emitter stays byte-identical.  Hono
// has no mediator seam, so — unlike .NET, which emits `ICommand`/`IQuery`
// records + handler classes — each handler's logic is emitted DIRECTLY as an
// `app.openapi` route: bind the wire-coerced params to locals, construct repos
// inline, render the body statements, save at exit, then return the value.
//
// Param binding (M-T5.10 handler-param rewrite): a handler takes either a plain
// id/scalar param (path-bound when its name is a `{token}`, else a body field)
// OR a `command`/`query` request RECORD param (`requestRecordFor`).  A command
// record IS the JSON body (its fields deserialise into a materialised `cmd`
// object); a query record assembles from path + query-string (a `query` object);
// either way the body reads `cmd.<field>` / `query.<field>`.  A path-param id
// stays a SEPARATE handler param — a route `{orderId}` can't live in a body
// record — so its wire binding is unchanged from the flat-param form.
//
// Aggregate-return projection (C2, the Hono sibling of the .NET C1 in #1830): a
// handler that returns a domain aggregate/entity projects it to its wire shape
// via the owning repo's `toWire(...)` — reusing the repo the body already built
// for that aggregate (or constructing one when the return aggregate was never
// loaded).  A collection return maps each element; id / scalar returns serialise
// as-is (`<expr> as unknown`).  A scaffolded read now DECLARES a `<Agg>Response`
// return, which `normalizeHandlerReturn` maps back to the entity for projection.
//
// 200-body typing (M-T5.10): a handler that returns a SINGLE aggregate/entity
// types its 200 as that entity's `<Agg>Response`, imported from the aggregate's
// own routes file (the same schema `http/views.ts` imports; single-registered
// there so the spec keeps one `$ref`).  Its `repo.toWire(...)` body yields
// exactly that shape, so schema and value agree under strict tsc.  Collection /
// id / scalar / enum / VO returns keep `z.unknown()` — their `<expr> as unknown`
// body cast is deliberately loose and a typed schema would reject it.
// ---------------------------------------------------------------------------

import { renderWorkflowStmtChunks } from "../../../generator/_workflow/stmt-target.js";
import { renderTsType } from "../../../generator/typescript/render-expr.js";
import { aggHasFieldMask } from "../../../generator/typescript/repository-wire-builder.js";
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  PAGED_MAX_PAGE,
  PAGED_MAX_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  EnumIR,
  ExprIR,
  QueryHandlerIR,
  RouteIR,
  TypeIR,
  ValueObjectIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { wireTypeInfo } from "../../../ir/types/wire-types.js";
import {
  aggregatesHaveUniqueKeys,
  aggregatesNeedConcurrency,
} from "../../../ir/util/aggregate-flags.js";
import { normalizeHandlerReturn, requestRecordFor } from "../../../ir/util/handler-contracts.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { collectReachableTypes } from "../../../ir/util/reachable-types.js";
import { walkExprDeep, walkWorkflowStmtExprsDeep } from "../../../ir/util/walk.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import { emitWireSchema, QUERY_BOOL, wireToDomainExpr, zodFor } from "./routes-builder.js";
import {
  collectReposForWorkflow,
  honoWorkflowStmtTarget,
  renderExprWithParams,
} from "./workflow-builder.js";

// Response-boundary read masking (`mask unless`) for explicit handler routes —
// the `httpCtx` twin of routes-builder's `maskUserBind`/`wireResp`.
function maskBind(masked: boolean, pad: string): string[] {
  return masked
    ? [
        `${pad}const __maskUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User | undefined }).get("currentUser") ?? null;`,
      ]
    : [];
}
function wireRespH(masked: boolean, repoVar: string, varExpr: string): string {
  return masked
    ? `${repoVar}.toWireMasked(${varExpr}, __maskUser)`
    : `${repoVar}.toWire(${varExpr})`;
}

type Handler = CommandHandlerIR | QueryHandlerIR;

// --- Extern handler (bodyless) — scaffold-once user impl file --------------
// An `extern commandHandler`/`extern queryHandler` has NO DSL body: the route
// still wires up identically (metadata + param coercion), but instead of a
// rendered workflow body it calls a scaffold-once, user-owned impl module the
// user fills in.  The impl path/name is DETERMINISTIC and stable forever
// (renames would orphan user code): `src/application/<kebab>-handler-impl.ts`
// exporting `<camelName>Impl`.

/** Kebab basename of a handler impl file (`PlaceOrder` → `place-order`). */
const handlerKebab = (name: string): string => snake(name).replace(/_/g, "-");
/** The exported impl function name (`PlaceOrder` → `placeOrderImpl`). */
const externImplFn = (name: string): string => `${lowerFirst(name)}Impl`;
/** Emitted impl file path (`out.set` key), rooted at the project src dir. */
const externImplFilePath = (name: string): string =>
  `application/${handlerKebab(name)}-handler-impl.ts`;
/** Import specifier from an `http/*-routes.ts` router to the impl module. */
const externImplModule = (name: string): string =>
  `../application/${handlerKebab(name)}-handler-impl`;

/** Path-param zod for a wire-coerced route segment.  Ids resolve by their value
 *  type (guid → uuid string, int/long → coerced integer, string → plain);
 *  scalars mirror the same numeric/textual split.  Matches the `corrVt` switch
 *  in `emitInstanceRoutes` (non-guid-id-http-params.md). */
function pathParamZod(t: TypeIR): string {
  if (t.kind === "id") {
    return t.valueType === "guid"
      ? "z.string().uuid()"
      : t.valueType === "int" || t.valueType === "long"
        ? "z.coerce.number().int()"
        : "z.string()";
  }
  if (t.kind === "primitive") {
    switch (t.name) {
      case "int":
      case "long":
        return "z.coerce.number().int()";
      case "bool":
        // A path segment is a string, so `z.coerce.boolean()` bound
        // `/flag/false` to `true`.  Same four-spelling parse as a query bool.
        return QUERY_BOOL;
      default:
        return "z.string()";
    }
  }
  return "z.string()";
}

/** The aggregate a handler's return resolves to (for the `repo.toWire(...)`
 *  projection) + whether it's a collection.  Normalises a declared `<Agg>Response`
 *  return back to the entity it projects (a scaffolded read declares the response
 *  record; the handler body still returns the domain entity), so both the
 *  hand-written `: Order` and scaffolded `: OrderResponse` forms project alike.
 *  Undefined for an id / scalar / void return, which serialises as-is. */
function returnEntity(
  h: Handler,
  ctx: EnrichedBoundedContextIR,
): { agg: string; isCollection: boolean; respName: string } | undefined {
  const norm = normalizeHandlerReturn(h.returnType, ctx);
  if (!norm) return undefined;
  const info = wireTypeInfo(norm, "response");
  if (info.refKind !== "entity") return undefined;
  const owning =
    ctx.aggregates.find((a) => a.name === info.base) ??
    ctx.aggregates.find((a) => a.parts.some((p) => p.name === info.base));
  return owning
    ? { agg: owning.name, isCollection: info.isCollection, respName: `${info.base}Response` }
    : undefined;
}

/** Emit the `app.openapi(...)` block for a paged-run queryHandler (`queryHandler
 *  H(...): <Agg> paged { let r = Repo.run(<Criterion>(args)); return r }`).  A
 *  paged read is a GET: the handler's own params become QUERY params (path
 *  tokens stay path params) joined by the `page`/`pageSize`/`sort`/`dir`
 *  pagination controls; the body calls the synthesized paged FIND repo method
 *  (`findAllBy<Criterion>`) and returns the envelope with items wire-projected.
 *  The 200 body schema stays `z.unknown()` (the wire object is plain JSON), so
 *  no cross-file `<Agg>Paged` DTO reference / duplicate `.openapi` registration
 *  is introduced. */
function emitPagedRunHandler(
  apiName: string,
  route: RouteIR,
  h: Handler,
  ctx: EnrichedBoundedContextIR,
): string[] {
  const pathNames = new Set([...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
  const method = route.method.toLowerCase();
  // The returned value is a `let`-ref bound to a `Repo.run(<Criterion>)`
  // (synthCriterion) statement — the shape enrich synthesized the paged FIND
  // for.  Locate it to recover the repo/aggregate + the paged find method name
  // (`retrievalName` = `findAllBy<Criterion>`) + the criterion args.
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
  // Path-bound params (`{token}`) stay path params; the rest ride the query
  // string (a paged read is a GET — no body), joined by the pagination controls.
  const pathParams = h.params.filter((p) => pathNames.has(p.name));
  const queryParams = h.params.filter((p) => !pathNames.has(p.name));
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "${method}",`);
  out.push(`    path: "${route.path}",`);
  out.push(`    tags: ["${apiName}"],`);
  out.push(`    operationId: "${lowerFirst(ctx.name)}${h.name}",`);
  const reqParts: string[] = [];
  if (pathParams.length > 0) {
    reqParts.push(
      `params: z.object({ ${pathParams.map((p) => `${p.name}: ${pathParamZod(p.type)}`).join(", ")} })`,
    );
  }
  const queryFields = [
    ...queryParams.map((p) => `${p.name}: ${zodFor(p.type, "query")}`),
    // Declared upper bounds — see the sibling paged-find schema in
    // routes-builder.ts (schemathesis F4).
    `page: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE}).default(${PAGED_DEFAULT_PAGE})`,
    `pageSize: z.coerce.number().int().min(1).max(${PAGED_MAX_PAGE_SIZE}).default(${PAGED_DEFAULT_PAGE_SIZE})`,
    `sort: z.string().default("id")`,
    `dir: z.string().default("asc")`,
  ];
  reqParts.push(`query: z.object({ ${queryFields.join(", ")} })`);
  out.push(`    request: { ${reqParts.join(", ")} },`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: z.unknown() } } },`,
  );
  out.push(
    `      400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(
    `      ${resolveErrorStatus("NotFound", ctx.structuralErrorStatuses)}: { description: ${JSON.stringify(
      problemTitle(resolveErrorStatus("NotFound", ctx.structuralErrorStatuses)),
    )}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (pathParams.length > 0) out.push(`    const params = httpCtx.req.valid("param");`);
  out.push(`    const query = httpCtx.req.valid("query");`);
  const paramExprs = new Map<string, string>();
  for (const p of pathParams) {
    out.push(`    const ${p.name} = ${wireToDomainExpr(`params.${p.name}`, p.type, ctx)};`);
    paramExprs.set(p.name, p.name);
  }
  for (const p of queryParams) {
    out.push(`    const ${p.name} = ${wireToDomainExpr(`query.${p.name}`, p.type, ctx)};`);
    paramExprs.set(p.name, p.name);
  }
  const repoVar = lowerFirst(run.repoName);
  out.push(`    const ${repoVar} = new ${run.aggName}Repository(db, events);`);
  // Criterion args (handler params passed to the criterion) + the pagination
  // controls → the paged FIND method call.
  const critArgs = run.retrievalArgs.map((a) => renderExprWithParams(a, paramExprs, "this"));
  const callArgs = [...critArgs, "query.page", "query.pageSize", "query.sort", "query.dir"].join(
    ", ",
  );
  out.push(`    const result = await ${repoVar}.${run.retrievalName}(${callArgs});`);
  const runMasked = !!ctx.aggregates.find((a) => a.name === run.aggName && aggHasFieldMask(a));
  out.push(...maskBind(runMasked, "    "));
  out.push(
    `    return httpCtx.json({ ...result, items: result.items.map((__e) => ${wireRespH(runMasked, repoVar, "__e")}) }, 200);`,
  );
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Emit one `app.openapi(createRoute({...}), async (httpCtx) => {...})` block
 *  for a route → handler binding.  Returns lines at router-body indent base
 *  (`app.openapi(` at column 0; the file builder wraps them +2). */
function emitRouteHandler(
  apiName: string,
  route: RouteIR,
  h: Handler,
  ctx: EnrichedBoundedContextIR,
): string[] {
  // paged-run queryHandler: `queryHandler H(...): <Agg> paged { let r =
  // Repo.run(<Criterion>(args)); return r }`.  Handled before the generic path
  // (whose `returnEntity` → `wireTypeInfo` can't render a `paged` generic
  // carrier).  Reuses the #1904 paged FIND repo-method (synthesized onto the
  // aggregate's repository by enrich): the route exposes page/pageSize/sort/dir
  // + the handler's own params, calls `repo.findAllBy<Criterion>(...)`, and
  // returns the `{items,page,pageSize,total,totalPages}` envelope with items
  // wire-projected via `repo.toWire`.
  if (!h.extern && h.returnType && pagedReturn(h.returnType)) {
    return emitPagedRunHandler(apiName, route, h, ctx);
  }
  const pathNames = new Set([...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
  const method = route.method.toLowerCase();
  // Classify each handler param: a path-bound id/scalar (name in a `{token}`),
  // a `command`/`query` request RECORD (`cmd`/`query` — the body/query-string
  // deserialises into the payload's DTO; the body reads `cmd.<field>`), or a
  // legacy scalar body param.  A record's fields bind from the SAME request
  // location an equivalent flat param would (path if the field name is a route
  // token, else body), so the wire is unchanged.
  type Slot = { name: string; type: TypeIR; source: "path" | "body" };
  const bodySlots: Slot[] = [];
  const pathSlots: Slot[] = [];
  const addSlot = (name: string, type: TypeIR): void => {
    (pathNames.has(name) ? pathSlots : bodySlots).push({
      name,
      type,
      source: pathNames.has(name) ? "path" : "body",
    });
  };
  // Per-param materialisation: a record param builds an object literal from its
  // field slots; every other param binds one wire-coerced local.
  type Materialised =
    | { kind: "scalar"; name: string }
    | { kind: "record"; name: string; fields: { field: string; type: TypeIR }[] };
  const materialised: Materialised[] = [];
  for (const p of h.params) {
    const rec = requestRecordFor(p.type, ctx);
    if (rec) {
      for (const f of rec.fields) addSlot(f.name, f.type);
      materialised.push({
        kind: "record",
        name: p.name,
        fields: rec.fields.map((f) => ({ field: f.name, type: f.type })),
      });
    } else {
      addSlot(p.name, p.type);
      materialised.push({ kind: "scalar", name: p.name });
    }
  }
  // An extern handler returns iff it declares a returnType (there's no lowered
  // returnValue — the body is bodyless); a DSL-bodied handler returns iff its
  // body ends in a `return` (`returnValue`).
  const hasReturn = h.extern ? !!h.returnType : !!h.returnValue;
  // The aggregate a DSL-bodied handler's entity return wire-projects through
  // (`repo.toWire(...)`); undefined for extern or a non-entity return.
  const ret = h.extern ? undefined : returnEntity(h, ctx);
  // Type the 200 only for a SINGLE aggregate/entity return that wire-projects —
  // the `repo.toWire(...) as z.infer<typeof <Agg>Response>` body then agrees with
  // the schema under strict tsc (the scaffolded aggregate GET route's contract).
  const typedResponseName = hasReturn && ret && !ret.isCollection ? ret.respName : undefined;
  const out: string[] = [];
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "${method}",`);
  out.push(`    path: "${route.path}",`);
  out.push(`    tags: ["${apiName}"],`);
  out.push(`    operationId: "${lowerFirst(ctx.name)}${h.name}",`);
  const reqParts: string[] = [];
  if (pathSlots.length > 0) {
    reqParts.push(
      `params: z.object({ ${pathSlots.map((s) => `${s.name}: ${pathParamZod(s.type)}`).join(", ")} })`,
    );
  }
  if (bodySlots.length > 0) {
    reqParts.push(
      `body: { content: { "application/json": { schema: z.object({ ${bodySlots
        .map((s) => `${s.name}: ${zodFor(s.type)}`)
        .join(", ")} }) } } }`,
    );
  }
  if (reqParts.length > 0) {
    out.push(`    request: { ${reqParts.join(", ")} },`);
  }
  out.push(`    responses: {`);
  if (hasReturn) {
    out.push(
      `      200: { description: "OK", content: { "application/json": { schema: ${typedResponseName ?? "z.unknown()"} } } },`,
    );
  } else {
    out.push(`      204: { description: "No content" },`);
  }
  out.push(
    `      400: { description: "Bad Request", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(
    `      ${resolveErrorStatus("NotFound", ctx.structuralErrorStatuses)}: { description: ${JSON.stringify(
      problemTitle(resolveErrorStatus("NotFound", ctx.structuralErrorStatuses)),
    )}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  // 415 only where there IS a body to refuse — declared under exactly the
  // condition the handler's `requireJsonContentType` guard is emitted.  Last
  // so the declared set stays in ascending status order.
  if (bodySlots.length > 0) {
    out.push(
      `      415: { description: ${JSON.stringify(problemTitle(415))}, content: { "application/problem+json": { schema: ProblemDetails } } },`,
    );
  }
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (pathSlots.length > 0) out.push(`    const params = httpCtx.req.valid("param");`);
  if (bodySlots.length > 0) {
    // A foreign Content-Type SKIPS hono's zod body validator (schemathesis F1).
    out.push(`    requireJsonContentType(httpCtx);`);
    out.push(`    const body = httpCtx.req.valid("json");`);
  }
  // Bind each handler param to a local (path/body scalar → one wire-coerced
  // local; record → an object literal of wire-coerced fields), so every param
  // `ref` / `cmd.<field>` in the body renders against a local in scope.
  const paramExprs = new Map<string, string>();
  const wireSrc = (name: string): string =>
    pathNames.has(name) ? `params.${name}` : `body.${name}`;
  for (const m of materialised) {
    if (m.kind === "scalar") {
      const p = h.params.find((pp) => pp.name === m.name)!;
      out.push(`    const ${m.name} = ${wireToDomainExpr(wireSrc(m.name), p.type, ctx)};`);
    } else {
      const fields = m.fields
        .map((f) => `${f.field}: ${wireToDomainExpr(wireSrc(f.field), f.type, ctx)}`)
        .join(", ");
      out.push(`    const ${m.name} = { ${fields} };`);
    }
    paramExprs.set(m.name, m.name);
  }
  // Extern handler: no DSL body — no repos, no workflow statements, no wire
  // projection.  Delegate to the scaffold-once user impl module (imported by
  // `buildExplicitRoutesFile`), passing the domain-coerced param locals.  The
  // impl owns the return shape, so it serialises as-is.
  if (h.extern) {
    const call = `${externImplFn(h.name)}(${h.params.map((p) => p.name).join(", ")})`;
    if (hasReturn) {
      out.push(`    const result = await ${call};`);
      out.push(`    return httpCtx.json(result as unknown, 200);`);
    } else {
      out.push(`    await ${call};`);
      out.push(`    return httpCtx.body(null, 204);`);
    }
    out.push(`  },`);
    out.push(`);`);
    return out;
  }
  // Repos constructed inline on the request `db` (matches aggregate/workflow
  // routes).  `getById` throws AggregateNotFoundError → 404 via onError, so a
  // load needs no explicit guard.
  const repos = collectReposForWorkflow(h);
  const repoVarByAgg = new Map(repos.map((r) => [r.aggName, lowerFirst(r.repoName)]));
  for (const r of repos) {
    out.push(`    const ${lowerFirst(r.repoName)} = new ${r.aggName}Repository(db, events);`);
  }
  // A handler that returns a domain aggregate projects it to its wire shape via
  // the owning repo's `toWire(...)` (the same projection the read routes
  // use), so the route serialises the contract — not the raw domain entity.
  // Reuse the repo the body already built for that aggregate; construct one when
  // the return aggregate was never loaded (e.g. a freshly created entity).
  let retRepoVar: string | undefined;
  if (ret) {
    retRepoVar = repoVarByAgg.get(ret.agg);
    if (!retRepoVar) {
      retRepoVar = lowerFirst(plural(ret.agg));
      out.push(`    const ${retRepoVar} = new ${ret.agg}Repository(db, events);`);
    }
  }
  // Load → mutate → save body, rendered through the shared Hono workflow stmt
  // target (handlers carry no `this` state, so the default `thisName` is inert).
  const chunks = renderWorkflowStmtChunks(
    h.statements,
    honoWorkflowStmtTarget(ctx, paramExprs, "this"),
    "    ",
  );
  out.push(...chunks.flat());
  for (const save of h.savesAtExit) {
    out.push(`    await ${lowerFirst(save.repoName)}.save(${save.name});`);
  }
  if (hasReturn) {
    const retExpr = renderExprWithParams(h.returnValue!, paramExprs, "this");
    // A domain entity/part return projects to its wire shape via the owning
    // repo's `toWire(...)`; a collection maps each element.  A single-entity
    // return additionally casts to the typed 200's inferred schema (the
    // scaffolded aggregate route's `... as z.infer<typeof <Agg>Response>`
    // pattern) so the value satisfies the declared response under strict tsc.
    // Id / scalar returns serialise as-is.
    const retMasked =
      !!ret &&
      !!retRepoVar &&
      !!ctx.aggregates.find((a) => a.name === ret.agg && aggHasFieldMask(a));
    out.push(...maskBind(retMasked, "    "));
    const payload = ret
      ? ret.isCollection
        ? `${retExpr}.map((__e) => ${wireRespH(retMasked, retRepoVar!, "__e")})`
        : typedResponseName
          ? `${wireRespH(retMasked, retRepoVar!, retExpr)} as z.infer<typeof ${typedResponseName}>`
          : `${wireRespH(retMasked, retRepoVar!, retExpr)}`
      : `${retExpr} as unknown`;
    out.push(`    return httpCtx.json(${payload}, 200);`);
  } else {
    out.push(`    return httpCtx.body(null, 204);`);
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Build the per-api router file (`http/<api>-routes.ts`) for an api whose
 *  `route` list resolves to at least one hosted handler.  Returns `undefined`
 *  when no route resolves (all targets non-hosted / unresolved) so the caller
 *  emits nothing.  Imports are derived by intersection with the emitted body
 *  text (per the generated-code Biome dead-import gate). */
export function buildExplicitRoutesFile(
  apiName: string,
  routes: readonly RouteIR[],
  contexts: readonly EnrichedBoundedContextIR[],
  /** resourceName → sourceType, so a handler body's resource-ops can import
   *  their `<resource>$<verb>` helpers from `../resources/<sourceType>` — the
   *  same map (and the same derivation) the workflow leg gets.  Defaulted so a
   *  caller with no system context stays byte-identical. */
  resourceSourceTypes: Map<string, string> = new Map(),
): string | undefined {
  const byName = new Map(contexts.map((c) => [c.name, c] as const));
  const routeBlocks: string[][] = [];
  // Body params seed the VO/enum wire-schema closure below: every body param
  // whose type resolves to a value object / enum is rendered by `zodFor` as a
  // bare `<Name>Schema` reference, so that schema must be declared in-scope.
  const bodySchemaSeeds: TypeIR[] = [];
  // Extern handlers routed by this api → the scaffold-once impl modules the
  // router imports (`<camelName>Impl` from `../application/<kebab>-handler-impl`).
  const externImplImports = new Map<string, string>();
  // Entity-return response schemas (`<Entity>Response`) → the aggregate routes
  // file that exports them (the same import `http/views.ts` uses), so the typed
  // 200 body resolves in-scope without re-declaring the composite schema.
  const responseImports = new Map<string, string>();
  // Resource-op verb helpers a routed handler body calls: `../resources/<st>`
  // module → the `<resource>$<verb>` names to import from it.  Collected with
  // the DEEP walker (a resource-op nested inside another expression is legal
  // and would otherwise lose its import and fail `tsc`), mirroring the workflow
  // leg's typed-api-helper scan.
  const resourceHelperByModule = new Map<string, Set<string>>();
  /** Typed in-system api helpers (`<resource>$<operationId>`) — one module. */
  const apiHelpers = new Set<string>();
  const collectResourceHelpers = (e: ExprIR): void => {
    if (e.kind !== "call") return;
    if (e.callKind === "remote-api-op" && e.remoteApiOp) {
      apiHelpers.add(`${e.remoteApiOp.resourceName}$${e.remoteApiOp.operationId}`);
      return;
    }
    if (e.callKind !== "resource-op" || !e.resourceOp) return;
    const sourceType = resourceSourceTypes.get(e.resourceOp.resourceName);
    if (!sourceType) return;
    const mod = `../resources/${sourceType}`;
    const set = resourceHelperByModule.get(mod) ?? new Set<string>();
    set.add(`${e.resourceOp.resourceName}$${e.resourceOp.verb}`);
    resourceHelperByModule.set(mod, set);
  };
  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const h = cmd ?? qry;
    if (!h) continue;
    for (const st of h.statements) walkWorkflowStmtExprsDeep(st, collectResourceHelpers);
    if (h.returnValue) walkExprDeep(h.returnValue, collectResourceHelpers);
    const pathNames = new Set([...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
    // Seed the VO/enum wire-schema closure from every body-bound field.  A
    // record param contributes its individual field types (the body deserialises
    // into the record's fields), not the record type itself.
    for (const p of h.params) {
      const rec = requestRecordFor(p.type, ctx);
      if (rec) {
        for (const f of rec.fields) if (!pathNames.has(f.name)) bodySchemaSeeds.push(f.type);
      } else if (!pathNames.has(p.name)) {
        bodySchemaSeeds.push(p.type);
      }
    }
    // A single aggregate/entity return (DSL-bodied, wire-projected) imports its
    // `<Entity>Response` from the aggregate routes file so the typed 200 resolves
    // in-scope.  Extern returns aren't wire-projected → stay `z.unknown()`.  Uses
    // the same `returnEntity` the emission does (it normalises a declared
    // `<Agg>Response` return back to the entity), so the import is emitted iff the
    // typed-200 reference is — a raw `wireTypeInfo` here would miss the scaffolded
    // form (return declared as the response record) and drop the import (TS2304).
    // Skip paged returns exactly as the emission does (they dispatch to
    // `emitPagedRunHandler`, keep a `z.unknown()` 200, and would make
    // `returnEntity`'s `wireTypeInfo` throw on the paged generic carrier).
    if (!h.extern && !(h.returnType && pagedReturn(h.returnType))) {
      const ent = returnEntity(h, ctx);
      if (ent && !ent.isCollection) {
        responseImports.set(ent.respName, `./${lowerFirst(ent.agg)}.routes`);
      }
    }
    if (h.extern) externImplImports.set(externImplFn(h.name), externImplModule(h.name));
    routeBlocks.push(emitRouteHandler(apiName, r, h, ctx));
  }
  if (routeBlocks.length === 0) return undefined;

  // Wire-schema declarations for every VO / enum a body param references
  // (transitively, through a VO's own fields).  Same machinery the aggregate
  // (`routes-builder`) and workflow (`workflow-builder`) routers use — without
  // these, the request `z.object({ amount: MoneySchema, … })` names an
  // undeclared symbol and the generated project fails `tsc` (TS2304).  Enums
  // travel as strings (`z.enum`); value objects emit through `emitWireSchema`.
  const allVOs = contexts.flatMap((c) => c.valueObjects);
  const allEnums = contexts.flatMap((c) => c.enums);
  const reachable = collectReachableTypes(bodySchemaSeeds, allVOs);
  const dedupeByName = <T extends { name: string }>(items: T[]): T[] => {
    const seen = new Map<string, T>();
    for (const it of items) if (!seen.has(it.name)) seen.set(it.name, it);
    return [...seen.values()];
  };
  const usedEnums: EnumIR[] = dedupeByName(allEnums.filter((e) => reachable.enums.has(e.name)));
  const usedVOs: ValueObjectIR[] = dedupeByName(
    allVOs.filter((v) => reachable.valueObjects.has(v.name)),
  );
  const schemaDecls: string[] = [];
  for (const e of usedEnums) {
    const values = e.values.map((v) => `"${v}"`).join(", ");
    schemaDecls.push(`const ${e.name}Schema = z.enum([${values}]).openapi("${e.name}");`);
  }
  for (const vo of usedVOs) {
    schemaDecls.push(
      ...emitWireSchema(
        `const ${vo.name}Schema`,
        `${vo.name}`,
        vo.fields.map((f) => ({ name: f.name, base: zodFor(f.type) })),
        vo.invariants,
        new Set(vo.fields.map((f) => f.name)),
      ),
    );
  }

  const fn = `${lowerFirst(apiName)}Routes`;
  const body: string[] = [];
  // Signature — the route bodies reference `db`/`events`; underscore either if
  // the emitted body never does (keeps the generated-code lint clean).
  const routesText = routeBlocks.flat().join("\n");
  const usesDb = /\bdb\b/.test(routesText);
  const usesEvents = /\bevents\b/.test(routesText);
  body.push(`export function ${fn}(`);
  body.push(`  ${usesDb ? "db" : "_db"}: NodePgDatabase<typeof schema>,`);
  body.push(`  ${usesEvents ? "events" : "_events"}: DomainEventDispatcher,`);
  body.push(`): OpenAPIHono {`);
  body.push(`  const app = newApp();`);
  body.push("");
  for (const block of routeBlocks) {
    body.push(...block.map((l) => `  ${l}`));
    body.push("");
  }
  // RFC 7807 responder — identical to the workflow router's onError.
  body.push(`  app.onError((err, c) => {`);
  body.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // M-T5.20 — the denial ladder resolves through the api's `httpStatus` map,
  // exactly like the aggregate + workflow routers. This file serves ROUTES from
  // possibly several contexts; every context carries the SAME app-wide fold, so
  // the first one is representative. Defaults 422 / 403 ⇒ byte-identical.
  const structuralMap = contexts[0]?.structuralErrorStatuses;
  const exDomainStatus = resolveErrorStatus("DomainError", structuralMap);
  const exForbiddenStatus = resolveErrorStatus("Forbidden", structuralMap);
  // ── the CONFLICT rungs (M-T6.28) ──────────────────────────────────────
  // This router is a WRITE path (`POST /api/place` — an extern `commandHandler`
  // that loads an aggregate, invokes an operation and `save`s it), and its
  // ladder could not express 409 at all: the `problem` signature was typed
  // `400 | 403 | 404 | 422 | 500` and the file imported neither
  // `DisallowedError` nor `ConcurrencyError`.  So a save that lost an optimistic
  // -lock race, or tripped a `unique (…)` index, answered `500 / "internal"`
  // here while the SAME concept on `/api/<agg>/…` answered 409 — one app, one
  // wire concept, two answers.
  //
  // Gated exactly as the aggregate router gates them, over every context this
  // file serves: `ConcurrencyError` is only emitted into `domain/errors.ts` for
  // a versioned / event-sourced aggregate, and only a table with a declared
  // `unique` key can raise SQLSTATE 23505 — so a project with neither stays
  // byte-identical.
  const exAggregates = contexts.flatMap((c) => c.aggregates);
  const exNeedsConcurrency = aggregatesNeedConcurrency(exAggregates);
  const exHasUniqueKeys = aggregatesHaveUniqueKeys(exAggregates);
  const exDisallowedStatus = resolveErrorStatus("Disallowed", structuralMap);
  const exUniquenessStatus = resolveErrorStatus("UniquenessConflict", structuralMap);
  const exConcurrencyStatus = resolveErrorStatus("ConcurrencyConflict", structuralMap);
  // The domain not-found rung — an extern/explicit handler that loads by id
  // raises the same `AggregateNotFoundError` the aggregate routes do, so it
  // must answer the same `httpStatus`-resolved status.
  const exNotFoundStatus = resolveErrorStatus("NotFound", structuralMap);
  const exStatuses = new Set<number>([
    400,
    exForbiddenStatus,
    exNotFoundStatus,
    422,
    exDomainStatus,
    500,
    exDisallowedStatus,
  ]);
  if (exHasUniqueKeys) exStatuses.add(exUniquenessStatus);
  if (exNeedsConcurrency) exStatuses.add(exConcurrencyStatus);
  const exProblemUnion = [...exStatuses].sort((a, b) => a - b).join(" | ");
  body.push(
    `    const problem = (status: ${exProblemUnion}, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  body.push(
    `    if (err instanceof ForbiddenError) return problem(${exForbiddenStatus}, ${JSON.stringify(problemTitle(exForbiddenStatus))}, err.message);`,
  );
  body.push(
    // The state-gate rung.  Ordered before `DomainError` exactly as in the
    // aggregate router.  Reachability: the `when` gate is emitted at the
    // DOMAIN-METHOD entry (`typescript/emit/aggregate.ts`) as well as at the
    // route, so an operation invoked from a handler here DOES evaluate it and
    // this arm answers that refusal — plus any `DisallowedError` a user-authored
    // extern impl raises.  (Before M-T6.38 the gate was route-only, so a write
    // driven from here landed unrefused.)
    `    if (err instanceof DisallowedError) return problem(${exDisallowedStatus}, "Disallowed", err.message);`,
  );
  body.push(
    `    if (err instanceof DomainError) return problem(${exDomainStatus}, ${JSON.stringify(problemTitle(exDomainStatus))}, err.message);`,
  );
  body.push(
    `    if (err instanceof AggregateNotFoundError) return problem(${exNotFoundStatus}, ${JSON.stringify(problemTitle(exNotFoundStatus))}, err.message);`,
  );
  if (exHasUniqueKeys) {
    body.push(
      // PG unique_violation — drizzle wraps the driver error, so the SQLSTATE
      // rides `err.cause` under v5 and `err` under older drizzle; read both, as
      // the aggregate router does.
      `    if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")) return problem(${exUniquenessStatus}, "Conflict", "A record with these values already exists.");`,
    );
  }
  if (exNeedsConcurrency) {
    body.push(
      `    if (err instanceof ConcurrencyError) return problem(${exConcurrencyStatus}, "Conflict", err.message);`,
    );
  }
  body.push(
    // RS-28: the extern arm sanitizes like every other 500.  `err.message`
    // interpolates the INNER exception the user handler threw — driver text,
    // URLs, connection strings — into a public body.  op + aggregate already
    // reach the operator via the `extern_handler_threw` catalog event.
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", "internal"); }`,
  );
  body.push(
    // FRAMEWORK fault, not a domain one — hono raises `HTTPException` for the
    // faults it detects itself (a malformed JSON body is the common one, at
    // 400).  Without this arm it falls past every domain check into the
    // generic 500 below, reporting a CLIENT fault as a server fault.
    `    if (err instanceof HTTPException) { ${renderHonoLogCall("clientError", "error: err.message, status: err.status")} return c.body(frameworkProblemBody(err.status, err.message, c.req.path), err.status, { "content-type": "application/problem+json", "x-request-id": trace_id }); }`,
  );
  body.push(`    console.error(err);`);
  body.push(`    return problem(500, "Internal Server Error", "internal");`);
  body.push(`  });`);
  body.push("");
  body.push(`  return app;`);
  body.push(`}`);

  // Derive imports from what the body actually references (string contents
  // stripped so `.openapi("Name")`-style literals don't count as refs).
  const rawBodyStr = body.join("\n");
  const bodyStr = rawBodyStr
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const hasRef = (name: string): boolean => new RegExp(`\\b${name}\\b`).test(bodyStr);

  const allAggNames = contexts.flatMap((c) => c.aggregates.map((a) => a.name));
  const aggsReferenced = allAggNames.filter((n) =>
    new RegExp(`\\bnew\\s+${n}\\(|\\b${n}\\.\\w`).test(bodyStr),
  );
  const reposReferenced = allAggNames.filter((n) =>
    new RegExp(`\\bnew\\s+${n}Repository\\(`).test(bodyStr),
  );
  const voEnumNames = contexts.flatMap((c) => [
    ...c.valueObjects.map((v) => v.name),
    ...c.enums.map((e) => e.name),
  ]);
  const voEnumReferenced = [...new Set(voEnumNames)].filter(hasRef);
  const errorClasses = [
    "DomainError",
    "AggregateNotFoundError",
    "DisallowedError",
    "ForbiddenError",
    "ExternHandlerError",
    "ConcurrencyError",
  ].filter(hasRef);

  const imports: string[] = [];
  imports.push("// Auto-generated.  Do not edit by hand.");
  imports.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  // A money-typed VO field renders (via `zodFor`) as `moneySchema` (the shared
  // Decimal parse chain), which lives in the helpers module, not this file.
  if (schemaDecls.some((l) => /\bmoneySchema\b/.test(l))) {
    imports.push(`import { moneySchema } from "../lib/schemas";`);
  }
  const problemNamed = [
    /\bframeworkProblemBody\b/.test(bodyStr) ? "frameworkProblemBody" : null,
    /\bProblemDetails\b/.test(bodyStr) ? "ProblemDetails" : null,
    "newApp",
    /\brequireJsonContentType\(/.test(bodyStr) ? "requireJsonContentType" : null,
  ].filter((n): n is string => n !== null);
  imports.push(`import { ${problemNamed.join(", ")} } from "./problem-details";`);
  if (/\bHTTPException\b/.test(bodyStr))
    imports.push(`import { HTTPException } from "hono/http-exception";`);
  if (/\bIds\.\w/.test(bodyStr)) imports.push(`import * as Ids from "../domain/ids";`);
  if (errorClasses.length > 0) {
    imports.push(`import { ${errorClasses.join(", ")} } from "../domain/errors";`);
  }
  imports.push(`import type { DomainEventDispatcher } from "../domain/events";`);
  imports.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  imports.push(`import type * as schema from "../db/schema";`);
  // Scaffold-once extern impl modules (one per extern handler routed here).
  for (const [fn, module] of [...externImplImports].sort()) {
    imports.push(`import { ${fn} } from "${module}";`);
  }
  // Typed-200 response schemas, imported from their aggregate routes file (the
  // `http/views.ts` pattern).  Guarded by an actual reference so the generated
  // dead-import gate stays clean.
  for (const [name, module] of [...responseImports].sort()) {
    if (hasRef(name)) imports.push(`import { ${name} } from "${module}";`);
  }
  for (const aggName of [...new Set(aggsReferenced)]) {
    imports.push(`import { ${aggName} } from "../domain/${lowerFirst(aggName)}";`);
  }
  for (const aggName of [...new Set(reposReferenced)]) {
    imports.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
  }
  if (voEnumReferenced.length > 0) {
    imports.push(`import { ${voEnumReferenced.join(", ")} } from "../domain/value-objects";`);
  }
  // Resource-op verb helpers (the handler-leg twin of workflow-builder's
  // block).  Grouped by client module, one named import per (resource, verb)
  // the routed handler bodies actually call — a routes file whose handlers do
  // no resource I/O emits nothing here and stays byte-identical.
  for (const [mod, helpers] of [...resourceHelperByModule].sort(([a], [b]) => (a < b ? -1 : 1))) {
    imports.push(`import { ${[...helpers].sort().join(", ")} } from "${mod}";`);
  }
  if (apiHelpers.size > 0) {
    imports.push(
      `import { ${[...apiHelpers].sort().join(", ")} } from "../resources/api-clients";`,
    );
  }

  const schemaSection = schemaDecls.length > 0 ? [...schemaDecls, ""] : [];
  return `${[...imports, "", ...schemaSection, ...body].join("\n")}\n`;
}

/** Render one extern handler's scaffold-once impl module.  The generated route
 *  imports `<camelName>Impl` and calls it; this file is the user's — Loom
 *  writes it once (the `loom:scaffold-once` marker on line 1 tells the CLI
 *  writer to PRESERVE it on regen), and the default body throws loudly so a
 *  forgotten implementation surfaces as a 500 naming the file, not a silent
 *  no-op.  Params are domain-typed (the route coerces wire→domain before the
 *  call); the return type is the user's contract. */
function renderExternHandlerImpl(h: Handler, ctx: EnrichedBoundedContextIR): string {
  const fn = externImplFn(h.name);
  const params = h.params.map((p) => `${p.name}: ${renderTsType(p.type)}`).join(", ");
  const ret = h.returnType ? renderTsType(h.returnType) : "void";
  const sig = `export async function ${fn}(${params}): Promise<${ret}>`;
  const kind = (ctx.queryHandlers ?? []).includes(h as QueryHandlerIR)
    ? "queryHandler"
    : "commandHandler";
  const throwMsg = `extern ${kind} '${h.name}' is not implemented — fill in src/${externImplFilePath(h.name)}`;
  // Import scan: blank string literals, then look for whole-word references so
  // the header only imports the domain types the signature actually names.
  // `renderTsType` namespaces ids (`Ids.<Agg>Id`), leaves entities / value
  // objects / enums bare (imported from their own modules).
  const scan = `${params} ${ret}`.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const refersTo = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(scan);
  const aggRefs = ctx.aggregates
    .map((a) => a.name)
    .filter(refersTo)
    .sort();
  const voEnumNames = [
    ...new Set([...ctx.valueObjects.map((v) => v.name), ...ctx.enums.map((e) => e.name)]),
  ]
    .filter(refersTo)
    .sort();
  const imports: string[] = [`import { ExternHandlerError } from "../domain/errors";`];
  if (/\bIds\.\w/.test(scan)) imports.push(`import * as Ids from "../domain/ids";`);
  for (const agg of aggRefs) {
    imports.push(`import { ${agg} } from "../domain/${lowerFirst(agg)}";`);
  }
  if (voEnumNames.length > 0) {
    imports.push(`import { ${voEnumNames.join(", ")} } from "../domain/value-objects";`);
  }
  return `// ${SCAFFOLD_ONCE_MARKER} — this file is yours.  Loom scaffolds it on the first
// \`generate\` and NEVER overwrites it again, so your implementation survives
// every regenerate.  Replace the \`throw\` with the extern handler's real logic
// (the one external-service call this handler wraps).
${imports.join("\n")}

${sig} {
  throw new ExternHandlerError(
    ${JSON.stringify(h.name)},
    ${JSON.stringify(ctx.name)},
    new Error(${JSON.stringify(throwMsg)}),
  );
}
`;
}

/** Emit the scaffold-once impl module for every extern `commandHandler` /
 *  `queryHandler` in a context (`src/application/<kebab>-handler-impl.ts`).  A
 *  no-op for a context with no extern handler — byte-identical output. */
export function emitExternHandlerImpls(
  ctx: EnrichedBoundedContextIR,
  out: Map<string, string>,
): void {
  for (const h of [...(ctx.commandHandlers ?? []), ...(ctx.queryHandlers ?? [])]) {
    if (!h.extern) continue;
    out.set(externImplFilePath(h.name), renderExternHandlerImpl(h, ctx));
  }
}
