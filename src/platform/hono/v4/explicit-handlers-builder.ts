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
// v1 scope (matches .NET A1): handler params are ids / scalars.  A param whose
// name appears as `{name}` in the route path binds from the path (coerced from
// its wire type); every other param binds from the JSON body.
//
// Aggregate-return projection (C2, the Hono sibling of the .NET C1 in #1830): a
// handler that returns a domain aggregate/entity projects it to its wire shape
// via the owning repo's `toWire(...)` — reusing the repo the body already built
// for that aggregate (or constructing one when the return aggregate was never
// loaded).  Id / scalar returns serialise as-is (`<expr> as unknown`).  The 200
// body schema stays `z.unknown()` (the wire object is plain JSON); tightening it
// to `<Agg>Response` rides with the contract-scaffold layer.
// ---------------------------------------------------------------------------

import { renderWorkflowStmtChunks } from "../../../generator/_workflow/stmt-target.js";
import type {
  CommandHandlerIR,
  EnrichedBoundedContextIR,
  EnumIR,
  QueryHandlerIR,
  RouteIR,
  TypeIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import { wireTypeInfo } from "../../../ir/types/wire-types.js";
import { collectReachableTypes } from "../../../ir/util/reachable-types.js";
import { lowerFirst, plural } from "../../../util/naming.js";
import { emitWireSchema, wireToDomainExpr, zodFor } from "./routes-builder.js";
import {
  collectReposForWorkflow,
  honoWorkflowStmtTarget,
  renderExprWithParams,
} from "./workflow-builder.js";

type Handler = CommandHandlerIR | QueryHandlerIR;

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

/** The aggregate a handler's return type resolves to, when it returns an
 *  entity (aggregate or containment part) — the projection target for the
 *  `repo.toWire(...)` wrap.  Undefined for an id / scalar / void return, which
 *  serialise as-is. */
function returnEntityAgg(h: Handler, ctx: EnrichedBoundedContextIR): string | undefined {
  if (!h.returnType) return undefined;
  const info = wireTypeInfo(h.returnType, "response");
  if (info.refKind !== "entity") return undefined;
  const owning =
    ctx.aggregates.find((a) => a.name === info.base) ??
    ctx.aggregates.find((a) => a.parts.some((p) => p.name === info.base));
  return owning?.name;
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
  const pathNames = new Set([...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
  const pathParams = h.params.filter((p) => pathNames.has(p.name));
  const bodyParams = h.params.filter((p) => !pathNames.has(p.name));
  const method = route.method.toLowerCase();
  const hasReturn = !!h.returnValue;
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
  if (bodyParams.length > 0) {
    reqParts.push(
      `body: { content: { "application/json": { schema: z.object({ ${bodyParams
        .map((p) => `${p.name}: ${zodFor(p.type)}`)
        .join(", ")} }) } } }`,
    );
  }
  if (reqParts.length > 0) {
    out.push(`    request: { ${reqParts.join(", ")} },`);
  }
  out.push(`    responses: {`);
  if (hasReturn) {
    out.push(
      `      200: { description: "OK", content: { "application/json": { schema: z.unknown() } } },`,
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
  if (pathParams.length > 0) out.push(`    const params = httpCtx.req.valid("param");`);
  if (bodyParams.length > 0) out.push(`    const body = httpCtx.req.valid("json");`);
  // Bind each handler param to a wire-coerced local up front (path segment or
  // body field), so every param `ref` in the body renders as its bare name.
  const paramExprs = new Map<string, string>();
  for (const p of h.params) {
    const source = pathNames.has(p.name) ? `params.${p.name}` : `body.${p.name}`;
    paramExprs.set(p.name, wireToDomainExpr(source, p.type, ctx));
  }
  for (const p of h.params) {
    out.push(`    const ${p.name} = ${paramExprs.get(p.name)};`);
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
  // the owning repo's `toWire(...)` (the same projection the read/view routes
  // use), so the route serialises the contract — not the raw domain entity.
  // Reuse the repo the body already built for that aggregate; construct one when
  // the return aggregate was never loaded (e.g. a freshly created entity).
  const retAgg = returnEntityAgg(h, ctx);
  let retRepoVar: string | undefined;
  if (retAgg) {
    retRepoVar = repoVarByAgg.get(retAgg);
    if (!retRepoVar) {
      retRepoVar = lowerFirst(plural(retAgg));
      out.push(`    const ${retRepoVar} = new ${retAgg}Repository(db, events);`);
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
    const payload = retRepoVar ? `${retRepoVar}.toWire(${retExpr})` : `${retExpr} as unknown`;
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
  for (const r of routes) {
    const ctx = byName.get(r.target.context);
    if (!ctx) continue;
    const cmd = (ctx.commandHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const qry = (ctx.queryHandlers ?? []).find((hd) => hd.name === r.target.handler);
    const h = cmd ?? qry;
    if (!h) continue;
    const pathNames = new Set([...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));
    for (const p of h.params) if (!pathNames.has(p.name)) bodySchemaSeeds.push(p.type);
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
