// Auto-generated.
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { requestIdMiddleware } from "../obs/request-id";
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
  // Permissive CORS so a generated React frontend on a different port
  // can reach the API in dev compose.  Pin http/index.ts in
  // .loomignore + tighten in production.
  app.use("*", cors());
  // Liveness probe — cheap, no I/O.  K8s livenessProbe / docker-compose
  // healthcheck use this to decide "is the process alive?".  A DB blip
  // must NOT mark the pod not-alive (that restarts the container);
  // DB-touching checks live on /ready instead.
  app.get("/health", (c) => c.json({ status: "ok" }));
  // Readiness probe — pings the DB.  K8s readinessProbe uses this to
  // decide "should I send traffic to this pod?".  Returns 503 with a
  // one-line cause when the DB is unreachable so operators see the
  // reason in the probe log instead of having to exec into the pod.
  app.get("/ready", async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ready" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ status: "not_ready", error: message }, 503);
    }
  });
  app.route("/products", productRoutes(new ProductRepository(db, events)));
  app.route("/customers", customerRoutes(new CustomerRepository(db, events)));
  // OpenAPI 3.1 spec assembled from every sub-router's createRoute()
  // calls.  Diffed against the .NET-emitted /swagger/v1/swagger.json by
  // the cross-platform contract check.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: { title: "Generated API", version: "1.0.0" },
  });
  return app;
}
