import { Metrics } from "../../_obs/metrics.js";

// ---------------------------------------------------------------------------
// Prometheus HTTP metrics for the .NET backend — the catalog-driven sibling
// of Hono's `obs/metrics.ts` and Python's `app/obs/metrics.py`.
//
// prometheus-net is the de-facto Prometheus client for ASP.NET Core: its
// `Metrics.CreateCounter/CreateHistogram` register on the default registry,
// which the library also populates with the default .NET runtime + process
// metrics (`process_cpu_seconds_total`, `dotnet_*`, GC/threadpool), and
// `app.MapMetrics()` (wired in Program.cs) serves the whole registry as the
// text exposition at `/metrics`.
//
// The metric names/help/labels/buckets come from the neutral catalog
// (`src/generator/_obs/metrics.ts`) so the exposition matches the other
// backends.  `Record(...)` is called from RequestLoggingMiddleware's
// `finally` — the same seam as the `request_end` log line.
// ---------------------------------------------------------------------------

export function renderHttpMetrics(ns: string): string {
  const reqTotal = Metrics.httpRequestsTotal;
  const reqDur = Metrics.httpRequestDurationSeconds;
  const labelArray = (labels: readonly string[]): string =>
    labels.map((l) => JSON.stringify(l)).join(", ");
  const buckets = (reqDur.buckets ?? []).join(", ");

  return `// Auto-generated.
using Prometheus;

namespace ${ns}.Observability;

/// <summary>
/// Prometheus HTTP metrics, catalog-driven
/// (src/generator/_obs/metrics.ts).  Registered on the default registry
/// prometheus-net also fills with the default .NET runtime/process metrics;
/// served at GET /metrics via <c>app.MapMetrics()</c> in Program.cs.
/// </summary>
public static class HttpMetrics
{
    private static readonly Counter Requests = Prometheus.Metrics.CreateCounter(
        ${JSON.stringify(reqTotal.name)},
        ${JSON.stringify(reqTotal.help)},
        new CounterConfiguration { LabelNames = new[] { ${labelArray(reqTotal.labels)} } });

    private static readonly Histogram Duration = Prometheus.Metrics.CreateHistogram(
        ${JSON.stringify(reqDur.name)},
        ${JSON.stringify(reqDur.help)},
        new HistogramConfiguration
        {
            LabelNames = new[] { ${labelArray(reqDur.labels)} },
            Buckets = new[] { ${buckets} },
        });

    /// <summary>
    /// Record one finished request against both HTTP metrics — the same seam
    /// as the request_end log line.  <paramref name="route"/> is the matched
    /// route TEMPLATE (<c>api/carts/{id}</c>), never the raw path, so label
    /// cardinality stays bounded.
    /// </summary>
    public static void Record(string method, string route, int status, double durationMs)
    {
        var statusText = status.ToString(System.Globalization.CultureInfo.InvariantCulture);
        Requests.WithLabels(method, route, statusText).Inc();
        Duration.WithLabels(method, route, statusText).Observe(durationMs / 1000.0);
    }
}
`;
}
