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
// Under `--trace` (Bite 3), the same module additionally attaches to the
// Ash domain telemetry events Ash 3.x emits on every changeset path
// (https://hexdocs.pm/ash/monitoring.html):
//
//   [:ash, :validation, :stop]      → `invariant_evaluated` (passed: true)
//   [:ash, :validation, :exception] → `invariant_evaluated` (passed: false)
//   [:ash, :change, :stop]          → `value_computed`
//
// This is the deliberate design call for Ash's declarative DSL: no DSL
// injection, no per-resource wrappers — Ash emits its own telemetry,
// we observe and translate to catalog identity.
//
// Fidelity limitations (documented on the Ash side, not a Loom bug):
//   - The `expr` field is best-effort via `inspect(validation_struct)`;
//     Ash doesn't expose a printable expression on the telemetry payload.
//   - `value_computed.value` is left as `nil`; Ash's `[:ash, :change, :stop]`
//     event doesn't surface the computed attribute value.
//   - All validation events land on `invariant_evaluated` for now —
//     distinguishing action-scoped `precondition_evaluated` from
//     resource-scoped `invariant_evaluated` requires inspecting span
//     context that raw :telemetry doesn't carry; the catalog field
//     contract is preserved (`aggregate`, `op`, `expr`, `passed`) so a
//     later refinement is additive.
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
  /** Compile-time --trace switch.  When true, additional handlers attach
   *  to Ash's telemetry events ([:ash, :validation, …], [:ash, :change, …])
   *  and translate them to the catalog's trace-level domain events.  Off
   *  path output is byte-identical to the Bite 1 shape. */
  emitTrace?: boolean;
}

/**
 * Emits the source for `lib/<app>/telemetry.ex`.  Endpoint events are
 * always-on infrastructure; Ash domain events attach only under
 * `--trace` and stay off the structured stream in the default build.
 */
export function renderTelemetry(args: TelemetryEmitArgs): string {
  const { appName, appModule, emitTrace } = args;
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

  // Catalog renderer calls for the Ash trace handlers.  All call sites
  // pre-bind their values into local vars (resource, expr, …) so the
  // rendered Logger lines stay readable.
  const invariantPassedCall = renderPhoenixLogCall("invariantEvaluated", [
    { name: "aggregate", valueExpr: "aggregate" },
    { name: "op", valueExpr: "nil" },
    { name: "expr", valueExpr: "expr" },
    { name: "passed", valueExpr: "true" },
  ]);
  const invariantFailedCall = renderPhoenixLogCall("invariantEvaluated", [
    { name: "aggregate", valueExpr: "aggregate" },
    { name: "op", valueExpr: "nil" },
    { name: "expr", valueExpr: "expr" },
    { name: "passed", valueExpr: "false" },
  ]);
  const valueComputedCall = renderPhoenixLogCall("valueComputed", [
    { name: "aggregate", valueExpr: "aggregate" },
    { name: "field", valueExpr: "field" },
    { name: "value", valueExpr: "nil" },
  ]);

  // Under --trace, additional Ash event names are appended to the
  // attach_many subscription + extra handler clauses are emitted.
  const ashEventList = emitTrace
    ? `,
      [:ash, :validation, :stop],
      [:ash, :validation, :exception],
      [:ash, :change, :stop]`
    : "";

  const ashHandlers = emitTrace
    ? `

  # ---------------------------------------------------------------
  # Ash domain trace (gated at generate-time by --trace).
  #
  # Ash 3.x fires [:ash, :validation, :start/:stop/:exception] for
  # every validation it runs, [:ash, :change, :start/:stop] for every
  # change applied to a changeset.  See:
  #   https://hexdocs.pm/ash/monitoring.html
  #
  # Payload limitations (see telemetry-emit.ts header for the full
  # accounting): \`expr\` is inspect-of-struct (best-effort), \`value\`
  # is unavailable on change events, and the action vs resource
  # scope of a validation is not distinguishable from the telemetry
  # payload alone — all land on \`invariant_evaluated\` here.
  # ---------------------------------------------------------------
  def handle_event([:ash, :validation, :stop], _measurements, metadata, _config) do
    aggregate = to_string(Map.get(metadata, :resource_short_name, ""))
    expr = inspect(Map.get(metadata, :validation))
    ${invariantPassedCall}
  end

  def handle_event([:ash, :validation, :exception], _measurements, metadata, _config) do
    aggregate = to_string(Map.get(metadata, :resource_short_name, ""))
    expr = inspect(Map.get(metadata, :validation))
    ${invariantFailedCall}
  end

  def handle_event([:ash, :change, :stop], _measurements, metadata, _config) do
    aggregate = to_string(Map.get(metadata, :resource_short_name, ""))
    field = inspect(Map.get(metadata, :change))
    ${valueComputedCall}
  end`
    : "";

  return `# Auto-generated.
defmodule ${appModule}.Telemetry do
  @moduledoc """
  Observability bridge — attaches \`:telemetry\` handlers that translate
  Phoenix endpoint events into the neutral log-event catalog.

  Mounted in the application supervision tree; handlers attach in
  \`init/1\` and persist for the lifetime of the BEAM.  The Endpoint's
  \`plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]\` is the
  upstream emitter — no extra plug is needed.${
    emitTrace
      ? `

  Built with --trace: Ash 3.x domain events ([:ash, :validation, …],
  [:ash, :change, :stop]) are also subscribed; handlers translate them
  to the catalog's trace-level domain events (\`invariant_evaluated\` /
  \`value_computed\`).  See the telemetry-emit.ts header for the
  fidelity limitations of the translation.`
      : ""
  }
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
      [:phoenix, :endpoint, :stop]${ashEventList}
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
  end${ashHandlers}

  # Catch-all so a future event addition doesn't crash the handler chain.
  def handle_event(_event, _measurements, _metadata, _config), do: :ok
end
`;
}
