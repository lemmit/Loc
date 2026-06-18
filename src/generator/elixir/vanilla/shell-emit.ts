// ---------------------------------------------------------------------------
// Vanilla shell renderers — plain Phoenix + Ecto skeleton.  No Ash deps,
// no AshPhoenix, no AshPostgres.  Slice 0 of vanilla-foundation-tdd-plan.md:
// emit a minimal project that `mix compile --warnings-as-errors` accepts.
// Slice 1: router now accepts per-aggregate routes spliced into /api.
// Observability port (parity with the Ash shell): the foundation-
// agnostic `renderApplication` / `renderLogFormatter` / `renderTelemetry`
// in `../shell/runtime.ts` + `../telemetry-emit.ts` are now wired through
// here so vanilla emits the same cross-backend log-event catalog
// (`server_starting` / `_listening` / `_shutdown` / `_drained` +
// `request_start` / `_end`) over the same JSON-per-line envelope as the
// Ash, Hono, .NET, Java, and Python backends.
// ---------------------------------------------------------------------------

import type { ApiRoute } from "../api-emit.js";
import { renderApplication, renderLogFormatter, renderRequestContext } from "../shell/runtime.js";
import { renderTelemetry } from "../telemetry-emit.js";

export function emitVanillaShellFiles(
  appName: string,
  appModule: string,
  out: Map<string, string>,
  apiRoutes: ApiRoute[] = [],
  extraHexDeps: Record<string, string> = {},
): void {
  out.set("mix.exs", renderVanillaMixExs(appName, appModule, extraHexDeps));
  out.set(".formatter.exs", renderVanillaFormatterExs());
  // Application boot — shared renderer emits the catalog
  // `server_starting` / `server_listening` / `server_shutdown` /
  // `server_drained` events at the supervisor boundary.  Its children
  // list references `${appModule}.Repo`, `Phoenix.PubSub`,
  // `${appModule}.Telemetry`, `${appModule}Web.Endpoint` — vanilla
  // emits each of those (Telemetry is now at lib/<app>/telemetry.ex,
  // not lib/<app>_web/telemetry.ex, matching the Ash convention so a
  // single `renderApplication` works for both foundations).
  out.set(`lib/${appName}/application.ex`, renderApplication(appName, appModule));
  out.set(`lib/${appName}/repo.ex`, renderVanillaRepo(appName, appModule));
  // Cross-backend log envelope — `<App>.LogFormatter` renders one JSON
  // line per Logger event preserving the catalog metadata (event,
  // request_id, method, path, status, duration_ms, …).  Wired into
  // `:logger`'s default formatter via config/config.exs.
  out.set(`lib/${appName}/log_formatter.ex`, renderLogFormatter(appModule));
  // Catalog `:telemetry` translator — attaches to Phoenix endpoint
  // events and emits `request_start` / `request_end` over the JSON
  // envelope.  `emitTrace: false` keeps the Ash domain-trace handlers
  // off vanilla (they reference `[:ash, …]` events vanilla never raises).
  out.set(`lib/${appName}/telemetry.ex`, renderTelemetry({ appName, appModule, emitTrace: false }));
  // Ambient execution-context carrier (Logger.metadata) — the Plug is mounted
  // in the endpoint after Plug.RequestId; shared with the ash foundation.
  out.set(`lib/${appName}/request_context.ex`, renderRequestContext(appModule));
  out.set(`lib/${appName}_web.ex`, renderVanillaWebModule(appName, appModule));
  out.set(`lib/${appName}_web/endpoint.ex`, renderVanillaEndpoint(appName, appModule));
  out.set(`lib/${appName}_web/router.ex`, renderVanillaRouter(appModule, apiRoutes));
  out.set(`lib/${appName}_web/controllers/error_json.ex`, renderVanillaErrorJson(appModule));
  out.set(
    `lib/${appName}_web/controllers/health_controller.ex`,
    renderVanillaHealthController(appModule),
  );
  out.set("config/config.exs", renderVanillaConfig(appName, appModule));
  out.set("config/dev.exs", renderVanillaDev(appName, appModule));
  out.set("config/prod.exs", renderVanillaProd(appName, appModule));
  out.set("config/runtime.exs", renderVanillaRuntime(appName, appModule));
  out.set("config/test.exs", renderVanillaTest(appName, appModule));
}

