// ---------------------------------------------------------------------------
// Platform-neutral metric catalog — the single source of truth for every
// Prometheus metric the generated backends expose at `GET /metrics`.
//
// This is the `wireShape`/`log-events.ts` pattern applied to metrics: one
// neutral catalog pins each metric's stable name, type, help text, label
// set, and (for histograms) bucket bounds; per-backend renderers consume
// it so a dashboard/alert/PromQL query written once works against every
// deployable platform.
//
// Each entry pins:
//   - the stable Prometheus metric `name` (what appears on the /metrics
//     exposition and in every PromQL query),
//   - its `type` (counter / histogram / gauge),
//   - the `help` line (the `# HELP` comment on the exposition),
//   - the `labels` it carries (the label keys — never high-cardinality
//     values like ids; route templates, not raw paths),
//   - `buckets` (seconds) for histograms only.
//
// Stability: treat the catalog like a wire contract — additive changes
// (new metrics, new optional labels) are safe; renaming a metric/label or
// changing a histogram's buckets breaks downstream dashboards + recording
// rules and requires a consumer migration.  Same governance as the log
// catalog.
// ---------------------------------------------------------------------------

export type MetricType = "counter" | "histogram" | "gauge";

export interface MetricDef {
  /** Stable Prometheus metric name — appears verbatim on the /metrics
   *  exposition and in every PromQL query. */
  name: string;
  type: MetricType;
  /** The `# HELP` line on the exposition. */
  help: string;
  /** Label keys carried on every sample.  Keep these low-cardinality —
   *  route templates (`/api/carts/:id`), never raw paths with ids. */
  labels: readonly string[];
  /** Histogram bucket upper bounds, in SECONDS.  Present on `histogram`
   *  entries only. */
  buckets?: readonly number[];
}

/** Default request-duration buckets (seconds).  Spans the sub-millisecond
 *  in-memory response up to a 10s slow request — the standard web-service
 *  latency spread, matching the buckets most Prometheus client libraries
 *  ship by default so cross-backend histograms stay directly comparable. */
export const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export const Metrics = {
  /** RED-metrics rate + errors: one counter, sliced by status, gives
   *  request rate (`rate(http_requests_total[1m])`) and error rate
   *  (`... {status=~"5.."}`). */
  httpRequestsTotal: {
    name: "http_requests_total",
    type: "counter",
    help: "Total HTTP requests handled, by method, route template, and status code.",
    labels: ["method", "route", "status"],
  },
  /** RED-metrics duration: the request-latency histogram.  Quantiles come
   *  from `histogram_quantile(0.95, sum(rate(..._bucket[5m])) by (le))`. */
  httpRequestDurationSeconds: {
    name: "http_request_duration_seconds",
    type: "histogram",
    help: "HTTP request duration in seconds, by method, route template, and status code.",
    labels: ["method", "route", "status"],
    buckets: HTTP_DURATION_BUCKETS,
  },
} as const satisfies Record<string, MetricDef>;

/** Lookup key for any catalog entry — used by per-backend renderers so a
 *  typo at a generator call site is a typecheck error, not a runtime
 *  missing-metric surprise. */
export type MetricKey = keyof typeof Metrics;
