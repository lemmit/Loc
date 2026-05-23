import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Telemetry module emission for Phoenix LiveView.
//
// Phoenix's `Endpoint` already mounts `plug Plug.Telemetry,
// event_prefix: [:phoenix, :endpoint]` (see `renderEndpoint` in index.ts),
// which fires `[:phoenix, :endpoint, :start]` and
// `[:phoenix, :endpoint, :stop]` on every request.  This emitter renders
// a `<AppModule>.Telemetry` module that attaches handlers to those events
// and translates them into the neutral log-event catalog identity
// (`request_start` / `request_end`) — so the same envelope shape and
// `event:` key surface on the Phoenix backend as on Hono / .NET.
//
// Why a separate module (and not a per-route plug):
//   `:telemetry` is the idiomatic Phoenix instrumentation seam.  The
//   Endpoint already emits the events; we observe — no DSL injection
//   into resources, no bolt-on `Plug.Logger` replacement, no per-route
//   wrappers.  Adding metrics reporters later is just more attachments.
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
 * Emits the source for `lib/<app>/telemetry.ex`.  Always-on infrastructure
 * (no `--trace` gate): `request_start` / `request_end` are info-level
 * envelope events on every backend.
 */
export function renderTelemetry(args: TelemetryEmitArgs): string {
  const { appName, appModule } = args;
  const handlerId = `${appName}-telemetry-logger`;

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

    Supervisor.init([], strategy: :one_for_one)
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
