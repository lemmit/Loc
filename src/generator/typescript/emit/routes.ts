import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { renderHonoBaseLogCall, renderHonoLogCall } from "../../_obs/render-hono.js";

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
  const aggregateRoutes = ctx.aggregates.map((a) => {
    // Aggregates with an audited OR provenanced public operation also
    // receive `db` + `events` so the route can run its save + audit insert +
    // provenance flush in one transaction (matches the transactional router
    // signature in routes-builder).
    const needsTx = a.operations.some(
      (o) => o.visibility === "public" && (o.audited || opHasProvSite(o)),
    );
    const repoArg = `new ${a.name}Repository(db, events)`;
    const args = needsTx ? `${repoArg}, db, events` : repoArg;
    return `  app.route("/${snake(plural(a.name))}", ${lowerFirst(a.name)}Routes(${args}));`;
  });
  const externAggs = ctx.aggregates.filter((a) => a.operations.some((o) => o.extern));
  const externImports = externAggs.map(
    (a) =>
      `import { verify${a.name}ExternHandlersRegistered } from "../domain/${lowerFirst(a.name)}-extern";`,
  );
  // After verifying registration, emit one `extern_handlers_registered`
  // line per aggregate so an operator can confirm at boot that every
  // declared extern op is wired (and read which ones from the line) —
  // matters for ops debugging where a missing handler used to surface
  // only on the first request.
  const externVerifyBody = externAggs.flatMap((a) => {
    const externOpNames = a.operations
      .filter((o) => o.extern)
      .map((o) => `"${o.name}"`)
      .join(", ");
    const opsCount = a.operations.filter((o) => o.extern).length;
    return [
      `  verify${a.name}ExternHandlersRegistered();`,
      `  ${renderHonoBaseLogCall("externHandlersRegistered", `aggregate: "${a.name}", count: ${opsCount}, ops: [${externOpNames}]`)}`,
    ];
  });
  // baseLogger is needed at boot for any info/debug line that fires
  // BEFORE the first request — extern verify, auth enabled, etc.  Gate
  // the import so plain (no-extern, no-auth) deployables don't pull it in.
  const needsBaseLogger = externAggs.length > 0 || authRequired;
  const baseLoggerImport = needsBaseLogger ? `import { baseLogger } from "../obs/log";` : null;
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
  // After the verifier assert, emit `auth_enabled` info so every boot's
  // log stream advertises whether auth is on for this deployable —
  // useful in mixed environments where the same image runs auth/no-auth.
  const authVerifyAssert = authRequired
    ? `  assertUserVerifierRegistered();\n  ${renderHonoBaseLogCall("authEnabled", "required: true")}`
    : null;
  const authMount = authRequired ? '  app.use("*", authMiddleware);' : null;
  return (
    lines(
      "// Auto-generated.",
      'import { OpenAPIHono } from "@hono/zod-openapi";',
      'import { cors } from "hono/cors";',
      'import { sql } from "drizzle-orm";',
      'import { requestIdMiddleware } from "../obs/request-id";',
      baseLoggerImport,
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
      "  // DB-touching checks live on /ready instead.  Emits health_ok",
      "  // (debug) so probe traffic shows up under LOG_LEVEL=debug — useful",
      "  // when diagnosing why a load balancer considers the pod down.",
      '  app.get("/health", (c) => {',
      `    ${renderHonoLogCall("healthOk", `checks: ["liveness"]`)}`,
      '    return c.json({ status: "ok" });',
      "  });",
      "  // Readiness probe — pings the DB.  K8s readinessProbe uses this to",
      '  // decide "should I send traffic to this pod?".  On failure, emits',
      "  // db_error (error) + health_degraded (debug) so an operator can",
      "  // pin the cause without exec'ing into the pod; the 503 envelope",
      "  // still carries the message for the probe log.",
      '  app.get("/ready", async (c) => {',
      "    try {",
      "      await db.execute(sql`select 1`);",
      `      ${renderHonoLogCall("healthOk", `checks: ["readiness", "db"]`)}`,
      '      return c.json({ status: "ready" });',
      "    } catch (err) {",
      "      const message = err instanceof Error ? err.message : String(err);",
      `      ${renderHonoLogCall("dbError", "error: message")}`,
      `      ${renderHonoLogCall("healthDegraded", `checks: ["db"]`)}`,
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
