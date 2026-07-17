import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// OTP / runtime shell files — the OTP Application supervisor, the JSON Logger
// formatter, the per-request context plug, and the LiveView nav on_mount hook.
// Consumed by `vanilla/shell-emit.ts`.
// ---------------------------------------------------------------------------

export function renderApplication(
  appName: string,
  appModule: string,
  // timerSource scheduling (scheduling.md, M-T4.1): the owned-timer GenServer
  // module names, appended to the supervision tree so each starts at boot
  // (after the Repo it locks against + the Endpoint).  Empty ⇒ byte-identical.
  schedulerChildren: string[] = [],
): string {
  // Catalog server-lifecycle events.  Same identities Hono + .NET
  // emit so a cross-backend dashboard pivots on one event name.
  //
  //   server_starting — top of Application.start/2 (children not yet
  //                     supervised; emit before so a Repo crash that
  //                     prevents start_link still surfaces the intent)
  //   server_listening — right after Supervisor.start_link succeeds
  //   server_shutdown — top of Application.stop/1 (BEAM shutting down)
  //   server_drained  — bottom of Application.stop/1 (children
  //                     already terminated by application controller)
  const startingCall = renderPhoenixLogCall("serverStarting", [
    { name: "port", valueExpr: "to_string(port)" },
    { name: "env", valueExpr: "to_string(env)" },
  ]);
  const listeningCall = renderPhoenixLogCall("serverListening", [
    { name: "port", valueExpr: "to_string(port)" },
  ]);
  const shutdownCall = renderPhoenixLogCall("serverShutdown", [
    { name: "signal", valueExpr: '"SIGTERM"' },
  ]);
  const drainedCall = renderPhoenixLogCall("serverDrained");
  void appName;

  return `# Auto-generated.
defmodule ${appModule}.Application do
  use Application
  require Logger

  @impl true
  def start(_type, _args) do
    port = Application.get_env(:${appName}, ${appModule}Web.Endpoint, [])[:http][:port] || System.get_env("PORT") || "4000"
    env = System.get_env("MIX_ENV") || "prod"
    ${startingCall}

    children = [
      ${appModule}.Repo,
      {Phoenix.PubSub, name: ${appModule}.PubSub},
      ${appModule}.Telemetry,
      ${appModule}Web.Endpoint${schedulerChildren.map((c) => `,\n      ${c}`).join("")}
    ]

    opts = [strategy: :one_for_one, name: ${appModule}.Supervisor]
    case Supervisor.start_link(children, opts) do
      {:ok, _pid} = ok ->
        ${listeningCall}
        ok
      other ->
        other
    end
  end

  @impl true
  def stop(_state) do
    ${shutdownCall}
    ${drainedCall}
    :ok
  end

  @impl true
  def config_change(changed, _new, removed) do
    ${appModule}Web.Endpoint.config_change(changed, removed)
    :ok
  end
end
`;
}

