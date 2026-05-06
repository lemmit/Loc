import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { camel, plural, snake } from "../../../util/naming.js";
import { lines } from "../../../util/code-builder.js";

// The per-aggregate routes file is built procedurally in
// `routes-builder.ts` because the OpenAPI annotations push it past
// what's pleasant to read in a template.  This file owns just the
// `createApp` composition entry, which mounts each aggregate's
// sub-router and exposes `/openapi.json`.
export function renderHttpIndex(ctx: BoundedContextIR): string {
  const aggregateImports = ctx.aggregates.flatMap((a) => [
    `import { ${camel(a.name)}Routes } from "./${camel(a.name)}.routes.js";`,
    `import { ${a.name}Repository } from "../db/repositories/${camel(a.name)}-repository.js";`,
  ]);
  const aggregateRoutes = ctx.aggregates.map(
    (a) =>
      `  app.route("/${snake(plural(a.name))}", ${camel(a.name)}Routes(new ${a.name}Repository(db, events)));`,
  );
  const externAggs = ctx.aggregates.filter((a) =>
    a.operations.some((o) => o.extern),
  );
  const externImports = externAggs.map(
    (a) =>
      `import { verify${a.name}ExternHandlersRegistered } from "../domain/${camel(a.name)}-extern.js";`,
  );
  const externVerifyBody = externAggs.map(
    (a) => `  verify${a.name}ExternHandlersRegistered();`,
  );
  const hasWorkflows = ctx.workflows.length > 0;
  const workflowImport = hasWorkflows
    ? `import { workflowsRoutes } from "./workflows.js";`
    : null;
  const workflowMount = hasWorkflows
    ? `  app.route("/workflows", workflowsRoutes(db, events));`
    : null;
  return (
    lines(
      "// Auto-generated.",
      'import { OpenAPIHono } from "@hono/zod-openapi";',
      'import { cors } from "hono/cors";',
      ...aggregateImports,
      ...externImports,
      workflowImport,
      'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
      'import type * as schema from "../db/schema.js";',
      'import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events.js";',
      "",
      "export function createApp(",
      "  db: NodePgDatabase<typeof schema>,",
      "  events: DomainEventDispatcher = NoopDomainEventDispatcher,",
      "): OpenAPIHono {",
      externAggs.length > 0
        ? "  // Verify every extern operation has a registered handler.  Fails\n  // fast at startup so a missing user implementation surfaces here\n  // instead of as a 500 on the first request."
        : null,
      ...externVerifyBody,
      "  const app = new OpenAPIHono();",
      "  // Permissive CORS so a generated React frontend on a different port",
      "  // can reach the API in dev compose.  Pin http/index.ts in",
      "  // .loomignore + tighten in production.",
      '  app.use("*", cors());',
      "  // Liveness probe — used by docker-compose / kubernetes / smoke tests.",
      '  app.get("/health", (c) => c.json({ status: "ok" }));',
      ...aggregateRoutes,
      workflowMount,
      "  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()",
      "  // calls.  Diffed against the .NET-emitted /swagger/v1/swagger.json by",
      "  // the cross-platform contract check.",
      '  app.doc("/openapi.json", {',
      '    openapi: "3.1.0",',
      '    info: { title: "Generated API", version: "1.0.0" },',
      "  });",
      "  return app;",
      "}",
    ) + "\n"
  );
}
