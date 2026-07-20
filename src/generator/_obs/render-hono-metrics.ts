// ---------------------------------------------------------------------------
// Hono/prom-client renderer for the neutral metric catalog (see
// `./metrics.ts`).  Emits the `obs/metrics.ts` module the generated Hono
// backend serves at `GET /metrics` — one Prometheus registry, the default
// process/runtime collectors, and the catalog's HTTP metrics.
//
// prom-client is the de-facto standard for a Node service: the exposition
// format is native, `collectDefaultMetrics()` gives process CPU/memory,
// event-loop lag, and GC for free, and Counter/Histogram map 1:1 onto the
// catalog's types.  The metric names/help/labels/buckets are taken from
// the neutral catalog so the exposition stays byte-comparable with the
// future .NET/Phoenix/Java/Python renderers.
// ---------------------------------------------------------------------------

import { lines } from "../../util/code-builder.js";
import { Metrics } from "./metrics.js";

/** Render `obs/metrics.ts` — the prom-client registry, default metrics,
 *  and the catalog's HTTP counter + duration histogram, plus a
 *  `recordHttpRequest(...)` helper the request-id middleware calls in its
 *  `finally` block. */
export function renderHonoMetricsFile(): string {
  const reqTotal = Metrics.httpRequestsTotal;
  const reqDur = Metrics.httpRequestDurationSeconds;
  const domainOps = Metrics.domainOperationsTotal;
  const domainFaults = Metrics.domainFaultsTotal;
  const labelList = (labels: readonly string[]): string =>
    labels.map((l) => JSON.stringify(l)).join(", ");

  return (
    lines(
      "// Auto-generated.",
      'import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";',
      "",
      "/** The Prometheus registry every metric registers into; serialized as",
      " *  the text exposition at `GET /metrics`.  Default process/runtime",
      " *  metrics (CPU, resident memory, event-loop lag, GC, open handles)",
      " *  are collected automatically — the baseline every dashboard wants",
      " *  before any app-specific metric. */",
      "export const registry = new Registry();",
      "collectDefaultMetrics({ register: registry });",
      "",
      `/** ${reqTotal.help} */`,
      "export const httpRequestsTotal = new Counter({",
      `  name: ${JSON.stringify(reqTotal.name)},`,
      `  help: ${JSON.stringify(reqTotal.help)},`,
      `  labelNames: [${labelList(reqTotal.labels)}],`,
      "  registers: [registry],",
      "});",
      "",
      `/** ${reqDur.help} */`,
      "export const httpRequestDurationSeconds = new Histogram({",
      `  name: ${JSON.stringify(reqDur.name)},`,
      `  help: ${JSON.stringify(reqDur.help)},`,
      `  labelNames: [${labelList(reqDur.labels)}],`,
      `  buckets: [${(reqDur.buckets ?? []).join(", ")}],`,
      "  registers: [registry],",
      "});",
      "",
      "/** Record one finished request against both HTTP metrics.  Called from",
      " *  the request-id middleware's `finally` block, alongside the",
      " *  `request_end` log line, so metrics + logs share one seam.  `route`",
      " *  is the matched route TEMPLATE (`/api/carts/*`), never the raw path —",
      " *  labelling by raw path would explode cardinality on every id. */",
      "export function recordHttpRequest(",
      "  method: string,",
      "  route: string,",
      "  status: number,",
      "  durationMs: number,",
      "): void {",
      "  const labels = { method, route, status: String(status) };",
      "  httpRequestsTotal.inc(labels);",
      "  httpRequestDurationSeconds.observe(labels, durationMs / 1000);",
      "}",
      "",
      `/** ${domainOps.help} */`,
      "export const domainOperationsTotal = new Counter({",
      `  name: ${JSON.stringify(domainOps.name)},`,
      `  help: ${JSON.stringify(domainOps.help)},`,
      `  labelNames: [${labelList(domainOps.labels)}],`,
      "  registers: [registry],",
      "});",
      "",
      `/** ${domainFaults.help} */`,
      "export const domainFaultsTotal = new Counter({",
      `  name: ${JSON.stringify(domainFaults.name)},`,
      `  help: ${JSON.stringify(domainFaults.help)},`,
      `  labelNames: [${labelList(domainFaults.labels)}],`,
      "  registers: [registry],",
      "});",
      "",
      "/** Count one invoked domain operation (a named operation, or an",
      ' *  aggregate constructor as `op="create"`), by aggregate + op.  Called',
      " *  at the same seam as the `operation_invoked` / `aggregate_created`",
      " *  log lines. */",
      "export function recordDomainOperation(aggregate: string, op: string): void {",
      "  domainOperationsTotal.inc({ aggregate, op });",
      "}",
      "",
      "/** Count one recoverable domain fault, by kind (the catalog fault-event",
      " *  name).  Called from the router's onError, alongside the matching",
      " *  `domain_error` / `forbidden` / `not_found` / `conflict` / `disallowed`",
      " *  log line. */",
      "export function recordDomainFault(kind: string): void {",
      "  domainFaultsTotal.inc({ kind });",
      "}",
    ) + "\n"
  );
}
