// ---------------------------------------------------------------------------
// Platform-neutral OpenTelemetry TRACING descriptor — the single source of
// truth for the span every generated backend opens per request and the ids
// it threads onto the log envelope.  Sister to `log-events.ts` (the log
// catalog) and `metrics.ts` (the Prometheus catalog): one neutral catalog
// pins the stable names; per-backend init modules + request seams consume
// it so a span/attribute/env name written once means the same thing on
// every deployable platform.
//
// The design (execution-context.md § "whether the observability layer later
// projects a frame onto an OTel span is its concern"): the execution-context
// backbone already mints a `correlationId` (request id) and a per-frame
// `scopeId`; TRACING *projects* that frame onto an OTel SERVER span — the
// carrier ids ride as span attributes, and the span's own `trace_id` /
// `span_id` ride BACK onto every request-scoped log line (joining the two id
// systems for log↔trace correlation).  The span is created on every request
// (so `trace_id` is always present on the logs) but only EXPORTED when an
// OTLP collector endpoint is configured — no endpoint, no export attempt, so
// a local `docker compose up` without the collector stays quiet and cheap.
//
// Stability: treat the attribute keys / env names / log-field names like a
// wire contract — additive changes are safe; renaming one breaks downstream
// trace queries + log↔trace joins and requires a consumer migration.  Same
// governance as the log + metric catalogs.
// ---------------------------------------------------------------------------

/** The env var every backend reads to decide whether to EXPORT spans.  When
 *  set (the compose stack points it at the bundled collector), a batch
 *  exporter is wired to `<endpoint>/v1/traces` (OTLP/HTTP).  When unset,
 *  spans are still created — so `trace_id` rides the logs — but never
 *  exported.  This is the standard OpenTelemetry env var, so an operator can
 *  repoint it at any OTLP-compatible backend (Jaeger, Tempo, an OTel
 *  Collector, a vendor endpoint) with no code change. */
export const OTEL_ENDPOINT_ENV = "OTEL_EXPORTER_OTLP_ENDPOINT";

/** The env var carrying the `service.name` resource attribute — the name a
 *  trace UI groups spans under.  Defaults to the deployable slug when unset;
 *  the compose/k8s wiring sets it explicitly per backend. */
export const OTEL_SERVICE_NAME_ENV = "OTEL_SERVICE_NAME";

/** Span attribute keys carrying the Loom execution-context ids onto the
 *  span, so a trace can be filtered/joined by the same ids the audit /
 *  provenance rows and the log lines use.  Namespaced under `loom.` to keep
 *  them clear of the OTel semantic-convention keys (`http.*`, `url.*`). */
export const SpanAttr = {
  /** The request's correlation id (== the log envelope's `request_id`). */
  correlationId: "loom.correlation_id",
  /** The frame's scope id (== the log envelope's `scope_id`, the audit /
   *  provenance join key). */
  scopeId: "loom.scope_id",
  /** The principal's id, once auth has run (omitted under no-auth). */
  actorId: "loom.actor_id",
} as const;

/** OTel HTTP semantic-convention attribute keys the server span carries, so
 *  a standard trace UI renders method / route / status without Loom-specific
 *  config.  Stable names from the OTel HTTP semantic conventions. */
export const HttpSpanAttr = {
  method: "http.request.method",
  route: "http.route",
  path: "url.path",
  statusCode: "http.response.status_code",
} as const;

/** Log-envelope field names for the span/trace ids the tracing layer stamps
 *  back onto every request-scoped log line (via the same per-backend
 *  ambient-carrier mechanism that already stamps `scope_id` — the pino
 *  `mixin`, .NET `BeginScope`, Java `MDC`, the Python contextvar formatter,
 *  Elixir `Logger.metadata`).  A dashboard can pivot from a slow
 *  `request_end` line straight to its trace. */
export const TraceLogField = {
  traceId: "trace_id",
  spanId: "span_id",
} as const;

/** The server span's name — `{METHOD} {route-template}`, the OTel HTTP
 *  server-span naming convention (low cardinality: route template, never the
 *  raw path with ids).  Backends build this at the request seam. */
export function serverSpanName(method: string, route: string): string {
  return `${method} ${route}`;
}

// ---------------------------------------------------------------------------
// Bundled dev collector (the batteries-included trace UI, sibling to the
// Prometheus collector the metrics wiring adds — see src/system/index.ts).
// Jaeger all-in-one accepts OTLP directly (gRPC :4317 / HTTP :4318) and ships
// a query UI, so `docker compose up` gives a running trace surface with zero
// setup — the trace twin of the Prometheus UI on :9090.
// ---------------------------------------------------------------------------
export const TRACE_COLLECTOR = {
  /** Compose service name + k8s-internal DNS name. */
  service: "jaeger",
  /** Pinned all-in-one image (OTLP-native; ships the query UI). */
  image: "jaegertracing/all-in-one:1.62.0",
  /** OTLP/HTTP ingest port — what `OTEL_EXPORTER_OTLP_ENDPOINT` targets. */
  otlpHttpPort: 4318,
  /** Query UI port (host-published, the trace twin of Prometheus' 9090). */
  uiPort: 16686,
} as const;

/** The OTLP endpoint URL a compose/k8s backend service uses to reach the
 *  bundled collector on the shared network. */
export function collectorEndpoint(): string {
  return `http://${TRACE_COLLECTOR.service}:${TRACE_COLLECTOR.otlpHttpPort}`;
}
