import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";
import type { ApiRoute } from "../api-emit.js";
import type { LiveRoute } from "../liveview-emit.js";

// ---------------------------------------------------------------------------
// OTP / runtime shell files — the Ecto repo, the OTP Application
// supervisor, the JSON Logger formatter, the Phoenix endpoint, and the
// router.  Consumed by `emitShellFiles` in ../shell-emit.ts.
// ---------------------------------------------------------------------------

export function renderRepo(appName: string, appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Repo do
  use AshPostgres.Repo, otp_app: :${appName}

  def installed_extensions do
    # \`ash-functions\` is required by Ash 3.x for fragment-style
    # validations (e.g. unique_constraint comparisons).  AshPostgres
    # ships the extension SQL — listing it here is enough for
    # \`mix ash.setup\` to install it.
    ["ash-functions", "uuid-ossp", "citext"]
  end

  # AshPostgres 2.x requires a min_pg_version/0 callback so it can
  # gate extension features per Postgres version.  Targeting 15 — the
  # oldest still-supported community release at the generator's
  # current cutoff.
  def min_pg_version do
    %Version{major: 15, minor: 0, patch: 0}
  end
end
`;
}

export function renderApplication(appName: string, appModule: string): string {
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
      ${appModule}Web.Endpoint
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
 * non-HTTP code read the carrier without a `conn`.  Foundation-neutral (pure
 * Plug + Logger), so the ash and vanilla endpoints emit the same module.
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
    # and no parent (parity with .NET's OpenRoot / Hono's root frame).  The
    # BEAM has no per-dispatch Mediator pipeline, so there is no child-frame
    # nesting yet — parent_id stays nil; a future per-dispatch slice would
    # chain it.  scope_id rides every log line, so causality is greppable.
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

  @doc "The parent frame's id, or nil at the root frame (no per-dispatch nesting yet)."
  def parent_id, do: Logger.metadata()[:parent_id]

  @doc "The authenticated principal's id, or nil before auth has run (or when the deployable carries no auth).  Only the id is carried here, not the whole principal; the full principal lives on conn.assigns.current_user."
  def actor_id, do: Logger.metadata()[:actor_id]

  @doc ~S(The request locale from Accept-Language, defaulting to "en".)
  def locale, do: Logger.metadata()[:locale] || "en"

  @doc "Epoch milliseconds at request start, or nil outside a request."
  def started_at, do: Logger.metadata()[:started_at]
end
`;
}

export function renderEndpoint(appName: string, appModule: string, embedReact = false): string {
  const webModule = `${appModule}Web`;
  // Embedded-React mode: the SPA bundle lands in `priv/static/app/`
  // (the React generator builds under `assets/` → `dist/`, which the
  // Dockerfile copies to `priv/static/app`).  Serve it from `/app`
  // alongside the existing LiveView static allowlist — a dedicated
  // `Plug.Static` so the SPA's own asset hashes don't have to join the
  // `~w(...)` allowlist.  No LiveView socket is needed (no live pages),
  // but keeping it is harmless and avoids a second endpoint variant.
  const spaStatic = embedReact
    ? `
  plug Plug.Static,
    at: "/app",
    from: {:${appName}, "priv/static/app"},
    gzip: false,
    only: ~w(assets index.html favicon.ico)
`
    : "";
  return `# Auto-generated.
defmodule ${webModule}.Endpoint do
  use Phoenix.Endpoint, otp_app: :${appName}

  @session_options [
    store: :cookie,
    key: "_${appName}_key",
    signing_salt: "loom-generated",
    same_site: "Lax"
  ]

  socket "/live", Phoenix.LiveView.Socket, websocket: [connect_info: [session: @session_options]]

  plug Plug.Static,
    at: "/",
    from: :${appName},
    gzip: false,
    only: ~w(assets fonts images favicon.ico robots.txt)
${spaStatic}

  if code_reloading? do
    plug Phoenix.CodeReloader
    plug Phoenix.Ecto.CheckRepoStatus, otp_app: :${appName}
  end

  plug Plug.RequestId
  plug ${appModule}.RequestContext
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug ${webModule}.Router
end
`;
}

