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
import { renderObanConfig } from "./scheduler-emit.js";

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
  // Embedded-SPA host (`hosts:` a React/Vue/Svelte ui): the endpoint serves the
  // built bundle from `priv/static/app` at `/app` via Plug.Static and the
  // router adds the `/app/*` client-side deep-link fallback (→ index.html) plus
  // a `/` → `/app` redirect, both through a minimal `SpaController`.  False ⇒
  // the byte-identical shell (no SPA static plug, no fallback).  Mutually
  // exclusive with LiveView (an embedded-SPA deployable emits no HEEx pages).
  hasEmbeddedSpa = false,
  // timerSource scheduling (scheduling.md, M-T4.1): the owned-timer supervision
  // children (Oban first when present, then the timer GenServer module names),
  // appended to the supervision tree in `renderApplication`.  Empty ⇒
  // byte-identical.
  schedulerChildren: string[] = [],
  // Durable-timer (cron:) support: adds the Oban config block to config.exs.
  usesOban = false,
  // OIDC JWKS strategy child(ren) — started BEFORE the Endpoint so a
  // `first_fetch_sync` fetch warms the signer cache before `/health` serves.
  preEndpointChildren: string[] = [],
): void {
  const hasLiveView = liveRoutes.length > 0 || hasSidebar;
  // Swoosh boots its default API client (Hackney) when the `:swoosh`
  // application starts — even for the SMTP adapter, which sends through
  // gen_smtp and needs no HTTP client.  The smtp mailer pulls `swoosh` +
  // `gen_smtp` but NOT `hackney`, so left alone the app crashes at boot with
  // "missing hackney dependency".  When Swoosh is present with no HTTP adapter
  // (ses/sendgrid pull `hackney`), disable the api_client so `:swoosh` starts.
  const swooshSmtpOnly = "swoosh" in extraHexDeps && !("hackney" in extraHexDeps);
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
  out.set(
    `lib/${appName}/application.ex`,
    renderApplication(appName, appModule, schedulerChildren, preEndpointChildren),
  );
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
  out.set(
    `lib/${appName}_web/endpoint.ex`,
    renderVanillaEndpoint(appName, appModule, hasLiveView, hasEmbeddedSpa),
  );
  out.set(
    `lib/${appName}_web/router.ex`,
    renderVanillaRouter(appModule, apiRoutes, authEnabled, oidc, liveRoutes, hasEmbeddedSpa),
  );
  // Embedded-SPA fallback controller — serves the built `priv/static/app/
  // index.html` for `/app` deep-links (Plug.Static handles real asset files
  // first) and redirects `/` → `/app`.  Emitted only for a `hosts:` deployable.
  if (hasEmbeddedSpa) {
    out.set(
      `lib/${appName}_web/controllers/spa_controller.ex`,
      renderVanillaSpaController(appName, appModule),
    );
  }
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
  out.set(
    `lib/${appName}_web/controllers/metrics_controller.ex`,
    renderVanillaMetricsController(appModule),
  );
  out.set(
    "config/config.exs",
    renderVanillaConfig(appName, appModule, swooshSmtpOnly, usesOban, authEnabled && oidc),
  );
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
  // The generated Auth plug verifies the Bearer JWT with the idiomatic `joken`
  // + `joken_jwks` libraries (the Elixir analogue of jose createRemoteJWKSet /
  // Nimbus / PyJWKClient / ConfigurationManager): joken_jwks owns the cached,
  // periodically-refreshed JWKS keyed by `kid`.  The OIDC discovery + token
  // exchange (the authorization-code handshake) still ride the built-in
  // `:httpc` (`:inets`/`:ssl`).  Added only when an `auth { oidc }` block is
  // present.
  const oidcDep = oidc ? `,\n      {:joken, "~> 2.6"},\n      {:joken_jwks, "~> 1.6"}` : "";
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
      {:open_api_spex, "~> 3.0"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_metrics_prometheus_core, "~> 1.1"}${liveViewDep}${extraBlock}${oidcDep}
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

function renderVanillaEndpoint(
  appName: string,
  appModule: string,
  hasLiveView: boolean,
  hasEmbeddedSpa: boolean,
): string {
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
  // Embedded-SPA host: serve the built Vite bundle from `priv/static/app`
  // (dropped there by the Dockerfile's `spa-build` stage) at `/app`.  The
  // SPA's `index.html` references `/app/assets/…` (vite `base: "/app/"`), so
  // real asset requests resolve here before the router's `/app/*` fallback
  // fires for client-side routes.  `only:` is omitted so every hashed Vite
  // asset filename is served (the dir holds only the SPA bundle).
  const spaStaticPlug = hasEmbeddedSpa
    ? `  plug Plug.Static,
    at: "/app",
    from: {:${appName}, "priv/static/app"},
    gzip: false

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

${liveViewPlugs}${spaStaticPlug}  plug Plug.RequestId
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
  hasEmbeddedSpa = false,
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
  // OIDC only: seed the Phoenix session's `current_user` from the verified
  // `session` cookie so LiveAuth.on_mount can gate LiveViews (the `auth: ui`
  // frontend guard).  Runs right after `:fetch_session`.  The dev stub needs
  // none — LiveAuth's dev_user fallback grants LiveViews out of the box.
  const browserAuthPlug = authEnabled && oidc ? `\n    plug ${webModule}.BrowserAuth` : "";
  const browserPipeline = hasLiveView
    ? `
  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session${browserAuthPlug}
    plug :fetch_live_flash
    plug :put_root_layout, html: {${webModule}.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end
`
    : "";
  // Under auth, LiveAuth.on_mount runs FIRST — it gates the LiveView (halting +
  // redirecting to the login handshake when the session carries no principal)
  // and assigns `@current_user`; Nav then adds `@current_path`.  Without auth,
  // Nav alone.  This is the `auth: ui` guard for the Phoenix-LiveView frontend.
  const liveOnMount = authEnabled
    ? `[${webModule}.LiveAuth, ${webModule}.Nav]`
    : `[${webModule}.Nav]`;
  const liveScope = hasLiveView
    ? `
  scope "/", ${webModule} do
    pipe_through :browser

    live_session :default, on_mount: ${liveOnMount} do
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
    post "/refresh", AuthController, :refresh
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
  // Embedded-SPA host: an `:spa` browser-html pipeline + a `/app` scope whose
  // catch-all serves the SPA's `index.html` for client-side deep-links
  // (Plug.Static in the endpoint serves real asset files first, so this fires
  // only for app routes), plus a `/` → `/app` redirect so the container root
  // lands on the app.  Emitted only for a `hosts:` deployable.
  const spaPipeline = hasEmbeddedSpa
    ? `
  pipeline :spa do
    plug :accepts, ["html"]
  end
`
    : "";
  const spaScope = hasEmbeddedSpa
    ? `
  scope "/", ${appModule}Web do
    pipe_through :spa

    get "/", SpaController, :redirect_to_app
    get "/app", SpaController, :index
    get "/app/*path", SpaController, :index
  end
`
    : "";
  return `# Auto-generated.
defmodule ${appModule}Web.Router do
  use ${appModule}Web, :router
${browserPipeline}${spaPipeline}
  pipeline :api do
    plug :accepts, ["json"]${authApiPlug}
  end

  scope "/health" do
    get "/", ${appModule}Web.HealthController, :liveness
  end

  scope "/ready" do
    get "/", ${appModule}Web.HealthController, :readiness
  end

  scope "/metrics" do
    get "/", ${appModule}Web.MetricsController, :index
  end
${rootApiScope}${liveScope}${authScope}${spaScope}
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

function renderVanillaMetricsController(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.MetricsController do
  use ${appModule}Web, :controller

  @moduledoc """
  Prometheus scrape target — the text exposition of the
  \`TelemetryMetricsPrometheus.Core\` aggregator started in
  \`${appModule}.Telemetry\` (the HTTP counter/histogram fed by the Phoenix
  endpoint telemetry event).  Parity with the other backends' GET /metrics.
  """

  @doc "GET /metrics — Prometheus text exposition."
  def index(conn, _params) do
    conn
    |> put_resp_content_type("text/plain")
    |> send_resp(200, TelemetryMetricsPrometheus.Core.scrape())
  end
end
`;
}

function renderVanillaSpaController(appName: string, appModule: string): string {
  // Embedded-SPA fallback controller (a `hosts:` React/Vue/Svelte ui).
  // Plug.Static (endpoint, at `/app`) serves the built bundle's real asset
  // files; this serves `index.html` for every client-side deep-link so the
  // SPA router takes over, and redirects the container root to `/app`.
  // `Application.app_dir/2` resolves the release-packaged bundle path
  // (`priv/static/app/index.html`) at runtime.
  return `# Auto-generated.
defmodule ${appModule}Web.SpaController do
  use ${appModule}Web, :controller

  @moduledoc """
  Serves the embedded client-side SPA (a \`hosts:\` React/Vue/Svelte ui).

  GET /          — redirect to the SPA mount point (/app).
  GET /app, /app/* — serve the SPA shell (index.html) so client-side
    routing resolves; Plug.Static serves real asset files first.
  """

  @doc "GET / — redirect the container root to the SPA."
  def redirect_to_app(conn, _params) do
    redirect(conn, to: "/app")
  end

  @doc "GET /app/* — serve the SPA shell so client-side routing resolves."
  def index(conn, _params) do
    conn
    |> put_resp_header("content-type", "text/html; charset=utf-8")
    |> send_file(200, Application.app_dir(:${appName}, "priv/static/app/index.html"))
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

function renderVanillaConfig(
  appName: string,
  appModule: string,
  swooshSmtpOnly = false,
  usesOban = false,
  oidc = false,
): string {
  // OIDC only: joken_jwks fetches the issuer's JWKS through Tesla, whose
  // default adapter is Hackney (which we don't depend on) — left unset the
  // fetch raises `Tesla.Adapter.Hackney.call/2 is undefined`, the signer cache
  // never populates, and every token 401s.  Pin Tesla to OTP's built-in
  // `:httpc` (the same client the OIDC handshake uses, backed by the declared
  // `:inets`/`:ssl`); the ssl opts verify the peer against the system CA store
  // for an https issuer and are ignored for a plain-http (dev) one.
  const teslaConfig = oidc
    ? `\nconfig :tesla,
  adapter: {Tesla.Adapter.Httpc, [ssl: [verify: :verify_peer, cacerts: :public_key.cacerts_get()]]}\n`
    : "";
  // gen_smtp-backed Swoosh (the smtp mailer) needs no HTTP API client; disable
  // the default so `:swoosh` boots without hackney.  Omitted entirely when no
  // smtp-only mailer is present, so a mailer-free app's config is unchanged.
  const swooshConfig = swooshSmtpOnly
    ? `\n# smtp mailer (Swoosh.Adapters.SMTP via gen_smtp) uses no HTTP API client.\nconfig :swoosh, :api_client, false\n`
    : "";
  // Durable timerSource (cron:) support — the Oban instance the scheduler
  // GenServers enqueue onto.  Omitted when no cron timer is owned.
  const obanConfig = usesOban ? renderObanConfig(appName, appModule) : "";
  return `import Config

config :${appName},
  ecto_repos: [${appModule}.Repo],
  generators: [timestamp_type: :utc_datetime]
${swooshConfig}

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
${teslaConfig}${obanConfig}
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
