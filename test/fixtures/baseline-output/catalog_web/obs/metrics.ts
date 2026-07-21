// Auto-generated.
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

/** The Prometheus registry every metric registers into; serialized as
 *  the text exposition at `GET /metrics`.  Default process/runtime
 *  metrics (CPU, resident memory, event-loop lag, GC, open handles)
 *  are collected automatically — the baseline every dashboard wants
 *  before any app-specific metric. */
export const registry = new Registry();
// The default collectors read Node's v8/process internals; in a
// browser-bundled runtime (the playground) those are stubbed, so guard
// the call and degrade to just the app metrics below rather than crash
// at module load.
try {
  collectDefaultMetrics({ register: registry });
} catch {
  // Non-Node runtime: default process/runtime metrics are unavailable.
}

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

/** Total domain operations invoked, by aggregate and operation. */
export const domainOperationsTotal = new Counter({
  name: "domain_operations_total",
  help: "Total domain operations invoked, by aggregate and operation.",
  labelNames: ["aggregate", "op"],
  registers: [registry],
});

/** Total recoverable domain faults, by kind. */
export const domainFaultsTotal = new Counter({
  name: "domain_faults_total",
  help: "Total recoverable domain faults, by kind.",
  labelNames: ["kind"],
  registers: [registry],
});

/** Count one invoked domain operation (a named operation, or an
 *  aggregate constructor as `op="create"`), by aggregate + op.  Called
 *  at the same seam as the `operation_invoked` / `aggregate_created`
 *  log lines. */
export function recordDomainOperation(aggregate: string, op: string): void {
  domainOperationsTotal.inc({ aggregate, op });
}

/** Count one recoverable domain fault, by kind (the catalog fault-event
 *  name).  Called from the router's onError, alongside the matching
 *  `domain_error` / `forbidden` / `not_found` / `conflict` / `disallowed`
 *  log line. */
export function recordDomainFault(kind: string): void {
  domainFaultsTotal.inc({ kind });
}
