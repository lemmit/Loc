import type {
  AggregateIR,
  BoundedContextIR,
  ViewIR,
} from "../../ir/loom-ir.js";
import { camel, plural, snake } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Hono view routes emission.
//
// For each `view` declared in the context, emit a `GET /<snake>`
// route whose body delegates to the source aggregate's repository
// (extended in `repository-builder.ts` with one parameterless
// method per matching view) and projects results to the
// aggregate's existing wire shape via `repo.toWire`.
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
  lines.push(
    `import { DomainError, AggregateNotFoundError } from "../domain/errors.js";`,
  );
  lines.push(
    `import { type DomainEventDispatcher } from "../domain/events.js";`,
  );
  lines.push(`import type { NodePgDatabase } from "drizzle-orm/node-postgres";`);
  lines.push(`import type * as schema from "../db/schema.js";`);
  // Source aggregate + repo per view (deduped — many views may
  // share an aggregate).
  const aggsTouched = new Set<string>();
  for (const v of ctx.views) aggsTouched.add(v.aggregateName);
  for (const aggName of aggsTouched) {
    lines.push(
      `import { ${aggName}Repository } from "../db/repositories/${camel(aggName)}-repository.js";`,
    );
    // Reuse the aggregate routes file's exported response schemas
    // — single source of truth, so the OpenAPI spec for
    // /views/<...> matches the aggregate's GET endpoints exactly.
    // `<Agg>Response` is the per-row shape; `<Agg>ListResponse`
    // is `z.array(<Agg>Response)` for the route's response.
    lines.push(
      `import { ${aggName}Response, ${aggName}ListResponse } from "./${camel(aggName)}.routes.js";`,
    );
  }
  lines.push("");

  lines.push(
    `export function viewsRoutes(`,
  );
  lines.push(`  db: NodePgDatabase<typeof schema>,`);
  lines.push(`  events: DomainEventDispatcher,`);
  lines.push(`): OpenAPIHono {`);
  lines.push(`  const app = new OpenAPIHono();`);
  lines.push("");

  for (const view of ctx.views) {
    lines.push(...emitViewRoute(view, ctx, aggsByName).map((l) => `  ${l}`));
    lines.push("");
  }

  lines.push(`  app.onError((err, c) => {`);
  lines.push(
    `    if (err instanceof DomainError) return c.json({ error: err.message }, 400);`,
  );
  lines.push(
    `    if (err instanceof AggregateNotFoundError) return c.json({ error: err.message }, 404);`,
  );
  lines.push(`    console.error(err);`);
  lines.push(`    return c.json({ error: "internal" }, 500);`);
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
  out.push(`app.openapi(`);
  out.push(`  createRoute({`);
  out.push(`    method: "get",`);
  out.push(`    path: "/${snake(view.name)}",`);
  out.push(`    tags: ["views", "${aggSlug}"],`);
  out.push(`    operationId: "${camel(view.name)}View",`);
  out.push(`    responses: {`);
  // Response is `<Agg>ListResponse` — typed array of the source
  // aggregate's wire shape, imported verbatim from the aggregate's
  // routes file.  Slice 1 keeps the response shape unchanged;
  // later slices may declare custom shapes.
  out.push(
    `      200: { description: "OK", content: { "application/json": { schema: ${view.aggregateName}ListResponse } } },`,
  );
  out.push(`    },`);
  out.push(`  }),`);
  out.push(`  async (httpCtx) => {`);
  out.push(`    const repo = new ${view.aggregateName}Repository(db, events);`);
  out.push(`    const rows = await repo.${camel(view.name)}();`);
  // The cast at the wire boundary mirrors the per-aggregate find
  // route: `repo.toWire` returns the canonical wire shape but its
  // declared TS return type is `unknown` (it walks runtime
  // `wireShape` metadata), so a `z.infer<typeof X>` assertion
  // tells the route's typed Hono response handler the exact shape
  // we know we produced.
  out.push(
    `    return httpCtx.json(rows.map((r) => repo.toWire(r)) as z.infer<typeof ${view.aggregateName}Response>[], 200);`,
  );
  out.push(`  },`);
  out.push(`);`);
  return out;
}
