import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import { durableEventTypes, realtimeEventTypes } from "../../../ir/util/channels.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { API_BASE_PATH, AUTH_BASE_PATH } from "../../../util/api-base.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { renderHonoBaseLogCall, renderHonoLogCall } from "../../_obs/render-hono.js";

// The per-aggregate routes file is built procedurally in
// `routes-builder.ts` because the OpenAPI annotations push it past
// what's pleasant to read in a template.  This file owns just the
// `createApp` composition entry, which mounts each aggregate's
// sub-router and exposes `/openapi.json`.
export function renderHttpIndex(
  ctx: EnrichedBoundedContextIR,
  options?: { authRequired?: boolean; persistence?: string },
): string {
  const authRequired = !!options?.authRequired;
  // Persistence selection (D-REALIZATION-AXES) — the `db` handle createApp
  // threads is drizzle's `NodePgDatabase` by default, or a MikroORM
  // `EntityManager` when `persistence: mikroorm`.
  const usingMikro = options?.persistence === "mikroorm";
  // Abstract bases (aggregate-inheritance.md) own only the shared TPH table —
  // no domain module, repository, or routes — so they're never mounted here.
  const aggregates = ctx.aggregates.filter((a) => !a.isAbstract);
  const aggregateImports = aggregates.flatMap((a) => [
    `import { ${lowerFirst(a.name)}Routes } from "./${lowerFirst(a.name)}.routes";`,
    `import { ${a.name}Repository } from "../db/repositories/${lowerFirst(a.name)}-repository";`,
  ]);
  const aggregateRoutes = aggregates.map((a) => {
    // Aggregates with an audited OR provenanced public operation — or an
    // audited lifecycle action (`create(...) audited` / `destroy audited`) —
    // also receive `db` + `events` so the route can run its save + audit
    // insert + provenance flush in one transaction (matches the
    // transactional router signature in routes-builder; the lifecycle gate
    // mirrors `auditCreate` / `auditDestroy` there).
    const auditedCreateAction =
      a.persistedAs === "eventLog" ? (a.creates?.[0] ?? null) : (a.canonicalCreate ?? null);
    const needsTx =
      a.operations.some((o) => o.visibility === "public" && (o.audited || opHasProvSite(o))) ||
      !!auditedCreateAction?.audited ||
      !!a.canonicalDestroy?.audited;
    const repoArg = `new ${a.name}Repository(db, events)`;
    const args = needsTx ? `${repoArg}, db, events` : repoArg;
    return `  app.route("${API_BASE_PATH}/${snake(plural(a.name))}", ${lowerFirst(a.name)}Routes(${args}));`;
  });
  const externAggs = aggregates.filter((a) => a.operations.some((o) => o.extern));
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
  // In-process event dispatch (channels.md): when this deployable has any
  // channel-routed subscription AND uses the default drizzle persistence, the
  // generated `http/workflows.ts` exports `createInProcessDispatcher`, and
  // `createApp` defaults `events` to it (routing emitted events to reactors /
  // event-creates) instead of the no-op.  Mikro and channel-less projects keep
  // the Noop default — byte-identical output.
  // Workflow saga dispatch: driven by WORKFLOW subscriptions only (projection
  // subs carry a `projection` discriminant and are handled by the projectionTee
  // below).  Excluding them keeps a workflow-only project byte-identical and a
  // projection-only project from importing the never-emitted
  // `createInProcessDispatcher`.
  const wireDispatcher = ctx.eventSubscriptions.some((s) => !s.projection) && !usingMikro;
  // Projection folds (projection.md): a dispatcher decorator that upserts read
  // models, composed over the workflow dispatcher (or the Noop).
  const hasProjections = ctx.projections.length > 0 && !usingMikro;
  // Transactional-outbox tier (dispatch-delivery-semantics.md): when any
  // channel asks for durability (`retention: log | work`), createApp's
  // default dispatcher wraps the in-process one — durable events are
  // recorded in __loom_outbox and the relay (started by index.ts) delivers
  // them; ephemeral events keep the inline at-most-once path.
  const wireOutbox = wireDispatcher && durableEventTypes(ctx).size > 0;
  // Realtime SSE wire (channels.md Part I): any `delivery: broadcast`
  // channel makes its carried events UI-observable — createApp wraps its
  // default dispatcher with the realtime tee and mounts GET /realtime/events.
  const wireRealtime = !usingMikro && realtimeEventTypes(ctx).size > 0;
  const realtimeImport = wireRealtime
    ? `import { realtimeRoutes, realtimeTee } from "./realtime";`
    : null;
  const realtimeMount = wireRealtime
    ? `  app.route("${API_BASE_PATH}/realtime", realtimeRoutes());`
    : null;
  // Compose the default dispatcher chain: outbox short-circuits durable
  // events to the table (the relay re-enters through the tee), the tee
  // copies every dispatched event onto the SSE wire, the in-process
  // dispatcher (or Noop) does the actual handler fan-out.
  const inProcessExpr = wireDispatcher
    ? "createInProcessDispatcher(db)"
    : "NoopDomainEventDispatcher";
  // The projection tee wraps the in-process/Noop base so folds run on every
  // dispatched event before the (workflow) fan-out; realtime + outbox wrap that.
  const withProjections = hasProjections ? `projectionTee(db, ${inProcessExpr})` : inProcessExpr;
  const innerExpr = wireRealtime ? `realtimeTee(${withProjections})` : withProjections;
  const defaultEventsExpr = wireOutbox ? `createOutboxDispatcher(db, ${innerExpr})` : innerExpr;
  const workflowImport = hasWorkflows
    ? wireDispatcher
      ? wireOutbox
        ? `import { createInProcessDispatcher, createOutboxDispatcher, workflowsRoutes } from "./workflows";`
        : `import { createInProcessDispatcher, workflowsRoutes } from "./workflows";`
      : `import { workflowsRoutes } from "./workflows";`
    : null;
  const workflowMount = hasWorkflows
    ? `  app.route("${API_BASE_PATH}/workflows", workflowsRoutes(db, events));`
    : null;
  const hasViews = ctx.views.length > 0;
  const viewImport = hasViews ? `import { viewsRoutes } from "./views";` : null;
  const viewMount = hasViews
    ? `  app.route("${API_BASE_PATH}/views", viewsRoutes(db, events));`
    : null;
  const projectionImport = hasProjections
    ? `import { projectionsRoutes, projectionTee } from "./projections";`
    : null;
  const projectionMount = hasProjections
    ? `  app.route("${API_BASE_PATH}/projections", projectionsRoutes(db));`
    : null;
  // Auth wiring — when the deployable opts in via `auth: required`,
  // we import the middleware + verifier registry, assert at startup
  // that the user supplied a verifier, and mount the middleware
  // after CORS but before any business route.
  const authImport = authRequired
    ? `import { authMiddleware } from "../auth/middleware";\nimport { assertUserVerifierRegistered } from "../auth/verifier";\nimport { authRoutes } from "../auth/handshake";`
    : null;
  // After the verifier assert, emit `auth_enabled` info so every boot's
  // log stream advertises whether auth is on for this deployable —
  // useful in mixed environments where the same image runs auth/no-auth.
  const authVerifyAssert = authRequired
    ? `  assertUserVerifierRegistered();\n  ${renderHonoBaseLogCall("authEnabled", "required: true")}`
    : null;
  const authMount = authRequired ? '  app.use("*", authMiddleware);' : null;
  // Auth session routes mount under the API base (`/api/auth`): `/api/auth/me`
  // (the frontend guard's session probe) always, plus the OIDC login redirect
  // + callback (which the middleware bypasses) when an `auth { oidc }` block is
  // present.  Same origin as the domain routes — the frontend already targets
  // `${API_BASE_URL}/auth/...`.
  const authRoutesMount = authRequired ? `  app.route("${AUTH_BASE_PATH}", authRoutes());` : null;
  return (
    lines(
      "// Auto-generated.",
      'import { OpenAPIHono } from "@hono/zod-openapi";',
      'import { cors } from "hono/cors";',
      usingMikro ? null : 'import { sql } from "drizzle-orm";',
      'import { requestIdMiddleware } from "../obs/request-id";',
      baseLoggerImport,
      authImport,
      ...aggregateImports,
      ...externImports,
      workflowImport,
      realtimeImport,
      viewImport,
      projectionImport,
      usingMikro
        ? 'import { EntityManager } from "@mikro-orm/postgresql";'
        : 'import type { NodePgDatabase } from "drizzle-orm/node-postgres";',
      usingMikro ? null : 'import type * as schema from "../db/schema";',
      wireDispatcher
        ? 'import { type DomainEventDispatcher } from "../domain/events";'
        : 'import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events";',
      // (NoopDomainEventDispatcher stays imported on the no-dispatch path —
      // the realtime tee wraps it there.)
      "",
      "export function createApp(",
      usingMikro ? "  db: EntityManager," : "  db: NodePgDatabase<typeof schema>,",
      // When dispatch is wired, the default builds the in-process dispatcher
      // from `db` (a later default param may reference an earlier one); a caller
      // can still pass an explicit dispatcher (e.g. a broker publisher).
      `  events: DomainEventDispatcher = ${defaultEventsExpr},`,
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
      "  // CORS: the compose stack sets CORS_ORIGIN to the frontend origin(s) —",
      "  // a comma-separated allowlist.  When set, only those origins are",
      "  // allowed (with credentials, so the session cookie flows cross-origin).",
      "  // When unset, the fallback is permissive '*' ONLY for an auth-less",
      "  // system; an auth-bearing system denies cross-origin by default (a",
      "  // session cookie reflected against '*' is unsafe).  Pin http/index.ts",
      "  // in .loomignore to override.",
      '  const corsAllowlist = (process.env.CORS_ORIGIN ?? "")',
      '    .split(",")',
      "    .map((s) => s.trim())",
      "    .filter(Boolean);",
      `  const corsAllowAnyFallback = ${!authRequired};`,
      "  app.use(",
      '    "*",',
      "    cors({",
      "      origin: (origin) =>",
      "        corsAllowlist.length > 0",
      "          ? corsAllowlist.includes(origin)",
      "            ? origin",
      "            : null",
      "          : corsAllowAnyFallback",
      '            ? origin || "*"',
      "            : null,",
      "      credentials: true,",
      "    }),",
      "  );",
      authMount,
      authRoutesMount,
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
      usingMikro
        ? '      await db.getConnection().execute("select 1");'
        : "      await db.execute(sql`select 1`);",
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
      realtimeMount,
      viewMount,
      projectionMount,
      "  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()",
      "  // calls.  Diffed against the .NET-emitted /openapi.json by",
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
