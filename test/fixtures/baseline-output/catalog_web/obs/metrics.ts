// Auto-generated.
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

/** The Prometheus registry every metric registers into; serialized as
 *  the text exposition at `GET /metrics`.  Default process/runtime
 *  metrics (CPU, resident memory, event-loop lag, GC, open handles)
 *  are collected automatically — the baseline every dashboard wants
 *  before any app-specific metric. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

/** Total HTTP requests handled, by method, route template, and status code. */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests handled, by method, route template, and status code.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

/** HTTP request duration in seconds, by method, route template, and status code. */
export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, by method, route template, and status code.",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

/** Record one finished request against both HTTP metrics.  Called from
 *  the request-id middleware's `finally` block, alongside the
 *  `request_end` log line, so metrics + logs share one seam.  `route`
 *  is the matched route TEMPLATE (`/api/carts/*`), never the raw path —
 *  labelling by raw path would explode cardinality on every id. */
export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  const labels = { method, route, status: String(status) };
  httpRequestsTotal.inc(labels);
  httpRequestDurationSeconds.observe(labels, durationMs / 1000);
}
