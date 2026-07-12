// ---------------------------------------------------------------------------
// Shell renderers — plain Phoenix + Ecto skeleton.  Slice 0 of
// vanilla-foundation-tdd-plan.md: emit a minimal project that
// `mix compile --warnings-as-errors` accepts.
// Slice 1: router now accepts per-aggregate routes spliced into /api.
// Observability: `renderApplication` / `renderLogFormatter` /
// `renderTelemetry` in `../shell/runtime.ts` + `../telemetry-emit.ts` are
// wired through here so the backend emits the same cross-backend log-event
// catalog (`server_starting` / `_listening` / `_shutdown` / `_drained` +
// `request_start` / `_end`) over the same JSON-per-line envelope as the
// Hono, .NET, Java, and Python backends.
// ---------------------------------------------------------------------------

import { AUTH_BASE_PATH } from "../../../util/api-base.js";
import type { ApiRoute } from "../api-emit.js";
import type { LiveRoute } from "../liveview-emit.js";
import {
  renderApplication,
  renderLiveNav,
  renderLogFormatter,
  renderRequestContext,
} from "../shell/runtime.js";
import {
  renderAppLayout,
  renderCoreComponents,
  renderLayouts,
  renderRootLayout,
} from "../shell/web.js";
import { renderTelemetry } from "../telemetry-emit.js";