function renderVanillaMixExs(
  appName: string,
  appModule: string,
  extraHexDeps: Record<string, string>,
): string {
  // Resource-adapter hex deps (s3 → ex_aws_s3, rabbitmq → amqp, restApi →
  // req) ride alongside the core Phoenix/Ecto set.  Sorted for stable output.
  // Values already include the surrounding `"…"` (matching the Ash
  // precedent in `shell/project.ts:renderMixExs`).
  const extraBlock = Object.keys(extraHexDeps)
    .sort()
    .map((k) => `,\n      {:${k}, ${extraHexDeps[k]}}`)
    .join("");
  return `# Auto-generated.
defmodule ${appModule}.MixProject do
  use Mix.Project

  def project do
    [
      app: :${appName},
      version: "0.1.0",
      elixir: "~> 1.16",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps()
    ]
  end

  def application do
    [
      mod: {${appModule}.Application, []},
      extra_applications: [:logger, :runtime_tools]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:phoenix, "~> 1.8"},
      {:phoenix_ecto, "~> 4.4"},
      {:ecto_sql, "~> 3.10"},
      {:postgrex, "~> 0.20"},
      {:phoenix_html, "~> 4.1"},
      {:jason, "~> 1.4"},
      {:plug_cowboy, "~> 2.6"}${extraBlock}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.setup"],
      "ecto.setup": ["ecto.create", "ecto.migrate"],
      "ecto.reset": ["ecto.drop", "ecto.setup"]
    ]
  end
end
`;
}

function renderVanillaFormatterExs(): string {
  return `[
  import_deps: [:ecto, :ecto_sql, :phoenix],
  inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]
]
`;
}

function renderVanillaRepo(appName: string, appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}.Repo do
  use Ecto.Repo,
    otp_app: :${appName},
    adapter: Ecto.Adapters.Postgres
end
`;
}

function renderVanillaWebModule(_appName: string, appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web do
  @moduledoc """
  The entrypoint for defining the web interface.  Use the helpers to
  build controllers, routers, etc:

      use ${appModule}Web, :controller
  """

  def controller do
    quote do
      use Phoenix.Controller, formats: [:json]
      import Plug.Conn
    end
  end

  def router do
    quote do
      use Phoenix.Router
      import Plug.Conn
      import Phoenix.Controller
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
`;
}

function renderVanillaEndpoint(appName: string, appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.Endpoint do
  use Phoenix.Endpoint, otp_app: :${appName}

  @session_options [
    store: :cookie,
    key: "_${appName}_key",
    signing_salt: "loom_dev",
    same_site: "Lax"
  ]

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
  plug ${appModule}Web.Router
end
`;
}

function renderVanillaRouter(appModule: string, apiRoutes: ApiRoute[]): string {
  const routeLines = apiRoutes
    .map((r) => `    ${r.method} "${r.path}", ${r.controller}, ${r.action}`)
    .join("\n");
  return `# Auto-generated.
defmodule ${appModule}Web.Router do
  use ${appModule}Web, :router

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/health" do
    get "/", ${appModule}Web.HealthController, :liveness
  end

  scope "/ready" do
    get "/", ${appModule}Web.HealthController, :readiness
  end

  scope "/api", ${appModule}Web do
    pipe_through :api
${routeLines}
  end
end
`;
}

function renderVanillaHealthController(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.HealthController do
  use ${appModule}Web, :controller

  @moduledoc """
  Liveness and readiness probes — parity with the Ash foundation and the other
  backends, and with the k8s chart, which probes /health for liveness and
  /ready for readiness.

  GET /health — cheap liveness check; always 200 while the BEAM is running.
  GET /ready  — DB-aware readiness check; 503 when the database is unreachable.
  """

  @doc "GET /health — liveness probe (no DB dependency)."
  def liveness(conn, _params) do
    json(conn, %{status: "ok"})
  end

  @doc "GET /ready — readiness probe (pings the database via Ecto)."
  def readiness(conn, _params) do
    try do
      Ecto.Adapters.SQL.query!(${appModule}.Repo, "SELECT 1", [])
      json(conn, %{status: "ready"})
    rescue
      _ ->
        conn
        |> put_status(:service_unavailable)
        |> json(%{status: "not_ready"})
    end
  end
end
`;
}