// ---------------------------------------------------------------------------
// JSON Logger formatter — sister to Hono's pino default and .NET's
// AddJsonConsole.  Renders one JSON line per log entry preserving:
//
//   - the envelope: ts, level, message
//   - the message string (the catalog `event_name` we pass as the
//     Logger.<level>(message, meta) first arg)
//   - all metadata keys (event, request_id, method, path, status,
//     duration_ms, workflow, aggregate, …) — drawn from the
//     `metadata: :all` config so the catalog identity always rides
//     the structured stream regardless of which call site emits it
//
// Defensive: catches its own exceptions + falls back to inspect/2
// so a misshapen log call never silently drops a line nor crashes
// the Logger handler.
// ---------------------------------------------------------------------------
export function renderLogFormatter(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.LogFormatter do
  @moduledoc false
  # Custom Logger formatter — one JSON object per line.  Wired up
  # from config/config.exs (config :logger, :default_formatter, ...).

  @doc """
  Render a Logger event as a single-line JSON object terminated by \\n.

  Called by Elixir's Logger backend with arity 4 per the
  Logger.Formatter protocol.
  """
  def format(level, message, timestamp, metadata) do
    base = %{
      ts: ts_to_iso(timestamp),
      level: to_string(level),
      message: IO.iodata_to_binary(message)
    }

    meta_map =
      metadata
      |> Enum.into(%{}, fn {k, v} -> {k, encode_val(v)} end)

    # Metadata takes precedence over the envelope so a user-set
    # \`event:\` overrides any incidental key clash.
    json = Jason.encode!(Map.merge(base, meta_map))
    [json, ?\\n]
  rescue
    _ ->
      [inspect({level, message, timestamp, metadata}), ?\\n]
  end

  defp ts_to_iso({{year, month, day}, {hour, minute, second, milli}}) do
    "#{pad(year, 4)}-#{pad(month)}-#{pad(day)}T#{pad(hour)}:#{pad(minute)}:#{pad(second)}.#{pad(milli, 3)}Z"
  end

  defp ts_to_iso(_), do: ""

  defp pad(n, width \\\\ 2), do: n |> to_string() |> String.pad_leading(width, "0")

  defp encode_val(v) when is_binary(v), do: v
  defp encode_val(v) when is_number(v), do: v
  defp encode_val(v) when is_boolean(v), do: v
  defp encode_val(v) when is_atom(v), do: to_string(v)
  defp encode_val(v) when is_list(v) or is_map(v), do: try_jsonable(v)
  defp encode_val(v), do: inspect(v)

  defp try_jsonable(v) do
    case Jason.encode(v) do
      {:ok, _} -> v
      _ -> inspect(v)
    end
  end
end
`;
}

/**
 * The ambient execution-context carrier for the Phoenix backend
 * (docs/architecture/request-context.md).  The BEAM has no AsyncLocal, so
 * the carrier rides `Logger.metadata` — per-process, and ride-along on every
 * structured log line for free.  A Plug at the HTTP edge (mounted right after
 * `Plug.RequestId`) mints/propagates the correlation id, captures the locale
 * and start time, and echoes `X-Correlation-Id`; the accessor functions let
 * non-HTTP code read the carrier without a `conn`.  Pure Plug + Logger.
 *
 * The carrier holds the request-stable tier (correlation id, locale, start
 * time) plus the root of the frame-local tier (a fresh `scope_id`, no parent).
 * The principal slice is carried as `actor_id` only — stamped by the Auth plug
 * after the verifier resolves the principal (so it never leaks the rest of the
 * principal onto the logs); the full principal stays on `conn.assigns`.
 * Per-dispatch child frames (chaining `parent_id` through a Mediator-style
 * pipeline) are deferred — the BEAM has no per-dispatch pipeline in the
 * generated app.
 *
 * Caveat: `Logger.metadata` does not propagate to spawned processes
 * (`Task.async` / Oban jobs) — a background job that needs the correlation id
 * must copy it into the child explicitly.
 */
export function renderRequestContext(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.RequestContext do
  @moduledoc """
  Ambient per-request execution context, carried in \`Logger.metadata\`.
  Established at the HTTP edge by this Plug; read elsewhere via the accessors.
  """
  @behaviour Plug
  import Plug.Conn

  @correlation_header "x-correlation-id"
  @request_id_header "x-request-id"

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    correlation_id = resolve_correlation_id(conn)

    # Frame-local tier: the root frame for this request gets a fresh scope id
    # and no parent (parity with .NET's OpenRoot / Hono's root frame).  Each
    # per-dispatch boundary (a workflow run, an event reactor) then opens a
    # child frame via \`with_child_frame/1\`, chaining parent_id to the caller's
    # scope.  scope_id rides every log line, so causality is greppable.
    Logger.metadata(
      correlation_id: correlation_id,
      scope_id: generate_id(),
      locale: resolve_locale(conn),
      started_at: System.system_time(:millisecond)
    )

    put_resp_header(conn, @correlation_header, correlation_id)
  end

  # Prefer the cross-backend X-Correlation-Id, then X-Request-Id, then the id
  # Plug.RequestId already established (it honoured X-Request-Id or minted),
  # else mint.  Never derived from a sampled trace id.
  defp resolve_correlation_id(conn) do
    first_header(conn, @correlation_header) ||
      first_header(conn, @request_id_header) ||
      Logger.metadata()[:request_id] ||
      generate_id()
  end

  defp resolve_locale(conn) do
    first_header(conn, "accept-language") || "en"
  end

  defp first_header(conn, name) do
    case get_req_header(conn, name) do
      [value | _] when value != "" -> value
      _ -> nil
    end
  end

  defp generate_id, do: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

  @doc "The correlation id for the current request, or nil outside a request."
  def correlation_id, do: Logger.metadata()[:correlation_id]

  @doc "The id of the current execution frame (the root frame for a request)."
  def scope_id, do: Logger.metadata()[:scope_id]

  @doc "The parent frame's id, or nil at the root frame."
  def parent_id, do: Logger.metadata()[:parent_id]

  @doc "The authenticated principal's id, or nil before auth has run (or when the deployable carries no auth).  Only the id is carried here, not the whole principal; the full principal lives on conn.assigns.current_user."
  def actor_id, do: Logger.metadata()[:actor_id]

  @doc ~S(The request locale from Accept-Language, defaulting to "en".)
  def locale, do: Logger.metadata()[:locale] || "en"

  @doc "Epoch milliseconds at request start, or nil outside a request."
  def started_at, do: Logger.metadata()[:started_at]

  @doc """
  Run \`fun\` inside a CHILD execution frame: a fresh scope_id whose parent_id
  chains to the caller's scope_id, restored on return (a per-dispatch boundary —
  a workflow, an event reactor — opens one so its audit / provenance rows record
  their call-structure position).  Outside a request (no current frame) \`fun\`
  runs unframed, so non-request callers pay nothing.  \`Logger.metadata\` is
  process-local, so the frame never leaks across a spawned Task — a fan-out
  branch that needs it must copy it explicitly.
  """
  def with_child_frame(fun) when is_function(fun, 0) do
    case Logger.metadata()[:scope_id] do
      nil ->
        fun.()

      parent_scope ->
        prev_parent = Logger.metadata()[:parent_id]
        Logger.metadata(scope_id: generate_id(), parent_id: parent_scope)

        try do
          fun.()
        after
          Logger.metadata(scope_id: parent_scope, parent_id: prev_parent)
        end
    end
  end
end
`;
}

