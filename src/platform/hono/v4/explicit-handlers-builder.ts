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
import {
  PAGED_DEFAULT_PAGE,
  PAGED_DEFAULT_PAGE_SIZE,
  pagedReturn,
} from "../../../ir/stdlib/generics.js";
import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  EnumIR,
  QueryHandlerIR,
  RouteIR,
  TypeIR,
  ValueObjectIR,
  WorkflowStmtIR,
} from "../../../ir/types/loom-ir.js";
import { wireTypeInfo } from "../../../ir/types/wire-types.js";
import { normalizeHandlerReturn, requestRecordFor } from "../../../ir/util/handler-contracts.js";
import { collectReachableTypes } from "../../../ir/util/reachable-types.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { SCAFFOLD_ONCE_MARKER } from "../../../util/scaffold-once.js";
import { emitWireSchema, wireToDomainExpr, zodFor } from "./routes-builder.js";
import {
  collectReposForWorkflow,
  honoWorkflowStmtTarget,
  renderExprWithParams,
} from "./workflow-builder.js";

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
        return "z.coerce.boolean()";
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
    `page: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE})`,
    `pageSize: z.coerce.number().int().min(1).default(${PAGED_DEFAULT_PAGE_SIZE})`,
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
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
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
  out.push(
    `    return httpCtx.json({ ...result, items: result.items.map((__e) => ${repoVar}.toWire(__e)) }, 200);`,
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
    `      404: { description: "Not Found", content: { "application/problem+json": { schema: ProblemDetails } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (pathSlots.length > 0) out.push(`    const params = httpCtx.req.valid("param");`);
  if (bodySlots.length > 0) out.push(`    const body = httpCtx.req.valid("json");`);
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
    const payload = ret
      ? ret.isCollection
        ? `${retExpr}.map((__e) => ${retRepoVar}.toWire(__e))`
        : typedResponseName
          ? `${retRepoVar}.toWire(${retExpr}) as z.infer<typeof ${typedResponseName}>`
          : `${retRepoVar}.toWire(${retExpr})`
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
  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const h = cmd ?? qry;
    if (!h) continue;
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
    // in-scope.  Extern returns aren't wire-projected → stay `z.unknown()`.
    if (h.returnType && !h.extern) {
      const info = wireTypeInfo(h.returnType, "response");
      if (info.refKind === "entity" && !info.isCollection) {
        const owning =
          ctx.aggregates.find((a) => a.name === info.base) ??
          ctx.aggregates.find((a) => a.parts.some((p) => p.name === info.base));
        if (owning) {
          responseImports.set(`${info.base}Response`, `./${lowerFirst(owning.name)}.routes`);
        }
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
  body.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  body.push(
    `    if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);`,
  );
  body.push(`    if (err instanceof DomainError) return problem(400, "Bad Request", err.message);`);
  body.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  body.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", err.message); }`,
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
    "ForbiddenError",
    "ExternHandlerError",
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
    /\bProblemDetails\b/.test(bodyStr) ? "ProblemDetails" : null,
    "newApp",
  ].filter((n): n is string => n !== null);
  imports.push(`import { ${problemNamed.join(", ")} } from "./problem-details";`);
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
