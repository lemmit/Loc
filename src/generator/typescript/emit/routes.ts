import type { EnrichedBoundedContextIR } from "../../../ir/types/loom-ir.js";
import { isMaterializedProjection, isQueryTimeProjection } from "../../../ir/types/loom-ir.js";
import {
  aggregatesHaveUniqueKeys,
  aggregatesNeedConcurrency,
} from "../../../ir/util/aggregate-flags.js";
import { durableEventTypes, realtimeEventTypes } from "../../../ir/util/channels.js";
import { problemTitle } from "../../../ir/util/openapi-errors.js";
import { opHasProvSite } from "../../../ir/util/prov-id.js";
import { API_BASE_PATH, AUTH_BASE_PATH } from "../../../util/api-base.js";
import { lines } from "../../../util/code-builder.js";
import { resolveErrorStatus } from "../../../util/error-defaults.js";
import { lowerFirst, plural, snake } from "../../../util/naming.js";
import { renderHonoBaseLogCall, renderHonoLogCall } from "../../_obs/render-hono.js";

// The per-aggregate routes file is built procedurally in
// `routes-builder.ts` because the OpenAPI annotations push it past
// what's pleasant to read in a template.  This file owns just the
// `createApp` composition entry, which mounts each aggregate's
// sub-router and exposes `/openapi.json`.
/** A per-served-api explicit-route router (unfoldable-api-derivation.md, A2) to
 *  mount in `createApp`: the exported factory name, its module path, and the
 *  base path it mounts at. */
export interface ExplicitRouterMount {
  fn: string;
  module: string;
  mountPath: string;
}