/** lib/<app>_web/nav.ex — a Phoenix.LiveView `on_mount` hook that assigns
 *  `@current_path` on every LiveView in the `live_session`.  The app layout's
 *  `<.sidebar current_path={@current_path} />` reads it to mark the active
 *  link.  `attach_hook(:handle_params, …)` re-derives the path on every live
 *  navigation (not just first mount).  `assign_new` keeps the assign present
 *  before the first `handle_params` (e.g. the dead render), so the layout
 *  never references an unassigned `@current_path` — warnings-clean.
 *
 *  Only emitted when the deployable mounts a HEEx `ui:` (a JSON-API-only
 *  deployable has no `live_session`). */
export function renderLiveNav(appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.Nav do
  @moduledoc """
  Phoenix.LiveView \`on_mount\` hook that publishes the current request path
  as \`@current_path\` for every LiveView in the \`live_session\`.  The app
  layout's sidebar reads it to highlight the active navigation link.
  """

  import Phoenix.Component, only: [assign: 3, assign_new: 3]

  def on_mount(:default, _params, _session, socket) do
    socket =
      socket
      |> assign_new(:current_path, fn -> "/" end)
      |> Phoenix.LiveView.attach_hook(:save_current_path, :handle_params, fn _params, uri, socket ->
        {:cont, assign(socket, :current_path, URI.parse(uri).path || "/")}
      end)

    {:cont, socket}
  end
end
`;
}