export function emitVanillaShellFiles(
  appName: string,
  appModule: string,
  out: Map<string, string>,
  apiRoutes: ApiRoute[] = [],
  extraHexDeps: Record<string, string> = {},
  authEnabled = false,
  oidc = false,
  // LiveView spine — when the deployable mounts a HEEx `ui:`, these are the
  // `live "<route>", <Module>` entries spliced into a `live_session` and the
  // flag that turns on the live socket + browser pipeline + LiveView deps.
  // Empty / false ⇒ the byte-identical JSON-API-only shell (no live_view dep,
  // no browser pipeline, no layouts/CoreComponents/Nav).
  liveRoutes: LiveRoute[] = [],
  hasSidebar = false,
): void {
  const hasLiveView = liveRoutes.length > 0 || hasSidebar;
  out.set(
    "mix.exs",
    renderVanillaMixExs(appName, appModule, extraHexDeps, authEnabled && oidc, hasLiveView),
  );
  out.set(".formatter.exs", renderVanillaFormatterExs());
  // Application boot — shared renderer emits the catalog
  // `server_starting` / `server_listening` / `server_shutdown` /
  // `server_drained` events at the supervisor boundary.  Its children
  // list references `${appModule}.Repo`, `Phoenix.PubSub`,
  // `${appModule}.Telemetry`, `${appModule}Web.Endpoint` — vanilla
  // emits each of those (Telemetry is at lib/<app>/telemetry.ex,
  // not lib/<app>_web/telemetry.ex).
  out.set(`lib/${appName}/application.ex`, renderApplication(appName, appModule));
  out.set(`lib/${appName}/repo.ex`, renderVanillaRepo(appName, appModule));
  // Cross-backend log envelope — `<App>.LogFormatter` renders one JSON
  // line per Logger event preserving the catalog metadata (event,
  // request_id, method, path, status, duration_ms, …).  Wired into
  // `:logger`'s default formatter via config/config.exs.
  out.set(`lib/${appName}/log_formatter.ex`, renderLogFormatter(appModule));
  // Catalog `:telemetry` translator — attaches to Phoenix endpoint
  // events and emits `request_start` / `request_end` over the JSON
  // envelope.  `emitTrace: false` omits domain-trace handlers that would
  // reference `[:ash, …]` telemetry events the plain backend never raises.
  out.set(`lib/${appName}/telemetry.ex`, renderTelemetry({ appName, appModule }));
  // Ambient execution-context carrier (Logger.metadata) — the Plug is mounted
  // in the endpoint after Plug.RequestId.
  out.set(`lib/${appName}/request_context.ex`, renderRequestContext(appModule));
  out.set(`lib/${appName}_web.ex`, renderVanillaWebModule(appName, appModule, hasLiveView));
  out.set(`lib/${appName}_web/endpoint.ex`, renderVanillaEndpoint(appName, appModule, hasLiveView));
  out.set(
    `lib/${appName}_web/router.ex`,
    renderVanillaRouter(appModule, apiRoutes, authEnabled, oidc, liveRoutes),
  );
  // LiveView spine files — only when a HEEx `ui:` is mounted.  The
  // CoreComponents library + layouts (module + root/app HEEx) + the Nav
  // on_mount hook reuse the shared shell renderers.  Omitted on a
  // JSON-API-only deployable (no LiveView dep to support them).
  if (hasLiveView) {
    out.set(`lib/${appName}_web/components/core_components.ex`, renderCoreComponents(appModule));
    out.set(`lib/${appName}_web/components/layouts.ex`, renderLayouts(appName, appModule));
    out.set(`lib/${appName}_web/components/layouts/root.html.heex`, renderRootLayout(appName));
    out.set(
      `lib/${appName}_web/components/layouts/app.html.heex`,
      renderAppLayout(appModule, hasSidebar, authEnabled),
    );
    out.set(`lib/${appName}_web/nav.ex`, renderLiveNav(appModule));
  }
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
  oidc: boolean,
  hasLiveView: boolean,
): string {
  // LiveView dep — only when the deployable mounts a HEEx `ui:`.
  // `phoenix_html` is already in the base set; LiveView adds
  // `phoenix_live_view` (the `~H`/`live` runtime).  Pinned to `~> 1.0`.
  const liveViewDep = hasLiveView ? `,\n      {:phoenix_live_view, "~> 1.0"}` : "";
  // Resource-adapter hex deps (s3 → ex_aws_s3, rabbitmq → amqp, restApi →
  // req) ride alongside the core Phoenix/Ecto set.  Sorted for stable output.
  // Values already include the surrounding `"…"`.
  const extraBlock = Object.keys(extraHexDeps)
    .sort()
    .map((k) => `,\n      {:${k}, ${extraHexDeps[k]}}`)
    .join("");
  // The generated Auth plug verifies the Bearer JWT with JOSE and fetches the
  // issuer's JWKS over the built-in `:httpc` (`:inets`/`:ssl`) — added only when
  // an `auth { oidc }` block is present.
  const oidcDep = oidc ? `,\n      {:jose, "~> 1.11"}` : "";
  const oidcApps = oidc ? ", :inets, :ssl" : "";
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
      extra_applications: [:logger, :runtime_tools${oidcApps}]
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
      {:uuidv7, "~> 1.0"},
      {:plug_cowboy, "~> 2.6"},
      {:open_api_spex, "~> 3.0"}${liveViewDep}${extraBlock}${oidcDep}
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

function renderVanillaWebModule(_appName: string, appModule: string, hasLiveView: boolean): string {
  const webModule = `${appModule}Web`;
  // LiveView spine: a HEEx `ui:` needs the `:live_view` / `:html` /
  // `:component` quotes (each pulls in the `~H` sigil + CoreComponents +
  // verified routes), and the router quote must import
  // `Phoenix.LiveView.Router` so the `live` macro is in scope.  A JSON-API
  // -only deployable emits the minimal byte-identical web module instead.
  if (!hasLiveView) {
    return `# Auto-generated.
defmodule ${webModule} do
  @moduledoc """
  The entrypoint for defining the web interface.  Use the helpers to
  build controllers, routers, etc:

      use ${webModule}, :controller
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
  return `# Auto-generated.
defmodule ${webModule} do
  @moduledoc """
  The entrypoint for defining the web interface, such as controllers,
  components, and so on.  This can be used in your application as:

      use ${webModule}, :live_view

  """

  def live_view do
    quote do
      use Phoenix.LiveView, layout: {${webModule}.Layouts, :app}
      unquote(html_helpers())
    end
  end

  def live_component do
    quote do
      use Phoenix.LiveComponent
      unquote(html_helpers())
    end
  end

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
      import Phoenix.LiveView.Router
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: ${webModule}.Endpoint,
        router: ${webModule}.Router,
        statics: ~w(assets fonts images favicon.ico robots.txt)
    end
  end

  def component do
    quote do
      use Phoenix.Component
      unquote(html_helpers())
    end
  end

  def html do
    quote do
      use Phoenix.Component
      import Phoenix.Controller,
        only: [get_csrf_token: 0, view_module: 1, view_template: 1]
      unquote(html_helpers())
    end
  end

  defp html_helpers do
    quote do
      import Phoenix.HTML
      import ${webModule}.CoreComponents
      alias Phoenix.LiveView.JS
      unquote(verified_routes())
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
`;
}

function renderVanillaEndpoint(appName: string, appModule: string, hasLiveView: boolean): string {
  // LiveView spine: the live socket carries the WebSocket connection
  // (session forwarded so a future auth slice can read it), and
  // `Plug.Static` serves `priv/static` so the root layout's
  // `~p"/assets/app.css"` / `app.js` references resolve.  A JSON-API-only
  // deployable serves no static assets and mounts no live socket.
  const liveViewPlugs = hasLiveView
    ? `  socket "/live", Phoenix.LiveView.Socket, websocket: [connect_info: [session: @session_options]]

  plug Plug.Static,
    at: "/",
    from: :${appName},
    gzip: false,
    only: ~w(assets fonts images favicon.ico robots.txt)

`
    : "";
  return `# Auto-generated.
defmodule ${appModule}Web.Endpoint do
  use Phoenix.Endpoint, otp_app: :${appName}

  @session_options [
    store: :cookie,
    key: "_${appName}_key",
    signing_salt: "loom_dev",
    same_site: "Lax"
  ]

${liveViewPlugs}  plug Plug.RequestId
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

function renderVanillaRouter(
  appModule: string,
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  oidc: boolean,
  liveRoutes: LiveRoute[] = [],
): string {
  // Routes prefixed with `!root:` (e.g. the OpenAPI spec endpoint) sit OUTSIDE
  // the `/api` scope so they're served at the router root (cross-backend
  // alignment: every backend serves `/openapi.json`).  They still pipe through
  // `:api` for JSON content negotiation — the Auth plug there already bypasses
  // `/openapi.json`, so they stay reachable without a token.  Bare paths splice
  // into `scope "/api"` as before.
  const rootApiRoutes = apiRoutes.filter((r) => r.path.startsWith("!root:"));
  const scopedApiRoutes = apiRoutes.filter((r) => !r.path.startsWith("!root:"));
  const routeLines = scopedApiRoutes
    .map((r) => `    ${r.method} "${r.path}", ${r.controller}, ${r.action}`)
    .join("\n");
  const rootApiLines = rootApiRoutes
    .map((r) => {
      const path = r.path.slice("!root:".length);
      return `    ${r.method} "${path}", ${appModule}Web.${r.controller}, ${r.action}`;
    })
    .join("\n");
  const rootApiScope = rootApiLines
    ? `
  scope "/" do
    pipe_through :api
${rootApiLines}
  end
`
    : "";
  // LiveView spine: a `:browser` pipeline (session + live-flash + root
  // layout + CSRF/secure headers) and a `live_session :default` wrapping
  // the live routes so the `${appModule}Web.Nav` on_mount hook assigns
  // `@current_path` on every page (the sidebar reads it).  Live module
  // names strip the leading `${appModule}Web.` since they sit inside a
  // `scope "/", ${appModule}Web` block.  Emitted only when the deployable
  // mounts a HEEx `ui:`.
  const hasLiveView = liveRoutes.length > 0;
  const webModule = `${appModule}Web`;
  const liveLines = liveRoutes
    .map((r) => {
      const local = r.liveModule.startsWith(`${webModule}.`)
        ? r.liveModule.slice(webModule.length + 1)
        : r.liveModule;
      return `      live ${JSON.stringify(r.route)}, ${local}`;
    })
    .join("\n");
  const browserPipeline = hasLiveView
    ? `
  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {${webModule}.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end
`
    : "";
  const liveScope = hasLiveView
    ? `
  scope "/", ${webModule} do
    pipe_through :browser

    live_session :default, on_mount: [${webModule}.Nav] do
${liveLines}
    end
  end
`
    : "";
  // Auth plug in the :api pipeline — populates `conn.assigns.current_user` from
  // the Bearer JWT so principal (tenancy) filters can scope reads by the actor.
  const authApiPlug = authEnabled ? `\n    plug ${appModule}Web.Auth` : "";
  // `/api/auth/me` session probe (+ OIDC login/callback/logout handshake when an
  // `auth { oidc }` block is present).  Piped through :api so the Auth plug
  // verifies the principal first.
  const handshakeRoutes = oidc
    ? `
    get "/login", AuthController, :login
    get "/callback", AuthController, :callback
    get "/logout", AuthController, :logout`
    : "";
  const authScope = authEnabled
    ? `
  scope "${AUTH_BASE_PATH}", ${appModule}Web do
    pipe_through :api

    get "/me", AuthController, :me${handshakeRoutes}
  end
`
    : "";
  return `# Auto-generated.
defmodule ${appModule}Web.Router do
  use ${appModule}Web, :router
${browserPipeline}
  pipeline :api do
    plug :accepts, ["json"]${authApiPlug}
  end

  scope "/health" do
    get "/", ${appModule}Web.HealthController, :liveness
  end

  scope "/ready" do
    get "/", ${appModule}Web.HealthController, :readiness
  end
${rootApiScope}${liveScope}${authScope}
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
  Liveness and readiness probes — parity with the other backends and with
  the k8s chart, which probes /health for liveness and /ready for readiness.

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
