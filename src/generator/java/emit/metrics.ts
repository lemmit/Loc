import { lines } from "../../../util/code-builder.js";
import { Metrics } from "../../_obs/metrics.js";

// ---------------------------------------------------------------------------
// Prometheus HTTP metrics for the Java/Spring Boot backend — the
// catalog-driven sibling of Hono's `obs/metrics.ts`, Python's
// `app/obs/metrics.py`, and .NET's `Observability/HttpMetrics.cs`.
//
// Micrometer is the Spring-native metrics facade: Actuator (added to the
// build) auto-binds the JVM/process meters and a PrometheusMeterRegistry,
// and exposes the exposition — remapped to `/metrics` in application.yml.
// This component registers the catalog's HTTP counter + timer against the
// injected MeterRegistry so the two app metrics carry the neutral names
// (`http_requests_total`, `http_request_duration_seconds`) every backend
// shares.  Micrometer's Prometheus naming maps the counter `http.requests`
// → `http_requests_total` and the timer `http.request.duration` (base unit
// seconds) → `http_request_duration_seconds_{bucket,count,sum}`.
//
// `record(...)` is called from RequestCatalogFilter's `finally` — the same
// seam as the `request_end` log line.
// ---------------------------------------------------------------------------

/** The timer's SLO boundaries, mirroring the neutral catalog's second-valued
 *  histogram buckets as `Duration.ofNanos(...)` (exact, no float rounding
 *  surprises) so the emitted `_bucket{le=...}` series match the other
 *  backends. */
function sloDurations(): string {
  const buckets = Metrics.httpRequestDurationSeconds.buckets ?? [];
  return buckets.map((s) => `Duration.ofNanos(${Math.round(s * 1e9)}L)`).join(", ");
}

export function renderHttpMetrics(basePkg: string): string {
  const reqTotal = Metrics.httpRequestsTotal;
  const reqDur = Metrics.httpRequestDurationSeconds;
  const domainOps = Metrics.domainOperationsTotal;
  const domainFaults = Metrics.domainFaultsTotal;
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import java.time.Duration;`,
    ``,
    `import org.springframework.stereotype.Component;`,
    ``,
    `import io.micrometer.core.instrument.Counter;`,
    `import io.micrometer.core.instrument.MeterRegistry;`,
    `import io.micrometer.core.instrument.Timer;`,
    ``,
    `/** Prometheus HTTP metrics, catalog-driven (src/generator/_obs/metrics.ts).`,
    ` *  Micrometer meters registered against the Actuator-provided registry;`,
    ` *  served at GET /metrics.  Recorded from RequestCatalogFilter's`,
    ` *  request_end seam, labelled by the matched route TEMPLATE (not the raw`,
    ` *  path) so cardinality stays bounded. */`,
    `@Component`,
    `public class HttpMetrics {`,
    `    private final MeterRegistry registry;`,
    ``,
    `    public HttpMetrics(MeterRegistry registry) {`,
    `        this.registry = registry;`,
    `    }`,
    ``,
    `    public void record(String method, String route, int status, double durationMs) {`,
    `        String statusText = Integer.toString(status);`,
    // Counter "http.requests" -> Prometheus "http_requests_total".
    `        Counter.builder("http.requests")`,
    `            .description(${JSON.stringify(reqTotal.help)})`,
    `            .tag("method", method)`,
    `            .tag("route", route)`,
    `            .tag("status", statusText)`,
    `            .register(registry)`,
    `            .increment();`,
    // Timer "http.request.duration" -> "http_request_duration_seconds".
    `        Timer.builder("http.request.duration")`,
    `            .description(${JSON.stringify(reqDur.help)})`,
    `            .tag("method", method)`,
    `            .tag("route", route)`,
    `            .tag("status", statusText)`,
    `            .serviceLevelObjectives(${sloDurations()})`,
    `            .register(registry)`,
    `            .record(Duration.ofNanos((long) (durationMs * 1_000_000.0)));`,
    `    }`,
    ``,
    `    /** Count one invoked domain operation (a named operation, or an aggregate`,
    ` *  constructor as op="create"), at the operation_invoked / aggregate_created`,
    ` *  seam.  Counter "domain.operations" -> "${domainOps.name}". */`,
    `    public void recordDomainOperation(String aggregate, String op) {`,
    `        Counter.builder("domain.operations")`,
    `            .description(${JSON.stringify(domainOps.help)})`,
    `            .tag("aggregate", aggregate)`,
    `            .tag("op", op)`,
    `            .register(registry)`,
    `            .increment();`,
    `    }`,
    ``,
    `    /** Count one recoverable domain fault by kind, at the ApiExceptionAdvice`,
    ` *  seam alongside the matching fault log line.`,
    ` *  Counter "domain.faults" -> "${domainFaults.name}". */`,
    `    public void recordDomainFault(String kind) {`,
    `        Counter.builder("domain.faults")`,
    `            .description(${JSON.stringify(domainFaults.help)})`,
    `            .tag("kind", kind)`,
    `            .register(registry)`,
    `            .increment();`,
    `    }`,
    `}`,
    ``,
  );
}
