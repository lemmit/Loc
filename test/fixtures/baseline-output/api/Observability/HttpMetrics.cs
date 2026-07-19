// Auto-generated.
using Prometheus;

namespace Api.Observability;

/// <summary>
/// Prometheus HTTP metrics, catalog-driven
/// (src/generator/_obs/metrics.ts).  Registered on the default registry
/// prometheus-net also fills with the default .NET runtime/process metrics;
/// served at GET /metrics via <c>app.MapMetrics()</c> in Program.cs.
/// </summary>
public static class HttpMetrics
{
    private static readonly Counter Requests = Prometheus.Metrics.CreateCounter(
        "http_requests_total",
        "Total HTTP requests handled, by method, route template, and status code.",
        new CounterConfiguration { LabelNames = new[] { "method", "route", "status" } });

    private static readonly Histogram Duration = Prometheus.Metrics.CreateHistogram(
        "http_request_duration_seconds",
        "HTTP request duration in seconds, by method, route template, and status code.",
        new HistogramConfiguration
        {
            LabelNames = new[] { "method", "route", "status" },
            Buckets = new[] { 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10 },
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