function renderVanillaErrorJson(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorJSON do
  def render(template, _assigns) do
    %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
  end
end
`;
}

function renderVanillaConfig(appName: string, appModule: string): string {
  return `import Config

config :${appName},
  ecto_repos: [${appModule}.Repo],
  generators: [timestamp_type: :utc_datetime]

config :${appName}, ${appModule}Web.Endpoint,
  url: [host: "localhost"],
  adapter: Phoenix.Endpoint.Cowboy2Adapter,
  render_errors: [
    formats: [json: ${appModule}Web.ErrorJSON],
    layout: false
  ],
  pubsub_server: ${appModule}.PubSub,
  live_view: [signing_salt: "loom_dev"]

config :phoenix, :json_library, Jason

# JSON Logger formatter — emits one structured JSON object per line so
# the cross-backend observability catalog envelope (event, request_id,
# method, path, status, duration_ms, …) is parseable upstream the same
# way Hono's pino and .NET's AddJsonConsole emit.  See
# lib/${appName}/log_formatter.ex.
config :logger, :default_formatter,
  format: {${appModule}.LogFormatter, :format},
  metadata: :all

import_config "#{config_env()}.exs"
`;
}

function renderVanillaDev(appName: string, appModule: string): string {
  return `import Config

# Honor DATABASE_URL when set (containerized dev + e2e harnesses point
# the app at a provisioned database / port), otherwise fall back to the
# local default.  Ecto rejects mixing \`url:\` with discrete host/database
# options, so exactly one branch configures the repo.
if url = System.get_env("DATABASE_URL") do
  config :${appName}, ${appModule}.Repo,
    url: url,
    show_sensitive_data_on_connection_error: true,
    pool_size: 10
else
  config :${appName}, ${appModule}.Repo,
    username: "postgres",
    password: "postgres",
    hostname: "localhost",
    database: "${appName}_dev",
    show_sensitive_data_on_connection_error: true,
    pool_size: 10
end

config :${appName}, ${appModule}Web.Endpoint,
  # PORT env var overrides the dev default so test harnesses + parallel
  # dev workflows can avoid port collisions without editing this file.
  http: [ip: {127, 0, 0, 1}, port: String.to_integer(System.get_env("PORT") || "4000")],
  check_origin: false,
  debug_errors: true,
  secret_key_base: "ZqJBpdEaAxQpgK0d63NydhxsP2VrZLgJ6mhJrShdWf6mYLRVy6Iuc1FdN5lW9bz9"
`;
}

function renderVanillaProd(appName: string, appModule: string): string {
  return `import Config

# Start the Phoenix endpoint's HTTP server in a release (a \`mix release\`
# doesn't run \`mix phx.server\`, so without this the released container boots
# but never listens — and the k8s readiness probe never passes).
config :${appName}, ${appModule}Web.Endpoint, server: true

# The database url and secret key base are read at runtime from environment
# variables via config/runtime.exs.
`;
}

function renderVanillaRuntime(appName: string, appModule: string): string {
  return `import Config

if config_env() == :prod do
  database_url =
    System.get_env("DATABASE_URL") ||
      raise """
      environment variable DATABASE_URL is missing.
      For example: ecto://USER:PASS@HOST/DATABASE
      """

  config :${appName}, ${appModule}.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10")

  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      """

  host = System.get_env("PHX_HOST") || "example.com"
  port = String.to_integer(System.get_env("PORT") || "4000")

  config :${appName}, ${appModule}Web.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [
      ip: {0, 0, 0, 0, 0, 0, 0, 0},
      port: port
    ],
    secret_key_base: secret_key_base
end
`;
}

function renderVanillaTest(appName: string, appModule: string): string {
  return `import Config

config :${appName}, ${appModule}.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "${appName}_test#{System.get_env("MIX_TEST_PARTITION")}",
  pool: Ecto.Adapters.SQL.Sandbox,
  pool_size: 10

config :${appName}, ${appModule}Web.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "ZqJBpdEaAxQpgK0d63NydhxsP2VrZLgJ6mhJrShdWf6mYLRVy6Iuc1FdN5lW9bz9",
  server: false

config :logger, level: :warning

config :phoenix, :plug_init_mode, :runtime
`;
}
