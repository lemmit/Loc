import type { BoundedContextIR } from "../../../ir/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";

// The per-aggregate routes file is built procedurally in
// `routes-builder.ts` because the OpenAPI annotations push it past
// what's pleasant to read in a template.  This file owns just the
// `createApp` composition entry, which mounts each aggregate's
// sub-router and exposes `/openapi.json`.
export function renderHttpIndex(
  ctx: BoundedContextIR,
  options?: { authRequired?: boolean },
): string {
  const authRequired = !!options?.authRequired;
  const aggregateImports = ctx.aggregates.flatMap((a) => [
    `import { ${lowerFirst(a.name)}Routes } from "./${lowerFirst(a.name)}.routes";`,
    `import { ${a.name}Repository } from "../db/repositories/${lowerFirst(a.name)}-repository";`,
  ]);
  const aggregateRoutes = ctx.aggregates.map(
    (a) =>
      `  app.route("/${snake(plural(a.name))}", ${lowerFirst(a.name)}Routes(new ${a.name}Repository(db, events)));`,
  );
  const externAggs = ctx.aggregates.filter((a) => a.operations.some((o) => o.extern));
  const externImports = externAggs.map(
    (a) =>
      `import { verify${a.name}ExternHandlersRegistered } from "../domain/${lowerFirst(a.name)}-extern";`,
  );
  const externVerifyBody = externAggs.map((a) => `  verify${a.name}ExternHandlersRegistered();`);
  const hasWorkflows = ctx.workflows.length > 0;
  const workflowImport = hasWorkflows ? `import { workflowsRoutes } from "./workflows";` : null;
  const workflowMount = hasWorkflows
    ? `  app.route("/workflows", workflowsRoutes(db, events));`
    : null;
  const hasViews = ctx.views.length > 0;
  const viewImport = hasViews ? `import { viewsRoutes } from "./views";` : null;
  const viewMount = hasViews ? `  app.route("/views", viewsRoutes(db, events));` : null;
  // Auth wiring — when the deployable opts in via `auth: required`,
  // we import the middleware + verifier registry, assert at startup
  // that the user supplied a verifier, and mount the middleware
  // after CORS but before any business route.
  const authImport = authRequired
    ? `import { authMiddleware } from "../auth/middleware";\nimport { assertUserVerifierRegistered } from "../auth/verifier";`
    : null;
  const authVerifyAssert = authRequired ? "  assertUserVerifierRegistered();" : null;
  const authMount = authRequired ? '  app.use("*", authMiddleware);' : null;
  return (
    lines(
      "// Auto-generated.",
      'import { OpenAPIHono } from "@hono/zod-openapi";',
      'import { cors } from "hono/cors";',
      'import { sql } from "drizzle-orm";',
      'import { requestIdMiddleware } from "../obs/request-id";',
      authImport,
      ...aggregateImports,
      ...externImports,
      workflowImport,
      viewImport,
      'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
      'import type * as schema from "../db/schema";',
      'import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events";',
      "",
      "export function createApp(",
      "  db: NodePgDatabase<typeof schema>,",
      "  events: DomainEventDispatcher = NoopDomainEventDispatcher,",
      "): OpenAPIHono {",
      externAggs.length > 0
        ? "  // Verify every extern operation has a registered handler.  Fails\n  // fast at startup so a missing user implementation surfaces here\n  // instead of as a 500 on the first request."
        : null,
      ...externVerifyBody,
      authVerifyAssert,
      "  const app = new OpenAPIHono();",
      "  // Per-request correlation id + structured request_start /",
      "  // request_end JSON log lines.  Mounted FIRST so every",
      "  // downstream handler + onError sees the id; honours an",
      "  // inbound X-Request-Id header so callers can thread their",
      "  // own id through.",
      '  app.use("*", requestIdMiddleware);',
      "  // Permissive CORS so a generated React frontend on a different port",
      "  // can reach the API in dev compose.  Pin http/index.ts in",
      "  // .loomignore + tighten in production.",
      '  app.use("*", cors());',
      authMount,
      "  // Liveness probe — cheap, no I/O.  K8s livenessProbe / docker-compose",
      '  // healthcheck use this to decide "is the process alive?".  A DB blip',
      "  // must NOT mark the pod not-alive (that restarts the container);",
      "  // DB-touching checks live on /ready instead.",
      '  app.get("/health", (c) => c.json({ status: "ok" }));',
      "  // Readiness probe — pings the DB.  K8s readinessProbe uses this to",
      '  // decide "should I send traffic to this pod?".  Returns 503 with a',
      "  // one-line cause when the DB is unreachable so operators see the",
      "  // reason in the probe log instead of having to exec into the pod.",
      '  app.get("/ready", async (c) => {',
      "    try {",
      "      await db.execute(sql`select 1`);",
      '      return c.json({ status: "ready" });',
      "    } catch (err) {",
      "      const message = err instanceof Error ? err.message : String(err);",
      '      return c.json({ status: "not_ready", error: message }, 503);',
      "    }",
      "  });",
      ...aggregateRoutes,
      workflowMount,
      viewMount,
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
