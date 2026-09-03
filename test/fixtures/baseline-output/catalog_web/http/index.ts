// Auto-generated.
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { TrieRouter } from "hono/router/trie-router";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { frameworkProblemBody } from "./problem-details";
import { sql } from "drizzle-orm";
import { requestIdMiddleware } from "../obs/request-id";
import { recordDomainFault, registry } from "../obs/metrics";
import { AggregateNotFoundError, ConcurrencyError, DisallowedError, DomainError, ExternHandlerError, ForbiddenError } from "../domain/errors";
import { baseLogger } from "../obs/log";
import { productRoutes } from "./product.routes";
import { ProductRepository } from "../db/repositories/product-repository";
import { customerRoutes } from "./customer.routes";
import { CustomerRepository } from "../db/repositories/customer-repository";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events";

// The verbs a method-mismatch probe asks about (see `allowedFor` below).
// Deliberately not hono's exported METHODS: that list carries `options`,
// which the CORS middleware answers for every path, so probing it would
// report an `Allow` on routes that serve nothing.
const PROBE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export function createApp(
  db: NodePgDatabase<typeof schema>,
  events: DomainEventDispatcher = NoopDomainEventDispatcher,
): OpenAPIHono {
  const app = new OpenAPIHono();
  // Per-request correlation id + structured request_start /
  // request_end JSON log lines.  Mounted FIRST so every
  // downstream handler + onError sees the id; honours an
  // inbound X-Request-Id header so callers can thread their
  // own id through.
  app.use("*", requestIdMiddleware);
  // CORS: the compose stack sets CORS_ORIGIN to the frontend origin(s) —
  // a comma-separated allowlist.  When set, only those origins are
  // allowed (with credentials, so the session cookie flows cross-origin).
  // When unset, the fallback is permissive '*' ONLY for an auth-less
  // system; an auth-bearing system denies cross-origin by default (a
  // session cookie reflected against '*' is unsafe).  Pin http/index.ts
  // in .loomignore to override.
  const corsAllowlist = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const corsAllowAnyFallback = true;
  app.use(
    "*",
    cors({
      origin: (origin) =>
        corsAllowlist.length > 0
          ? corsAllowlist.includes(origin)
            ? origin
            : null
          : corsAllowAnyFallback
            ? origin || "*"
            : null,
      credentials: true,
    }),
  );
  // Liveness probe — cheap, no I/O.  K8s livenessProbe / docker-compose
  // healthcheck use this to decide "is the process alive?".  A DB blip
  // must NOT mark the pod not-alive (that restarts the container);
  // DB-touching checks live on /ready instead.  Emits health_ok
  // (debug) so probe traffic shows up under LOG_LEVEL=debug — useful
  // when diagnosing why a load balancer considers the pod down.
  app.get("/health", (c) => {
    c.get("log").debug({ event: "health_ok", checks: ["liveness"] });
    return c.json({ status: "ok" });
  });
  // Readiness probe — pings the DB.  K8s readinessProbe uses this to
  // decide "should I send traffic to this pod?".  On failure, emits
  // db_error (error) + health_degraded (debug) so an operator can
  // pin the cause without exec'ing into the pod; the 503 envelope
  // still carries the message for the probe log.
  app.get("/ready", async (c) => {
    try {
      await db.execute(sql`select 1`);
      c.get("log").debug({ event: "health_ok", checks: ["readiness", "db"] });
      return c.json({ status: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      c.get("log").error({ event: "db_error", error: message });
      c.get("log").debug({ event: "health_degraded", checks: ["db"] });
      return c.json({ status: "not_ready", error: message }, 503);
    }
  });
  // Prometheus scrape target — the text exposition of the registry in
  // obs/metrics.ts (default process/runtime metrics + the HTTP
  // counter/histogram recorded by the request-id middleware).  Sits
  // beside the probes with the same access exposure; a Prometheus
  // server or the OTel collector scrapes it on the deployable's port.
  app.get("/metrics", async (c) => {
    const body = await registry.metrics();
    return c.text(body, 200, { "Content-Type": registry.contentType });
  });
  app.route("/api/products", productRoutes(new ProductRepository(db, events)));
  app.route("/api/customers", customerRoutes(new CustomerRepository(db, events)));
  const frameworkProblem = (
    c: Context,
    status: ContentfulStatusCode,
    detail: string,
    extraHeaders: Record<string, string> = {},
  ) => {
    baseLogger.warn({ event: "client_error", error: detail, status });
    return c.body(frameworkProblemBody(status, detail, c.req.path), status, {
      "content-type": "application/problem+json",
      ...extraHeaders,
    });
  };
  let methodProbe: TrieRouter<string> | null = null;
  const allowedFor = (path: string): string[] => {
    if (!methodProbe) {
      methodProbe = new TrieRouter<string>();
      for (const r of app.routes) {
        if (r.method !== "ALL") methodProbe.add(r.method, r.path, r.method);
      }
    }
    const probe = methodProbe;
    return PROBE_METHODS.filter((m) => probe.match(m, path)[0].length > 0);
  };
  app.notFound((c) => {
    const allow = allowedFor(c.req.path).filter((m) => m !== c.req.method);
    if (allow.length > 0) {
      return frameworkProblem(
        c,
        405,
        `method ${c.req.method} is not supported for ${c.req.path}`,
        { allow: allow.join(", ") },
      );
    }
    return frameworkProblem(c, 404, `no route for ${c.req.method} ${c.req.path}`);
  });
  app.onError((err, c) => {
    const trace_id = c.get("requestId") ?? "";
    const problem = (status: 403 | 404 | 409 | 422 | 500, title: string, detail: string) => c.body(JSON.stringify({ type: "about:blank", title, status, detail, instance: c.req.path }), status, { "content-type": "application/problem+json", "x-request-id": trace_id });
    if (err instanceof ForbiddenError) {
      baseLogger.warn({ event: "forbidden", message: err.message, status: 403 });
      recordDomainFault("forbidden");
      return problem(403, "Forbidden", err.message);
    }
    if (err instanceof DisallowedError) {
      baseLogger.warn({ event: "disallowed", message: err.message, status: 409 });
      recordDomainFault("disallowed");
      return problem(409, "Disallowed", err.message);
    }
    if (err instanceof DomainError) {
      baseLogger.warn({ event: "domain_error", message: err.message, status: 422 });
      recordDomainFault("domain_error");
      return problem(422, "Unprocessable Entity", err.message);
    }
    if (err instanceof AggregateNotFoundError) {
      baseLogger.warn({ event: "not_found", status: 404 });
      recordDomainFault("not_found");
      return problem(404, "Not Found", err.message);
    }
    if (err instanceof ConcurrencyError) {
      baseLogger.warn({ event: "conflict", message: err.message, status: 409 });
      recordDomainFault("conflict");
      return problem(409, "Conflict", err.message);
    }
    if (err instanceof ExternHandlerError) {
      baseLogger.error({ event: "extern_handler_threw", aggregate: err.aggName, op: err.opName, error: err.message });
      return problem(500, "Internal Server Error", "internal");
    }
    if (err instanceof HTTPException) {
      return frameworkProblem(c, err.status as ContentfulStatusCode, err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    baseLogger.error({ event: "internal_error", error: message, status: 500 });
    return frameworkProblem(c, 500, "internal");
  });
  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()
  // calls.  Diffed against the .NET-emitted /openapi.json by
  // the cross-platform contract check.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Generated API", version: "1.0.0" },
  });
  return app;
}