export function renderHttpIndex(
  ctx: EnrichedBoundedContextIR,
  options?: {
    authRequired?: boolean;
    persistence?: string;
    /** Explicit `route <M> <p> -> <Ctx>.<Handler>` routers (A2) — mounted after
     *  the aggregate/workflow routers, before `/openapi.json`.  Empty /
     *  absent → byte-identical to the pre-A2 output. */
    explicitRouters?: readonly ExplicitRouterMount[];
    /** File upload/download wiring (M-T1.2).  Present iff the deployable hosts
     *  a `File`-bearing aggregate AND binds an `objectStore` dataSource;
     *  `resource` is that binding's name, `sourceType` its storage type (the
     *  `resources/<sourceType>.ts` module exposing `<resource>$putBytes` /
     *  `<resource>$getBytes`).  Absent → no `/files` routes emitted
     *  (byte-identical output). */
    fileUpload?: { resource: string; sourceType: string };
    /** M-T4.4 slice 3: durable events ride a broker-bound `queue`/`work`
     *  channel — the outbox must capture them even when this deployable hosts
     *  no reactor (a pure producer), so the relay can publish on drain. */
    forceOutbox?: boolean;
  },
): string {
  const authRequired = !!options?.authRequired;
  const explicitRouters = options?.explicitRouters ?? [];
  // File upload/download (M-T1.2) — global `POST /files` + `GET /files/:key`
  // over the deployable's bound objectStore adapter.  Absent → no import, no
  // routes (byte-identical).
  const fileUpload = options?.fileUpload;
  const fileImport = fileUpload
    ? `import { ${fileUpload.resource}$getBytes, ${fileUpload.resource}$putBytes } from "../resources/${fileUpload.sourceType}";\nimport { randomUUID } from "node:crypto";`
    : null;
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
  // Extern operations (extern (b) Phase 2) re-home to aggregate-owned hooks
  // implemented by a scaffold-once subclass — a missing implementation is a
  // COMPILE error (unimplemented abstract), so there is no boot-time registry
  // verify anymore.
  // baseLogger is needed at boot for any info/debug line that fires BEFORE the
  // first request (auth enabled, etc.), and by the root framework-fault
  // handlers below (which fire for requests no sub-router claimed, so the
  // per-request child logger the sub-routers use was never bound).
  const baseLoggerImport = `import { baseLogger } from "../obs/log";`;
  const hasWorkflows = ctx.workflows.length > 0;
  // In-process event dispatch (channels.md): when this deployable has any
  // channel-routed subscription, the generated `http/workflows.ts` exports
  // `createInProcessDispatcher`, and `createApp` defaults `events` to it
  // (routing emitted events to reactors / event-creates) instead of the no-op.
  // The MikroORM adapter is included: the workflow correlation store is now
  // persistence-neutral (usingMikro branch → EntityManager), so the synchronous
  // in-process saga cascade runs on mikro exactly as on drizzle.
  // Workflow saga dispatch: driven by WORKFLOW subscriptions only (projection
  // subs carry a `projection` discriminant and are handled by the projectionTee
  // below).  Excluding them keeps a workflow-only project byte-identical and a
  // projection-only project from importing the never-emitted
  // `createInProcessDispatcher`.
  const wireDispatcher = ctx.eventSubscriptions.some((s) => !s.projection);
  // Projection folds (projection.md): a dispatcher decorator that upserts read
  // models, composed over the workflow dispatcher (or the Noop).
  // FOLDED projections drive the event-fold tee + `http/projections.ts` mount.
  // Query-time projections (read-path-architecture.md rev.13) have no folds —
  // they mount their own `/projections` router from `http/query-projections.ts`.
  // FOLDED projections now emit on BOTH persistence adapters (the MikroORM
  // read-model store + fold routes land via `buildProjectionsFile(..., usingMikro)`),
  // so the fold tee + `/projections` mount are no longer drizzle-gated.
  const hasProjections = ctx.projections.some(isMaterializedProjection);
  const hasQueryProjections = ctx.projections.some(isQueryTimeProjection) && !usingMikro;
  // Transactional-outbox tier (dispatch-delivery-semantics.md): when any
  // channel asks for durability (`retention: log | work`), createApp's
  // default dispatcher wraps the in-process one — durable events are
  // recorded in __loom_outbox and the relay (started by index.ts) delivers
  // them; ephemeral events keep the inline at-most-once path.
  // Persistence-neutral since M-T6.23 slice 1: the MikroORM adapter emits the
  // same two exports over the `LoomOutboxRow` EntitySchema, so a durable channel
  // is at-least-once on both adapters (it silently degraded to the at-most-once
  // in-process path here before).
  const wireOutbox = (wireDispatcher || !!options?.forceOutbox) && durableEventTypes(ctx).size > 0;
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
  // Pure-producer outbox wire (M-T4.4 slice 3): createOutboxDispatcher lives
  // in ./workflows (emitted for durable-broker producers even without
  // workflows); the workflow import above only covers the hasWorkflows case.
  const outboxImport =
    wireOutbox && !hasWorkflows ? `import { createOutboxDispatcher } from "./workflows";` : null;
  const workflowMount = hasWorkflows
    ? `  app.route("${API_BASE_PATH}/workflows", workflowsRoutes(db, events));`
    : null;
  const projectionImport = hasProjections
    ? `import { projectionsRoutes, projectionTee } from "./projections";`
    : null;
  const projectionMount = hasProjections
    ? `  app.route("${API_BASE_PATH}/projections", projectionsRoutes(db));`
    : null;
  // Query-time projection router — a second sub-app mounted at the same
  // `/projections` prefix (Hono merges routers by prefix); reads through the
  // aggregate repositories, so it takes `(db, events)` unlike the folded one.
  const queryProjectionImport = hasQueryProjections
    ? `import { queryProjectionsRoutes } from "./query-projections";`
    : null;
  const queryProjectionMount = hasQueryProjections
    ? `  app.route("${API_BASE_PATH}/projections", queryProjectionsRoutes(db, events));`
    : null;
  // Explicit-route routers (unfoldable-api-derivation.md, A2) — one per served
  // api with resolvable `route` bindings.  Byte-identical when none.
  const explicitRouterImports = explicitRouters.map(
    (r) => `import { ${r.fn} } from "${r.module}";`,
  );
  const explicitRouterMounts = explicitRouters.map(
    (r) => `  app.route("${r.mountPath}", ${r.fn}(db, events));`,
  );
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
  // File routes (M-T1.2): multipart upload mints a uuid key, stores the raw
  // bytes via the objectStore adapter, and returns the FileRef the wire
  // schemas expect; download streams the object back with its stored
  // contentType.  A deleted File-bearing row leaves its object (no lifecycle
  // coupling — owner decision).
  const fileRoutes = fileUpload
    ? [
        `  // File upload — multipart POST, stores raw bytes in the '${fileUpload.resource}' object store,`,
        `  // returns a FileRef { url, key, contentType, size } to persist on a File field.`,
        `  app.post("/files", async (c) => {`,
        `    const body = await c.req.parseBody();`,
        `    const file = body["file"];`,
        `    if (!(file instanceof File)) {`,
        `      return c.json({ error: "expected a 'file' form field" }, 400);`,
        `    }`,
        `    const key = randomUUID();`,
        `    const bytes = new Uint8Array(await file.arrayBuffer());`,
        `    const contentType = file.type || "application/octet-stream";`,
        `    await ${fileUpload.resource}$putBytes(key, bytes, contentType);`,
        `    return c.json({ url: "/files/" + key, key, contentType, size: bytes.byteLength }, 201);`,
        `  });`,
        `  // File download — streams the stored object back with its contentType.`,
        `  app.get("/files/:key", async (c) => {`,
        `    const obj = await ${fileUpload.resource}$getBytes(c.req.param("key"));`,
        `    if (!obj) return c.json({ error: "not found" }, 404);`,
        `    // Copy into a standalone ArrayBuffer — Hono's c.body() rejects a`,
        `    // Uint8Array whose backing buffer is only ArrayBufferLike.`,
        `    const ab = obj.body.buffer.slice(`,
        `      obj.body.byteOffset,`,
        `      obj.body.byteOffset + obj.body.byteLength,`,
        `    ) as ArrayBuffer;`,
        `    return c.body(ab, 200, { "content-type": obj.contentType });`,
        `  });`,
      ].join("\n")
    : null;
  // ── the root DOMAIN ladder (M-T6.28) ──────────────────────────────────
  // The FLOOR every mounted sub-app inherits when it declares no `onError` of
  // its own.  Same rungs, same statuses and same fault counters as the
  // per-aggregate router's ladder (`routes-builder.ts`), resolved through the
  // api's `httpStatus` override map so an override retargets the floor too;
  // with no override the statuses collapse to 403 / 409 / 422 / 404 / 500.
  //
  // The `23505` and `ConcurrencyError` rungs are presence-gated exactly as they
  // are per-router — on a declared `unique (…)` key and on `versioned` /
  // event-sourced respectively — because only such a project can raise them
  // (and `ConcurrencyError` is not even emitted into `domain/errors.ts`
  // otherwise).
  const rootForbiddenStatus = resolveErrorStatus("Forbidden", ctx.structuralErrorStatuses);
  const rootDisallowedStatus = resolveErrorStatus("Disallowed", ctx.structuralErrorStatuses);
  const rootDomainStatus = resolveErrorStatus("DomainError", ctx.structuralErrorStatuses);
  const rootUniquenessStatus = resolveErrorStatus(
    "UniquenessConflict",
    ctx.structuralErrorStatuses,
  );
  const rootConcurrencyStatus = resolveErrorStatus(
    "ConcurrencyConflict",
    ctx.structuralErrorStatuses,
  );
  const rootNeedsConcurrency = aggregatesNeedConcurrency(ctx.aggregates);
  const rootHasUniqueKeys = aggregatesHaveUniqueKeys(ctx.aggregates);
  const rootProblemStatuses = new Set<number>([
    rootForbiddenStatus,
    404,
    rootDomainStatus,
    500,
    rootDisallowedStatus,
  ]);
  if (rootHasUniqueKeys) rootProblemStatuses.add(rootUniquenessStatus);
  if (rootNeedsConcurrency) rootProblemStatuses.add(rootConcurrencyStatus);
  const rootProblemUnion = [...rootProblemStatuses].sort((a, b) => a - b).join(" | ");
  const rootLadderErrorClasses = [
    "AggregateNotFoundError",
    ...(rootNeedsConcurrency ? ["ConcurrencyError"] : []),
    "DisallowedError",
    "DomainError",
    "ExternHandlerError",
    "ForbiddenError",
  ];
  const rootDomainLadder = [
    // The request middleware mounts on THIS app (`app.use("*", …)`), so a fault
    // from a mounted sub-app has a request id to correlate on — same read, same
    // cast bridge as the sub-routers use.
    `    const trace_id = (c as unknown as { get(k: "requestId"): string | undefined }).get("requestId") ?? "";`,
    `    const problem = (status: ${rootProblemUnion}, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });`,
    "    if (err instanceof ForbiddenError) {",
    `      ${renderHonoBaseLogCall("forbidden", `message: err.message, status: ${rootForbiddenStatus}`)}`,
    '      recordDomainFault("forbidden");',
    `      return problem(${rootForbiddenStatus}, ${JSON.stringify(problemTitle(rootForbiddenStatus))}, err.message);`,
    "    }",
    "    if (err instanceof DisallowedError) {",
    `      ${renderHonoBaseLogCall("disallowed", `message: err.message, status: ${rootDisallowedStatus}`)}`,
    '      recordDomainFault("disallowed");',
    `      return problem(${rootDisallowedStatus}, "Disallowed", err.message);`,
    "    }",
    "    if (err instanceof DomainError) {",
    `      ${renderHonoBaseLogCall("domainError", `message: err.message, status: ${rootDomainStatus}`)}`,
    '      recordDomainFault("domain_error");',
    `      return problem(${rootDomainStatus}, ${JSON.stringify(problemTitle(rootDomainStatus))}, err.message);`,
    "    }",
    "    if (err instanceof AggregateNotFoundError) {",
    `      ${renderHonoBaseLogCall("notFound", "status: 404")}`,
    '      recordDomainFault("not_found");',
    '      return problem(404, "Not Found", err.message);',
    "    }",
    ...(rootHasUniqueKeys
      ? [
          // PG unique_violation, read through drizzle's wrapper exactly as the
          // aggregate router reads it (SQLSTATE on `err` OR on `err.cause`).
          `    if (err && typeof err === "object" && (((err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code) === "23505")) {`,
          `      ${renderHonoBaseLogCall("disallowed", `message: (err as { constraint?: string }).constraint ?? (err as { cause?: { constraint?: string } }).cause?.constraint ?? "unique_violation", status: ${rootUniquenessStatus}`)}`,
          '      recordDomainFault("disallowed");',
          `      return problem(${rootUniquenessStatus}, "Conflict", "A record with these values already exists.");`,
          "    }",
        ]
      : []),
    ...(rootNeedsConcurrency
      ? [
          "    if (err instanceof ConcurrencyError) {",
          `      ${renderHonoBaseLogCall("conflict", `message: err.message, status: ${rootConcurrencyStatus}`)}`,
          '      recordDomainFault("conflict");',
          `      return problem(${rootConcurrencyStatus}, "Conflict", err.message);`,
          "    }",
        ]
      : []),
    "    if (err instanceof ExternHandlerError) {",
    `      ${renderHonoBaseLogCall("externHandlerThrew", "aggregate: err.aggName, op: err.opName, error: err.message")}`,
    // RS-28 — sanitized: the operator gets op + aggregate + the inner message on
    // the log line; the wire gets the same "internal" every other 500 sends.
    '      return problem(500, "Internal Server Error", "internal");',
    "    }",
  ];
  return (
    lines(
      "// Auto-generated.",
      'import { OpenAPIHono } from "@hono/zod-openapi";',
      'import type { Context } from "hono";',
      'import { cors } from "hono/cors";',
      'import { HTTPException } from "hono/http-exception";',
      'import { TrieRouter } from "hono/router/trie-router";',
      'import type { ContentfulStatusCode } from "hono/utils/http-status";',
      'import { frameworkProblemBody } from "./problem-details";',
      usingMikro ? null : 'import { sql } from "drizzle-orm";',
      'import { requestIdMiddleware } from "../obs/request-id";',
      // `recordDomainFault` joins `registry` here for the root DOMAIN ladder
      // (M-T6.28): a fault answered by the floor must count exactly as the same
      // fault answered by a sub-router, or the fault counters under-report by
      // whichever router forgot its ladder.
      'import { recordDomainFault, registry } from "../obs/metrics";',
      `import { ${rootLadderErrorClasses.join(", ")} } from "../domain/errors";`,
      baseLoggerImport,
      authImport,
      ...aggregateImports,
      workflowImport,
      outboxImport,
      realtimeImport,
      projectionImport,
      queryProjectionImport,
      ...explicitRouterImports,
      fileImport,
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
      "// The verbs a method-mismatch probe asks about (see `allowedFor` below).",
      "// Deliberately not hono's exported METHODS: that list carries `options`,",
      "// which the CORS middleware answers for every path, so probing it would",
      "// report an `Allow` on routes that serve nothing.",
      'const PROBE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;',
      "",
      "export function createApp(",
      usingMikro ? "  db: EntityManager," : "  db: NodePgDatabase<typeof schema>,",
      // When dispatch is wired, the default builds the in-process dispatcher
      // from `db` (a later default param may reference an earlier one); a caller
      // can still pass an explicit dispatcher (e.g. a broker publisher).
      `  events: DomainEventDispatcher = ${defaultEventsExpr},`,
      "): OpenAPIHono {",
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
      "  // Prometheus scrape target — the text exposition of the registry in",
      "  // obs/metrics.ts (default process/runtime metrics + the HTTP",
      "  // counter/histogram recorded by the request-id middleware).  Sits",
      "  // beside the probes with the same access exposure; a Prometheus",
      "  // server or the OTel collector scrapes it on the deployable's port.",
      '  app.get("/metrics", async (c) => {',
      "    const body = await registry.metrics();",
      '    return c.text(body, 200, { "Content-Type": registry.contentType });',
      "  });",
      ...aggregateRoutes,
      workflowMount,
      realtimeMount,
      projectionMount,
      queryProjectionMount,
      ...explicitRouterMounts,
      fileRoutes,
      // ── framework-originated faults ──────────────────────────────────
      // Every sub-router carries its own `app.onError` mapping DOMAIN errors
      // to RFC 7807.  A request that never reaches one — an unmatched path, a
      // body the router itself refused — bypassed all of them and fell
      // through to Hono's defaults: `text/plain` "404 Not Found" and a bare
      // 500.  That is a SECOND error contract on a wire that already
      // committed to `application/problem+json`, and a client cannot parse
      // both.  These two root handlers close it.  Registered on the parent
      // app; a sub-app that declares its OWN `onError` still wins for its
      // requests (hono's `route()` wraps each of that sub-app's handlers in it),
      // so these answer (a) requests no sub-router claimed and (b) faults raised
      // inside a sub-app that declared NO handler.
      //
      // (b) is why the root ladder below is not framework-only (M-T6.28).  Not
      // every mounted router declares a ladder: `http/projections.ts` is built
      // on a bare `new OpenAPIHono()` and `http/realtime.ts` likewise, so a
      // DOMAIN fault raised there — the folded-projection show's own
      // `AggregateNotFoundError`, most of all — inherited only the framework
      // arms and answered **500 `"internal"`** where every other backend
      // answered 404.  The floor therefore carries the same domain ladder the
      // sub-routers do, and a per-router handler is a refinement rather than the
      // only line of defence.
      "  const frameworkProblem = (",
      "    c: Context,",
      "    status: ContentfulStatusCode,",
      "    detail: string,",
      "    extraHeaders: Record<string, string> = {},",
      "  ) => {",
      `    ${renderHonoBaseLogCall("clientError", "error: detail, status")}`,
      "    return c.body(frameworkProblemBody(status, detail, c.req.path), status, {",
      '      "content-type": "application/problem+json",',
      "      ...extraHeaders,",
      "    });",
      "  };",
      // `app.notFound` fires for BOTH a path that does not exist and a path
      // that exists under a different verb — hono keys its router on
      // (method, path), so the miss carries no reason and everything came back
      // 404.  RFC 9110 §15.5.6 reserves 405 for the second, and the difference
      // matters to the caller: one means "fix the URL", the other "fix the
      // verb", and only the second can carry an `Allow` header they can act on.
      //
      // A second router answers it.  Built from `app.routes`, which by this
      // point carries every mounted sub-router's routes at their FULL paths, so
      // one probe covers the whole surface.
      //
      // Two details are load-bearing:
      //   * `ALL` entries are skipped.  That is the method `app.use("*", …)`
      //     registers middleware under, and it matches every path — counting it
      //     would report every unknown URL as a method mismatch.
      //   * built LAZILY, on the first miss.  `app.doc()` below registers the
      //     spec route AFTER these handlers, so a probe built eagerly here
      //     would answer 404 for a `POST /openapi.json`.
      "  let methodProbe: TrieRouter<string> | null = null;",
      "  const allowedFor = (path: string): string[] => {",
      "    if (!methodProbe) {",
      "      methodProbe = new TrieRouter<string>();",
      "      for (const r of app.routes) {",
      '        if (r.method !== "ALL") methodProbe.add(r.method, r.path, r.method);',
      "      }",
      "    }",
      "    const probe = methodProbe;",
      "    return PROBE_METHODS.filter((m) => probe.match(m, path)[0].length > 0);",
      "  };",
      "  app.notFound((c) => {",
      "    const allow = allowedFor(c.req.path).filter((m) => m !== c.req.method);",
      "    if (allow.length > 0) {",
      "      return frameworkProblem(",
      "        c,",
      "        405,",
      "        `method ${c.req.method} is not supported for ${c.req.path}`,",
      '        { allow: allow.join(", ") },',
      "      );",
      "    }",
      "    return frameworkProblem(c, 404, `no route for ${c.req.method} ${c.req.path}`);",
      "  });",
      "  app.onError((err, c) => {",
      ...rootDomainLadder,
      // HTTPException is what Hono itself throws for the faults it detects
      // (unreadable body, an aborted request); anything else reaching here is
      // a genuine server fault and must not put its message on the wire.
      // LAST among the typed arms, exactly as in the per-router ladders, so no
      // domain class it might subclass loses its own mapping.
      "    if (err instanceof HTTPException) {",
      "      return frameworkProblem(c, err.status as ContentfulStatusCode, err.message);",
      "    }",
      "    const message = err instanceof Error ? err.message : String(err);",
      `    ${renderHonoBaseLogCall("internalError", "error: message, status: 500")}`,
      '    return frameworkProblem(c, 500, "internal");',
      "  });",
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
