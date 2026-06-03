import { renderTsExpr } from "../../../generator/typescript/render-expr.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ExprIR,
  TypeIR,
  ViewIR,
} from "../../../ir/types/loom-ir.js";
import { viewUsesCurrentUser } from "../../../ir/types/loom-ir.js";
import { camelId, opView } from "../../../ir/util/openapi-ids.js";
import { lowerFirst, plural, snake, upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono view routes emission.
//
// For each `view` declared in the context, emit a `GET /<snake>`
// route whose body delegates to the source aggregate's repository
// and projects results to either:
//
//   - the aggregate's existing wire shape via `repo.toWire`
//     (shorthand form `view X = Y where ...`), or
//   - a custom record shape declared in the view's full-form body
//     `view X { fields ... bind ... }`.
//
// One file per context — `http/views.ts` — mounted under `/views`
// in `http/index.ts`.  Matches the workflow / aggregate route
// pattern: typed Zod schemas, OpenAPI annotations, on-error filter.
// ---------------------------------------------------------------------------

export function buildViewsRoutesFile(
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string {
  if (ctx.views.length === 0) return "";
  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  lines.push(`import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";`);
  lines.push(`import { newApp } from "./problem-details";`);
  lines.push(
    `import { DomainError, AggregateNotFoundError, ForbiddenError, ExternHandlerError } from "../domain/errors";`,
  );
  lines.push(`import { type DomainEventDispatcher } from "../domain/events";`);
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  lines.push(`import type * as schema from "../db/schema";`);
  // Source aggregates + repo imports per view, plus any foreign
  // aggregates referenced via `X id` follow auxiliaries.
  const aggsTouched = new Set<string>();
  for (const v of ctx.views) {
    aggsTouched.add(v.aggregateName);
    if (v.output) {
      for (const aux of v.output.auxiliaries) aggsTouched.add(aux.aggName);
    }
  }
  // Source aggregates need the response schema (for shorthand-view
  // routes); foreign aggregates only referenced by follows don't,
  // but importing them is harmless under strict tsc since the file
  // uses them in projection paths.  Track which aggregates are
  // sources to avoid emitting Response imports for follow-only
  // aggregates that may not have aggregates routes if they have no
  // operations / finds — defensive.
  const sourceAggs = new Set(ctx.views.map((v) => v.aggregateName));
  for (const aggName of aggsTouched) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${lowerFirst(aggName)}-repository";`,
    );
    if (sourceAggs.has(aggName)) {
      lines.push(
        `import { ${aggName}Response, ${aggName}ListResponse } from "./${lowerFirst(aggName)}.routes";`,
      );
    }
  }
  // Value object + enum imports — full-form views may bind to enum
  // values (`status`) or value-object fields.
  const vos = ctx.valueObjects.map((v) => v.name);
  const enums = ctx.enums.map((e) => e.name);
  if (vos.length + enums.length > 0) {
    lines.push(`import { ${[...vos, ...enums].join(", ")} } from "../domain/value-objects";`);
  }
  lines.push("");

  // Per-full-form-view response Zod schema.  Shorthand views reuse
  // the aggregate's `<Agg>ListResponse` import.
  const enumValues = new Map(ctx.enums.map((e) => [e.name, e.values] as const));
  for (const view of ctx.views) {
    if (!view.output) continue;
    lines.push(`const ${upperFirst(view.name)}Row = z.object({`);
    for (const f of view.output.fields) {
      lines.push(`  ${f.name}: ${zodForRow(f.type, enumValues)},`);
    }
    lines.push(`}).openapi("${upperFirst(view.name)}Row");`);
    lines.push(
      `const ${upperFirst(view.name)}Response = z.array(${upperFirst(view.name)}Row).openapi("${upperFirst(view.name)}Response");`,
    );
  }
  if (ctx.views.some((v) => v.output)) lines.push("");

  lines.push(`export function viewsRoutes(`);
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  events: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  // `newApp()` from `./problem-details` pre-wires the validation hook
  // that maps Zod parse failures (query/path params on view endpoints) to
  // 422 ProblemDetails with `errors[]`.
  lines.push(`  const app = newApp();`);
  lines.push("");

  for (const view of ctx.views) {
    lines.push(...emitViewRoute(view, ctx, aggsByName).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
  );
  // RFC 7807 responder — application/problem+json + x-request-id header.
  lines.push(
    `    const problem = (status: 400 | 403 | 404 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
  );
  lines.push(
    `    if (err instanceof ForbiddenError) return problem(403, "Forbidden", err.message);`,
  );
  lines.push(
    `    if (err instanceof DomainError) return problem(400, "Bad Request", err.message);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return problem(404, "Not Found", err.message);`,
  );
  lines.push(
    `    if (err instanceof ExternHandlerError) { console.error(err); return problem(500, "Internal Server Error", err.message); }`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return problem(500, "Internal Server Error", "internal");`);
  lines.push(`  });`);
  lines.push("");
  lines.push(`  return app;`);
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

function emitViewRoute(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggsByName: Map<string, AggregateIR>,
): string[] {
  void ctx;
  void aggsByName;
  const out: string[] = [];
  const aggSlug = snake(plural(view.aggregateName));
  const responseSchema = view.output
    ? `${upperFirst(view.name)}Response`
    : `${view.aggregateName}ListResponse`;
  // Views whose filter / binds reference currentUser
  // thread the request's user through to the repository's
  // synthesised find method.  The auth middleware stashed it on the
  // Hono context earlier in the pipeline.
  const usesUser = viewUsesCurrentUser(view);
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${aggSlug}"],`);
  out.push(`    operationId: "${camelId(opView(view.name))}",`);
  out.push(`    responses: {`);
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${responseSchema} } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  if (usesUser) {
    out.push(
      `    const currentUser = (httpCtx as unknown as { get(k: "currentUser"): import("../auth/user-types").User }).get("currentUser");`,
    );
  }
  out.push(`    const repo = new ${view.aggregateName}Repository(db, events);`);
  const repoCallArgs = usesUser ? "currentUser" : "";
  out.push(`    const rows = await repo.${lowerFirst(view.name)}(${repoCallArgs});`);
  if (view.output) {
    // Bulk-load every foreign aggregate referenced by `X id`
    // follows in the bind expressions.  Auxiliaries arrive in
    // dependency order (shortest path first); each one's id source
    // is either the source rows (length-1 paths) or the map of a
    // shorter prefix path (length-2+).  Lookup chain in the
    // projection mirrors the same path.
    const pathToMap = new Map<string, { mapVar: string; aggName: string }>();
    for (const aux of view.output.auxiliaries) {
      const repoVar = `${lowerFirst(aux.aggName)}Repo`;
      const mapVar = aux.mapVar;
      out.push(`    const ${repoVar} = new ${aux.aggName}Repository(db, events);`);
      const idsSource = idsSourceForAux(aux, pathToMap);
      out.push(
        `    const ${mapVar} = new Map((await ${repoVar}.findManyByIds(${idsSource})).map((a) => [a.id as string, a]));`,
      );
      pathToMap.set(aux.path.join("."), { mapVar, aggName: aux.aggName });
    }
    const projectedFields = view.output.binds
      .map((b) => `      ${b.name}: ${renderBindWithFollows(b.expr, "r", pathToMap)}`)
      .join(",\n");
    out.push(`    const projected = rows.map((r) => ({\n${projectedFields},\n    }));`);
    out.push(
      `    return httpCtx.json(projected as z.infer<typeof ${upperFirst(view.name)}Response>, 200);`,
    );
  } else {
    out.push(
      `    return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof ${view.aggregateName}Response>[], 200);`,
    );
  }
  out.push(`  },`);
  out.push(`);`);
  return out;
}

/** Pick the id-source expression for an auxiliary's bulk load.
 *  Length-1 paths source from the row var (`rows.map(r => r.<f>)`);
 *  length-2+ paths source from the prior map (the auxiliary whose
 *  path is the current path's prefix). */
function idsSourceForAux(
  aux: { path: string[]; aggName: string; mapVar: string },
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (aux.path.length === 1) {
    return `rows.map((r) => r.${aux.path[0]!})`;
  }
  const prevPath = aux.path.slice(0, -1).join(".");
  const prev = pathToMap.get(prevPath);
  if (!prev) return `[]`;
  const finalField = aux.path[aux.path.length - 1]!;
  return `[...${prev.mapVar}.values()].map((a) => a.${finalField})`;
}

/** Render a view bind expression with chained `X id` follow
 *  rewriting.  At each `member` whose receiverType is `X id`,
 *  the access becomes `<map>.get(<receiverRendered> as string)!.<member>`
 *  where `<receiverRendered>` is recursively the same walker.
 *  Falls back to standard `renderTsExpr` for non-follow shapes. */
function renderBindWithFollows(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      const map = pathToMap.get(key);
      if (map) {
        const receiverRendered = renderIdReceiver(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}.get(${receiverRendered} as string)!.${expr.member}`;
      }
    }
  }
  return renderTsExpr(expr, { thisName });
}

/** Render an Id-typed expression rooted in a `ref` (single hop) or
 *  a chain of Id-typed member accesses (multi-hop).  For multi-hop,
 *  each intermediate hop uses its corresponding map's `.get(...)!`. */
function renderIdReceiver(
  expr: ExprIR,
  thisName: string,
  pathToMap: Map<string, { mapVar: string; aggName: string }>,
): string {
  if (expr.kind === "ref") {
    return `${thisName}.${expr.name}`;
  }
  if (expr.kind === "member" && expr.receiverType.kind === "id") {
    const path = idFollowPath(expr.receiver);
    if (path) {
      const key = path.join(".");
      const map = pathToMap.get(key);
      if (map) {
        const inner = renderIdReceiver(expr.receiver, thisName, pathToMap);
        return `${map.mapVar}.get(${inner} as string)!.${expr.member}`;
      }
    }
  }
  return renderTsExpr(expr, { thisName });
}

/** Local copy of the lowering's `idFollowPath` for emission-time
 *  path checks.  Kept small and self-contained rather than sharing
 *  with the lowering helper, since the emission-time call site
 *  doesn't need the full lowering env. */
function idFollowPath(e: ExprIR): string[] | undefined {
  if (e.kind === "ref" && e.type?.kind === "id") return [e.name];
  if (e.kind === "member" && e.receiverType.kind === "id") {
    const inner = idFollowPath(e.receiver);
    if (!inner) return undefined;
    return [...inner, e.member];
  }
  return undefined;
}

/** Zod schema for a view-output field's TS type.  Decimals stay as
 *  `z.number()`, ids emit as `z.string()`, enum values are emitted
 *  inline as a string-literal union pulled from `enumValues`. */
function zodForRow(t: TypeIR, enumValues: Map<string, string[]>): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "z.number().int()";
        case "decimal":
          return "z.number()";
        case "money":
          return "z.string()";
        case "string":
        case "guid":
          return "z.string()";
        case "bool":
          return "z.boolean()";
        case "datetime":
          return "z.string()";
        case "json":
          return "z.unknown()";
      }
    /* eslint-disable-next-line no-fallthrough */
    case "id":
      return "z.string()";
    case "enum": {
      const values = enumValues.get(t.name) ?? [];
      const lits = values.map((v) => `"${v}"`).join(", ");
      return values.length > 0 ? `z.enum([${lits}])` : "z.string()";
    }
    case "valueobject":
      return "z.unknown()";
    case "entity":
      return "z.unknown()";
    case "array":
      return `z.array(${zodForRow(t.element, enumValues)})`;
    case "optional":
      return `${zodForRow(t.inner, enumValues)}.nullish()`;
    case "slot":
      throw new Error("zodForRow: 'slot' type is UI-only and should not reach a view-row schema.");
    case "genericInstance":
      throw new Error(
        `zodForRow: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
  }
}
