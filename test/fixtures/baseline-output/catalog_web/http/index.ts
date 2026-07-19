// Auto-generated.
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { requestIdMiddleware } from "../obs/request-id";
import { registry } from "../obs/metrics";
import { productRoutes } from "./product.routes";
import { ProductRepository } from "../db/repositories/product-repository";
import { customerRoutes } from "./customer.routes";
import { CustomerRepository } from "../db/repositories/customer-repository";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { type DomainEventDispatcher, NoopDomainEventDispatcher } from "../domain/events";

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
    (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").debug({ event: "health_ok", checks: ["liveness"] });
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
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").debug({ event: "health_ok", checks: ["readiness", "db"] });
      return c.json({ status: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").error({ event: "db_error", error: message });
      (c as unknown as { get(k: "log"): import("../obs/log").RequestLogger }).get("log").debug({ event: "health_degraded", checks: ["db"] });
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
  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()
  // calls.  Diffed against the .NET-emitted /openapi.json by
  // the cross-platform contract check.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Generated API", version: "1.0.0" },
  });
  return app;
}
