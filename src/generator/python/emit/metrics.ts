// ---------------------------------------------------------------------------
// Python/prometheus_client renderer for the neutral metric catalog (see
// `src/generator/_obs/metrics.ts`).  Emits `app/obs/metrics.py` — the
// module the generated FastAPI backend serves at `GET /metrics`.
//
// prometheus_client is the standard for a Python service: it auto-registers
// the process + platform + GC collectors on the default REGISTRY at import
// time (CPU, resident memory, open fds, Python GC), so the runtime baseline
// every dashboard wants comes for free, and Counter/Histogram map 1:1 onto
// the catalog's types.  Names/help/labels/buckets come from the neutral
// catalog so the exposition stays comparable with the other backends.
// ---------------------------------------------------------------------------

import { Metrics } from "../../_obs/metrics.js";
import { lines } from "../../../util/code-builder.js";

/** Render `app/obs/metrics.py` — the prometheus_client Counter + Histogram
 *  (default process/GC collectors ride the default REGISTRY automatically),
 *  a `record_http_request(...)` helper the observability middleware calls at
 *  the `request_end` seam, and `render_metrics()` for the route handler. */
export function renderPythonMetricsFile(): string {
  const reqTotal = Metrics.httpRequestsTotal;
  const reqDur = Metrics.httpRequestDurationSeconds;
  const labelTuple = (labels: readonly string[]): string =>
    labels.map((l) => JSON.stringify(l)).join(", ");
  const buckets = (reqDur.buckets ?? []).join(", ");

  return (
    lines(
      "# Auto-generated.",
      "from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest",
      "",
      "# prometheus_client registers the process, platform, and GC collectors",
      "# on the default REGISTRY at import time (process_cpu_seconds_total,",
      "# process_resident_memory_bytes, python_gc_*, python_info) — the runtime",
      "# baseline every dashboard wants before any app-specific metric.",
      "",
      `HTTP_REQUESTS_TOTAL = Counter(`,
      `    ${JSON.stringify(reqTotal.name)},`,
      `    ${JSON.stringify(reqTotal.help)},`,
      `    [${labelTuple(reqTotal.labels)}],`,
      `)`,
      "",
      `HTTP_REQUEST_DURATION_SECONDS = Histogram(`,
      `    ${JSON.stringify(reqDur.name)},`,
      `    ${JSON.stringify(reqDur.help)},`,
      `    [${labelTuple(reqDur.labels)}],`,
      `    buckets=(${buckets}),`,
      `)`,
      "",
      "",
      "def record_http_request(method: str, route: str, status: int, duration_ms: float) -> None:",
      '    """Record one finished request against both HTTP metrics.  Called from',
      "    the observability middleware at the same seam as the request_end log",
      "    line.  `route` is the matched route TEMPLATE (`/api/carts/{cart_id}`),",
      "    never the raw path — labelling by raw path would explode cardinality",
      '    on every id."""',
      "    labels = (method, route, str(status))",
      "    HTTP_REQUESTS_TOTAL.labels(*labels).inc()",
      "    HTTP_REQUEST_DURATION_SECONDS.labels(*labels).observe(duration_ms / 1000.0)",
      "",
      "",
      "def render_metrics() -> tuple[bytes, str]:",
      '    """The Prometheus text exposition + its content type, for GET /metrics."""',
      "    return generate_latest(), CONTENT_TYPE_LATEST",
    ) + "\n"
  );
}
