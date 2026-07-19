import { Metrics } from "../_obs/metrics.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Telemetry module emission for Phoenix LiveView.
//
// Phoenix's `Endpoint` already mounts `plug Plug.Telemetry,
// event_prefix: [:phoenix, :endpoint]`, which fires
// `[:phoenix, :endpoint, :start]` and `[:phoenix, :endpoint, :stop]` on every
// request.  This emitter renders a `<AppModule>.Telemetry` module that
// attaches handlers to those events and translates them into the neutral
// log-event catalog identity (`request_start` / `request_end`) — so the same
// envelope shape and `event:` key surface on the Phoenix backend as on
// Hono / .NET.
//
// Lifecycle:
//   The module is plugged into the application supervision tree
//   (between PubSub and Endpoint — see `renderApplication`) so handlers
//   attach before the first request is served.  Handlers are detached
//   first to make boot idempotent if the supervisor restarts.
// ---------------------------------------------------------------------------

export interface TelemetryEmitArgs {
  /** snake_case application name, e.g. "phoenix_app" — used for the
   *  handler-registry id so multiple Phoenix apps running in the same
   *  BEAM don't clobber each other's handlers. */
  appName: string;
  /** PascalCase module prefix, e.g. "PhoenixApp" */
  appModule: string;
}

/**
 * Emits the source for `lib/<app>/telemetry.ex`.  Endpoint events are
 * always-on infrastructure translated to the catalog's request envelope.
 */
export function renderTelemetry(args: TelemetryEmitArgs): string {
  const { appName, appModule } = args;
  const handlerId = `${appName}-telemetry-logger`;

  // Prometheus histogram buckets (seconds) from the neutral metric catalog,
  // rendered as an Elixir list for the distribution's reporter_options.
  const bucketList = (Metrics.httpRequestDurationSeconds.buckets ?? []).join(", ");
  const startCall = renderPhoenixLogCall("requestStart", [
    { name: "method", valueExpr: "conn.method" },
    { name: "path", valueExpr: "conn.request_path" },
  ]);
  const endCall = renderPhoenixLogCall("requestEnd", [
    { name: "method", valueExpr: "conn.method" },
    { name: "path", valueExpr: "conn.request_path" },
    { name: "status", valueExpr: "conn.status" },
    { name: "duration_ms", valueExpr: "duration_ms" },
  ]);

  return `# Auto-generated.
defmodule ${appModule}.Telemetry do
  @moduledoc """
  Observability bridge — attaches \`:telemetry\` handlers that translate
  Phoenix endpoint events into the neutral log-event catalog.

  Mounted in the application supervision tree; handlers attach in
  \`init/1\` and persist for the lifetime of the BEAM.  The Endpoint's
  \`plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]\` is the
  upstream emitter — no extra plug is needed.
  """

  use Supervisor
  import Telemetry.Metrics
  require Logger

  @handler_id "${handlerId}"

  def start_link(arg) do
    Supervisor.start_link(__MODULE__, arg, name: __MODULE__)
  end

  @impl true
  def init(_arg) do
    events = [
      [:phoenix, :endpoint, :start],
      [:phoenix, :endpoint, :stop]
    ]

    # Detach first so a supervisor restart re-attaches cleanly instead
    # of erroring with {:error, :already_exists}.
    _ = :telemetry.detach(@handler_id)
    :ok = :telemetry.attach_many(@handler_id, events, &__MODULE__.handle_event/4, nil)

    # The Prometheus aggregator listens to the same [:phoenix, :endpoint, :stop]
    # event as the log handler above and serves the exposition at GET /metrics
    # (<AppModule>Web.MetricsController -> TelemetryMetricsPrometheus.Core.scrape/0).
    children = [
      {TelemetryMetricsPrometheus.Core, metrics: metrics()}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  @doc """
  Prometheus HTTP metrics, catalog-driven (src/generator/_obs/metrics.ts).
  A counter and a duration histogram, both aggregated from the Phoenix
  endpoint's [:phoenix, :endpoint, :stop] telemetry event, labelled by the
  matched route TEMPLATE (not the raw path) so cardinality stays bounded.
  """
  def metrics do
    [
      counter("http.requests.total",
        event_name: [:phoenix, :endpoint, :stop],
        measurement: :duration,
        tags: [:method, :route, :status],
        tag_values: &__MODULE__.request_tags/1,
        description: "${Metrics.httpRequestsTotal.help}"
      ),
      distribution("http.request.duration.seconds",
        event_name: [:phoenix, :endpoint, :stop],
        measurement: :duration,
        unit: {:native, :second},
        reporter_options: [buckets: [${bucketList}]],
        tags: [:method, :route, :status],
        tag_values: &__MODULE__.request_tags/1,
        description: "${Metrics.httpRequestDurationSeconds.help}"
      ),
      # Business-level counters, fed by [:loom, :domain, :*] events the
      # controllers / ProblemDetails emit at the operation_invoked /
      # aggregate_created / fault seams — the declarative sibling of the
      # other backends' manual recordDomainOperation/recordDomainFault calls.
      counter("domain.operations.total",
        event_name: [:loom, :domain, :operation],
        measurement: :count,
        tags: [:aggregate, :op],
        description: "${Metrics.domainOperationsTotal.help}"
      ),
      counter("domain.faults.total",
        event_name: [:loom, :domain, :fault],
        measurement: :count,
        tags: [:kind],
        description: "${Metrics.domainFaultsTotal.help}"
      )
    ]
  end

  @doc false
  # Derives the {method, route, status} label set from a [:phoenix, :endpoint,
  # :stop] event's conn.  The route is the matched route template resolved via
  # Phoenix.Router.route_info, falling back to the raw request path.
  def request_tags(%{conn: conn}) do
    %{method: conn.method, route: route_template(conn), status: "#{conn.status}"}
  end

  def request_tags(_metadata), do: %{method: "", route: "", status: ""}

  defp route_template(conn) do
    case conn.private[:phoenix_router] do
      nil ->
        conn.request_path

      router ->
        case Phoenix.Router.route_info(router, conn.method, conn.request_path, conn.host) do
          %{route: route} -> route
          _ -> conn.request_path
        end
    end
  end

  @doc false
  def handle_event([:phoenix, :endpoint, :start], _measurements, %{conn: conn}, _config) do
    ${startCall}
  end

  def handle_event([:phoenix, :endpoint, :stop], measurements, %{conn: conn}, _config) do
    duration_ms = System.convert_time_unit(measurements.duration, :native, :millisecond)
    ${endCall}
  end

  # Catch-all so a future event addition doesn't crash the handler chain.
  def handle_event(_event, _measurements, _metadata, _config), do: :ok
end
`;
}