export function renderRouter(
  appName: string,
  appModule: string,
  liveRoutes: LiveRoute[],
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  embedReact = false,
  oidc = false,
): string {
  void appName;
  const webModule = `${appModule}Web`;

  // LiveView page entries — strip the leading `<webModule>.` because
  // they're inside a `scope "/", <webModule>` block.
  const liveLines = liveRoutes
    .map((r) => {
      const local = r.liveModule.startsWith(`${webModule}.`)
        ? r.liveModule.slice(webModule.length + 1)
        : r.liveModule;
      return `      live ${JSON.stringify(r.route)}, ${local}`;
    })
    .join("\n");

  // When auth is enabled, wrap live routes in a live_session with on_mount.
  let liveScopeBody: string;
  if (authEnabled) {
    const inner = liveLines || `      # No pages declared in this deployable's ui: block.`;
    liveScopeBody = `
    live_session :default, on_mount: [${webModule}.LiveAuth] do
${inner}
    end`;
  } else {
    const flatLines = liveLines
      ? liveLines.replace(/^ {6}/gm, "    ")
      : `    # No pages declared in this deployable's ui: block.`;
    liveScopeBody = `\n${flatLines}`;
  }

  // API routes — emitApiControllers returns:
  //   - paths prefixed with `!root:` → outside `/api` scope (health / ready)
  //   - bare paths → inside `scope "/api"`
  const rootApiRoutes = apiRoutes.filter((r) => r.path.startsWith("!root:"));
  const scopedApiRoutes = apiRoutes.filter((r) => !r.path.startsWith("!root:"));
  const scopedLines = scopedApiRoutes
    .map((r) => `    ${r.method} ${JSON.stringify(r.path)}, ${r.controller}, ${r.action}`)
    .join("\n");
  const scopedBody =
    scopedLines || `    # No API routes — backend has no workflows / views or 'serves:' is empty.`;
  const rootLines = rootApiRoutes
    .map((r) => {
      const path = r.path.slice("!root:".length);
      return `  ${r.method} ${JSON.stringify(path)}, ${webModule}.${r.controller}, ${r.action}`;
    })
    .join("\n");

  // Auth plug line in the :api pipeline — only when auth is enabled.
  const authApiPlug = authEnabled ? `\n    plug ${webModule}.Auth` : "";

  // /auth/me session probe — emitted when auth is enabled.  Piped through
  // :api so the Auth plug verifies the principal first (the `auth: ui`
  // frontend guard reads this); parity with the Hono / .NET `/auth/me`.  Under
  // an `auth { oidc }` block the /auth/login|callback|logout redirect handshake
  // is added too (the Auth plug bypasses those three so they're reachable
  // without a verified principal).
  const handshakeRoutes = oidc
    ? `
    get "/login", AuthController, :login
    get "/callback", AuthController, :callback
    get "/logout", AuthController, :logout`
    : "";
  const authScope = authEnabled
    ? `
  scope "/auth", ${webModule} do
    pipe_through :api

    get "/me", AuthController, :me${handshakeRoutes}
  end
`
    : "";

  // Embedded-React SPA fallback (D-PHOENIX-SURFACE phase 6b): deep links
  // under `/app/*` are client-side routes, so serve the SPA's
  // `index.html` for any unmatched `/app` path — the Phoenix analogue
  // of .NET's `MapFallbackToFile("index.html")`.  `Plug.Static` (in the
  // endpoint) handles the real asset files first; this catch-all only
  // fires for routes the SPA owns.  In LiveView mode this block is
  // absent (live routes are explicit).
  const spaFallback = embedReact
    ? `
  scope "/app", ${webModule} do
    pipe_through :browser

    get "/*path", SpaController, :index
  end
`
    : "";

  return `# Auto-generated.
defmodule ${webModule}.Router do
  use ${webModule}, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {${webModule}.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]${authApiPlug}
  end

  scope "/", ${webModule} do
    pipe_through :browser
${liveScopeBody}
  end

  scope "/api", ${webModule} do
    pipe_through :api

${scopedBody}
  end
${authScope}${spaFallback}
${rootLines}
end
`;
}
