import type {
  BoundedContextIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../../ir/types/loom-ir.js";
import type { MigrationsIR } from "../../ir/types/migrations-ir.js";
import { upperFirst } from "../../util/naming.js";
import type { EmitCtx, StyleAdapter } from "../_adapters/index.js";
import { renderPhoenixLogCall } from "../_obs/render-phoenix.js";
import { ashStyleAdapter } from "./adapters/ash-style.js";
import { emitPhoenixResourceFiles } from "./adapters/resource-clients.js";
import type { ApiRoute } from "./api-emit.js";
import { renderJasonCamelCaseModule } from "./jason-camel-emit.js";
import type { LiveRoute } from "./liveview-emit.js";
import { renderProblemDetailsModule } from "./problem-details-emit.js";
import { contextsHaveSeeds, renderSeedsExs } from "./seeds-emit.js";
import { renderTelemetry } from "./telemetry-emit.js";

// ---------------------------------------------------------------------------
// Shell files — Phoenix boilerplate
// ---------------------------------------------------------------------------

export function emitShellFiles(
  appName: string,
  appModule: string,
  deployable: DeployableIR,
  sys: SystemIR,
  contexts: BoundedContextIR[],
  liveRoutes: LiveRoute[],
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  emitTrace: boolean | undefined,
  out: Map<string, string>,
  migrations: MigrationsIR[],
  styleAdapter?: StyleAdapter,
): void {
  const port = deployable.port ?? 4000;
  // D-PHOENIX-SURFACE phase 6b: when the deployable embeds a React SPA
  // (its hosted ui is `framework: react`), the shell files gain the
  // serve-wiring that makes the built bundle reachable — a multi-stage
  // Dockerfile that runs the SPA's Vite build, a `Plug.Static` that
  // serves it from `priv/static`, and a router catch-all serving
  // `index.html` for client-side deep links.  Same flag the orchestrator
  // uses for the emit branch.
  const embedReact = deployable.uiFramework === "react";

  // Resource client modules (objectStore / queue / api) + their Hex
  // deps (Phase 4c).  Empty when the deployable wires no consumable
  // resources — mix.exs stays byte-identical.
  const resourceEmission = emitPhoenixResourceFiles(sys, appName, appModule);
  for (const [path, content] of resourceEmission.files) out.set(path, content);
  out.set(
    "mix.exs",
    renderMixExs(appName, appModule, resourceEmission.hexDeps, contextsHaveSeeds(contexts)),
  );
  out.set(".formatter.exs", renderFormatterExs());
  out.set("Dockerfile", renderDockerfile(appName, embedReact));
  out.set(".dockerignore", renderDockerignore());
  // certs/ is the CA-bake landing slot — see the COPY in renderDockerfile.
  // .gitkeep keeps the dir present in git so the COPY is a no-op when
  // no proxy CAs are configured.
  out.set("certs/.gitkeep", "");

  // lib/<app>/repo.ex
  out.set(`lib/${appName}/repo.ex`, renderRepo(appName, appModule));

  // lib/<app>/jason_camel_case.ex — shared helper that resource modules'
  // `defimpl Jason.Encoder` delegates to.  Translates an Ash struct's
  // snake_case atom keys into camelCase JSON keys, matching the Hono /
  // .NET wire shape.  Emitted once per project.
  out.set(`lib/${appName}/jason_camel_case.ex`, renderJasonCamelCaseModule(appModule));

  // lib/<app>_web/problem_details.ex — shared RFC 7807 ProblemDetails
  // responders used by both the per-aggregate controllers (Plug.ErrorHandler
  // arm for Ash.Error.Invalid → 422 + errors[] extension) and the
  // workflows controller (extended error_response/2 for Ash.Error.Invalid
  // tuples).  See docs/proposals/validation-error-extension.md (Phase C).
  out.set(`lib/${appName}_web/problem_details.ex`, renderProblemDetailsModule(appModule));

  // lib/<app>/telemetry.ex — :telemetry handlers that translate Phoenix
  // endpoint events into the neutral log-event catalog identity.
  out.set(`lib/${appName}/telemetry.ex`, renderTelemetry({ appName, appModule, emitTrace }));

  // lib/<app>/log_formatter.ex — JSON-per-line Logger formatter that
  // preserves structured metadata (event, request_id, method, path,
  // status, duration_ms, etc.) so the cross-backend log envelope is
  // parseable upstream the same way Hono's pino and .NET's
  // AddJsonConsole emit.
  out.set(`lib/${appName}/log_formatter.ex`, renderLogFormatter(appModule));

  // lib/<app>/application.ex
  out.set(`lib/${appName}/application.ex`, renderApplication(appName, appModule));

  // lib/<app>_web.ex
  out.set(`lib/${appName}_web.ex`, renderWebModule(appName, appModule));

  // lib/<app>_web/endpoint.ex
  out.set(`lib/${appName}_web/endpoint.ex`, renderEndpoint(appName, appModule, embedReact));

  // lib/<app>_web/router.ex
  out.set(
    `lib/${appName}_web/router.ex`,
    renderRouter(appName, appModule, liveRoutes, apiRoutes, authEnabled, embedReact),
  );

  // lib/<app>_web/components/core_components.ex — minimal stub so
  // the html_helpers macro's `import ...CoreComponents` resolves.
  // Standard Phoenix 1.7 generators ship a much richer module; an
  // empty wrapper suffices because generated LiveView pages reference
  // components by full module path, not the imported aliases.
  out.set(`lib/${appName}_web/components/core_components.ex`, renderCoreComponents(appModule));

  // lib/<app>_web/components/layouts.ex
  out.set(`lib/${appName}_web/components/layouts.ex`, renderLayouts(appName, appModule));

  // lib/<app>_web/components/layouts/root.html.heex
  out.set(`lib/${appName}_web/components/layouts/root.html.heex`, renderRootLayout(appName));

  // lib/<app>_web/components/layouts/app.html.heex
  out.set(`lib/${appName}_web/components/layouts/app.html.heex`, renderAppLayout());

  // Error views — the endpoint config wires these as the render_errors
  // formats so a 500 in (say) the openapi controller renders a JSON
  // body instead of crashing the cowboy adapter on a missing
  // ErrorView module.
  out.set(`lib/${appName}_web/controllers/error_json.ex`, renderErrorJson(appModule));
  out.set(`lib/${appName}_web/controllers/error_html.ex`, renderErrorHtml(appModule));

  // Config — `config/config.exs` includes the `config :<app>,
  // ash_domains: [...]` registration block.  Phoenix is always
  // system-mode (the generator entry takes deployable + sys), so we
  // can ALWAYS dispatch through the `ashStyleAdapter.emitDi` here.
  // The shell helper widened its `contexts` parameter to
  // `BoundedContextIR[]` years ago; the caller always passes the
  // enriched flavour, so this `as` keeps the EmitCtx contract honest
  // without touching every shell-helper signature.
  const emitCtx: EmitCtx = {
    deployable,
    contexts: contexts as EnrichedBoundedContextIR[],
    sys,
    migrations,
    emitTrace,
    styleAdapter,
  };
  // Resolved style selection (D-REALIZATION-AXES) when threaded in; the
  // sibling default otherwise.  `ash` is the only real style, so the
  // resolved adapter IS `ashStyleAdapter` → byte-identical.
  const style = emitCtx.styleAdapter ?? ashStyleAdapter;
  out.set(
    "config/config.exs",
    renderConfigExs(appName, appModule, contexts, style.emitDi(emitCtx)),
  );
  out.set("config/dev.exs", renderDevExs(appName, appModule, port));
  out.set("config/prod.exs", renderProdExs(appName, appModule));
  out.set("config/runtime.exs", renderRuntimeExs(appName, appModule));

  // Priv — first-boot seed data (database-seeding.md, Phase 3b).  Through the
  // domain create action (D-SEED-PATH), ship-once per dataset
  // (D-SEED-IDEMPOTENCY); an empty stub when no `seed` block is declared.
  out.set("priv/repo/seeds.exs", renderSeedsExs(appModule, contexts));

  // Release
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
}

// ---------------------------------------------------------------------------
// Individual shell file renderers
// ---------------------------------------------------------------------------

function renderMixExs(
  appName: string,
  appModule: string,
  extraHexDeps: Record<string, string> = {},
  hasSeeds = false,
): string {
  // Run the seeds script as the last step of `ecto.setup` — only when a
  // `seed` block is declared, so seedless projects stay byte-identical.
  const ectoSetup = hasSeeds
    ? `["ecto.create", "ash.codegen", "ash.migrate", "run priv/repo/seeds.exs"]`
    : `["ecto.create", "ash.codegen", "ash.migrate"]`;
  // Resource-client Hex deps (Phase 4c) — `{:ex_aws, "~> 2.5"}` etc.,
  // appended to the base dep list.  Sorted for stable output.
  const extraDepLines = Object.entries(extraHexDeps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, ver]) => `,\n      {:${name}, ${ver}}`)
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
      {:phoenix_live_view, "~> 1.0"},
      {:phoenix_html, "~> 4.1"},
      {:phoenix_ecto, "~> 4.4"},
      {:ecto_sql, "~> 3.10"},
      {:postgrex, "~> 0.20"},
      {:ash, "~> 3.24"},
      {:ash_postgres, "~> 2.0"},
      {:ash_phoenix, "~> 2.0"},
      # Ash.Policy.Authorizer (used by \`requires\`-guarded operations) solves
      # its policy graph with a SAT solver at runtime.  simple_sat is pure
      # Elixir (no C NIF), so it builds in the slim release image without a
      # toolchain — preferred over picosat_elixir for the docker target.
      {:simple_sat, "~> 0.1"},
      # ash_postgres' ResourceGenerator (lib/resource_generator/spec.ex)
      # references Igniter.Inflex and Owl.IO at compile time.  Both are
      # optional deps for the \`mix ash_postgres.gen.resources\` task
      # and aren't pulled by \`mix deps.get --only prod\`, which surfaces
      # as "module X is not available" warnings.  Under the
      # phoenix-build workflow's \`mix compile --warnings-as-errors\`,
      # any warning fails the build.  Declaring them here with
      # \`runtime: false\` resolves the compile-time references without
      # pulling them into the application start sequence.
      {:igniter, "~> 0.5", runtime: false},
      {:owl, "~> 0.11", runtime: false},
      {:jason, "~> 1.2"},
      {:bandit, "~> 1.5"},
      {:plug_cowboy, "~> 2.5"},
      {:open_api_spex, "~> 3.0"}${extraDepLines}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ash.setup"],
      "ecto.setup": ${ectoSetup},
      "ecto.reset": ["ecto.drop", "ecto.setup"]
    ]
  end
end
`;
}

function renderFormatterExs(): string {
  return `[
  import_deps: [:ecto, :ecto_sql, :phoenix, :ash, :ash_postgres, :ash_phoenix],
  subdirectories: ["priv/*/migrations"],
  plugins: [Phoenix.LiveView.HTMLFormatter],
  inputs: ["*.{heex,ex,exs}", "{config,lib,test}/**/*.{heex,ex,exs}", "priv/*/seeds.exs"]
]
`;
}

function renderDockerfile(appName: string, embedReact = false): string {
  // Embedded-React mode: a first `spa-build` stage runs the SPA's own
  // Vite build (the React project the orchestrator emitted under
  // `assets/`), then the builder stage copies its `dist/` into
  // `priv/static/app` so `mix release` packages it and `Plug.Static`
  // (at `/app`) serves it.  Mirrors the .NET multi-stage embed
  // (spa-build → app build → runtime).
  const spaBuildStage = embedReact
    ? `FROM node:20-alpine AS spa-build
WORKDIR /spa
COPY assets/package.json assets/package-lock.json* ./
RUN npm ci --prefer-offline --no-audit --no-fund || npm install
COPY assets/ ./
RUN npm run build

`
    : "";
  // In embedded mode, drop the built SPA into priv/static/app before
  // `mix compile`/`mix release` so the release overlay includes it.
  const spaCopy = embedReact
    ? `COPY --from=spa-build /spa/dist priv/static/app
`
    : "";
  return `# syntax=docker/dockerfile:1
# Auto-generated.

ARG ELIXIR_VERSION=1.17.2
ARG OTP_VERSION=27.0.1
ARG DEBIAN_VERSION=bookworm-20240722-slim

ARG BUILDER_IMAGE="hexpm/elixir:\${ELIXIR_VERSION}-erlang-\${OTP_VERSION}-debian-\${DEBIAN_VERSION}"
ARG RUNNER_IMAGE="debian:\${DEBIAN_VERSION}"

${spaBuildStage}FROM \${BUILDER_IMAGE} AS build
RUN apt-get update -y && apt-get install -y build-essential git ca-certificates \\
    && apt-get clean && rm -f /var/lib/apt/lists/*_*
WORKDIR /app
# Optional proxy CAs — drop *.crt files into ./certs/ to make hex
# trust them.  The directory always exists (with a .gitkeep), so
# this COPY is a no-op when no CAs are configured.  Erlang's :inets
# / :ssl pick up the OS trust store when we point SSL_CERT_FILE +
# HEX_CACERTS_PATH at it; without these, the proxy CA looks valid
# to curl/openssl but Erlang refuses the handshake with "unknown_ca".
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>/dev/null || true
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \\
    HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV="prod"
# The generator emits mix.exs but no mix.lock (deps aren't pinned at
# generation time), so mix deps.get resolves and writes the lock here.
COPY mix.exs ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config
COPY config/config.exs config/$MIX_ENV.exs config/
RUN mix deps.compile
COPY priv priv
${spaCopy}COPY lib lib
RUN mix compile
COPY config/runtime.exs config/
COPY rel rel
RUN mix release

FROM \${RUNNER_IMAGE}
# wget is here so the compose healthcheck (which shells out to wget) works
# in the slim Debian runner image — without it the container reports
# unhealthy even though the Phoenix endpoint is responding.
RUN apt-get update -y \\
    && apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates wget \\
    && apt-get clean && rm -f /var/lib/apt/lists/*_*
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
WORKDIR /app
RUN chown nobody /app
ENV MIX_ENV="prod"
COPY --from=build --chown=nobody:root /app/_build/\${MIX_ENV}/rel/${appName} ./
# mix release preserves overlay file perms verbatim, and the generator
# writes scripts with the default 0644 — chmod +x here so the entrypoint
# is actually executable (without this the container is stuck in
# "Created" state because docker's exec fails with EACCES).
RUN chmod +x /app/bin/server
USER nobody
CMD ["/app/bin/server"]
`;
}

function renderDockerignore(): string {
  return `# Auto-generated.
_build
deps
.elixir_ls
.fetch
priv/static/assets
.git
.env
.env.*
*.log
`;
}

function renderRepo(appName: string, appModule: string): string {
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

function renderApplication(appName: string, appModule: string): string {
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
function renderLogFormatter(appModule: string): string {
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

function renderWebModule(_appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule} do
  @moduledoc """
  The entrypoint for defining web interface, such as controllers, components,
  channels, and so on.  This can be used in your application as:

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

  def router do
    quote do
      use Phoenix.Router, helpers: false
      import Plug.Conn
      import Phoenix.Controller
      import Phoenix.LiveView.Router
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  # Controller bundle for the API + LV controllers we emit
  # (AggregatesController, OpenapiController, HealthController, …).
  # Standard Phoenix 1.7 shape — pulls in the controller DSL plus
  # the formats this generator emits (json + html for layout-bearing
  # endpoints).  Caller modules use \`use PhoenixAppWeb, :controller\`.
  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json], layouts: [html: ${webModule}.Layouts]

      import Plug.Conn
      unquote(verified_routes())
    end
  end

  # Verified-routes helper bundle — exposed both to controllers and
  # LiveView modules so \`~p\` paths are reachable everywhere.
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

  # HTML helper bundle for layouts + function components.  Required
  # by \`use PhoenixAppWeb, :html\` invocations (e.g. Layouts).  Mirrors
  # the standard Phoenix 1.7 generator shape — pulls in Phoenix.HTML,
  # core components, and a CSRF helper.
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
      # phoenix_html 4.x dropped \`use Phoenix.HTML\` — import the
      # safe-string helpers directly instead.  Same surface, no
      # macro fan-out.
      import Phoenix.HTML
      # Phoenix.LiveView.Helpers was folded into Phoenix.Component in
      # LiveView 0.18+; the function components surface (\`~H\`, etc.)
      # comes from \`use Phoenix.Component\` on the caller side.
      import ${webModule}.CoreComponents
      alias Phoenix.LiveView.JS
      # Verified routes — provides the \`~p\` sigil that emitted
      # sidebar / page templates use for path interpolation.
      unquote(verified_routes())
    end
  end

  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
`;
}

function renderEndpoint(appName: string, appModule: string, embedReact = false): string {
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

function renderRouter(
  appName: string,
  appModule: string,
  liveRoutes: LiveRoute[],
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  embedReact = false,
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
${spaFallback}
${rootLines}
end
`;
}

/** SpaController (D-PHOENIX-SURFACE phase 6b) — serves the embedded
 *  React SPA's `index.html` for any `/app/*` client-side route.  Only
 *  emitted in embedded-react mode; the router's `/app` catch-all points
 *  here.  Reads the bundle the Dockerfile placed at
 *  `priv/static/app/index.html`. */
export function renderSpaController(appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.SpaController do
  use ${webModule}, :controller

  @index_path Path.join(:code.priv_dir(:${appName}), "static/app/index.html")

  def index(conn, _params) do
    conn
    |> put_resp_content_type("text/html")
    |> send_file(200, @index_path)
  end
end
`;
}

function renderCoreComponents(appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.CoreComponents do
  @moduledoc """
  Function components consumed by emitted layouts + LiveView pages.
  Mirrors the subset of Phoenix 1.7's standard CoreComponents that
  Loom's HEEx walker calls into: \`flash_group\`, \`header\`, \`button\`,
  \`input\`, \`simple_form\`, \`table\`, \`badge\`, \`empty\`, \`modal\`.

  Layouts are intentionally minimal/Tailwind-ish — projects can swap
  in a richer component module without touching the emitter.
  """
  use Phoenix.Component
  alias Phoenix.LiveView.JS

  @doc "Renders all currently-set flash messages."
  attr :flash, :map, default: %{}

  def flash_group(assigns) do
    ~H"""
    <div :if={Phoenix.Flash.get(@flash, :info)} class="rounded-md bg-blue-50 p-3 text-sm text-blue-700 mb-4">
      <%= Phoenix.Flash.get(@flash, :info) %>
    </div>
    <div :if={Phoenix.Flash.get(@flash, :error)} class="rounded-md bg-red-50 p-3 text-sm text-red-700 mb-4">
      <%= Phoenix.Flash.get(@flash, :error) %>
    </div>
    """
  end

  @doc "Page-section heading with optional subtitle + actions slot."
  attr :class, :string, default: nil
  # \`level\` is forwarded from the DSL Heading primitive (1..4).  Styling
  # is uniform here (single .text-2xl line) — the attr is accepted so
  # consumers can render their own sized variants without re-declaring.
  attr :level, :integer, default: 1
  slot :inner_block, required: true
  slot :subtitle
  slot :actions

  def header(assigns) do
    ~H"""
    <header class={["flex items-center justify-between gap-6 mb-6", @class]}>
      <div>
        <h1 class={[
          "font-semibold leading-7 text-zinc-900",
          @level <= 1 && "text-2xl",
          @level == 2 && "text-xl",
          @level == 3 && "text-lg",
          @level >= 4 && "text-base"
        ]}>
          {render_slot(@inner_block)}
        </h1>
        <p :if={@subtitle != []} class="mt-1 text-sm text-zinc-600">
          {render_slot(@subtitle)}
        </p>
      </div>
      <div :if={@actions != []} class="flex gap-2 flex-shrink-0">
        {render_slot(@actions)}
      </div>
    </header>
    """
  end

  @doc """
  Styled button.  Accepts type=button|submit|reset + arbitrary attrs.
  When \`to:\` is set, renders a \`<.link navigate>\` styled as a button
  (matches the DSL Button primitive's \`to:\` named arg for navigation).
  \`testid:\` is hoisted onto the rendered element for Playwright drivers.
  """
  attr :type, :string, default: "button"
  attr :class, :string, default: nil
  attr :to, :string, default: nil, doc: "when set, renders as a navigation link"
  attr :testid, :string, default: nil, doc: "data-testid forwarded to the root element"
  attr :rest, :global, include: ~w(form name value disabled phx-click phx-submit phx-disable-with)
  slot :inner_block, required: true

  def button(assigns) do
    classes =
      [
        "inline-flex items-center justify-center rounded-md bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50",
        assigns.class
      ]

    assigns = assign(assigns, :classes, classes)

    if assigns.to do
      ~H"""
      <.link navigate={@to} class={@classes} data-testid={@testid} {@rest}>
        {render_slot(@inner_block)}
      </.link>
      """
    else
      ~H"""
      <button type={@type} class={@classes} data-testid={@testid} {@rest}>
        {render_slot(@inner_block)}
      </button>
      """
    end
  end

  @doc "Form input with label + error message.  Supports text/number/email/checkbox/select/textarea."
  attr :id, :any, default: nil
  attr :name, :any
  attr :label, :string, default: nil
  attr :value, :any
  attr :type, :string, default: "text"
  attr :field, Phoenix.HTML.FormField,
    doc: "a form field struct retrieved from the form, for example: @form[:email]"
  attr :errors, :list, default: []
  attr :checked, :boolean
  attr :prompt, :string, default: nil
  attr :options, :list, default: []
  attr :multiple, :boolean, default: false
  attr :rest, :global, include: ~w(autocomplete cols disabled form list max maxlength min minlength pattern placeholder readonly required rows size step)

  def input(%{field: %Phoenix.HTML.FormField{} = field} = assigns) do
    assigns
    |> assign(field: nil, id: assigns.id || field.id)
    |> assign(:errors, Enum.map(field.errors, &translate_error/1))
    |> assign_new(:name, fn -> if assigns.multiple, do: field.name <> "[]", else: field.name end)
    |> assign_new(:value, fn -> field.value end)
    |> input()
  end

  def input(%{type: "checkbox"} = assigns) do
    assigns = assign_new(assigns, :checked, fn -> Phoenix.HTML.Form.normalize_value("checkbox", assigns[:value]) end)

    ~H"""
    <div>
      <label class="flex items-center gap-3 text-sm leading-6 text-zinc-600">
        <input type="hidden" name={@name} value="false" />
        <input
          type="checkbox"
          id={@id}
          name={@name}
          value="true"
          checked={@checked}
          class="rounded border-zinc-300 text-zinc-900 focus:ring-0"
          {@rest}
        />
        {@label}
      </label>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(%{type: "select"} = assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <select
        id={@id}
        name={@name}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        multiple={@multiple}
        {@rest}
      >
        <option :if={@prompt} value="">{@prompt}</option>
        {Phoenix.HTML.Form.options_for_select(@options, @value)}
      </select>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(%{type: "textarea"} = assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <textarea
        id={@id}
        name={@name}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        {@rest}
      >{Phoenix.HTML.Form.normalize_value("textarea", @value)}</textarea>
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  def input(assigns) do
    ~H"""
    <div>
      <.label for={@id}>{@label}</.label>
      <input
        type={@type}
        name={@name}
        id={@id}
        value={Phoenix.HTML.Form.normalize_value(@type, @value)}
        class="mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-400 focus:ring-0"
        {@rest}
      />
      <.error :for={msg <- @errors}>{msg}</.error>
    </div>
    """
  end

  attr :for, :string, default: nil
  slot :inner_block, required: true

  def label(assigns) do
    ~H"""
    <label for={@for} class="block text-sm font-medium leading-6 text-zinc-900">
      {render_slot(@inner_block)}
    </label>
    """
  end

  slot :inner_block, required: true

  def error(assigns) do
    ~H"""
    <p class="mt-1 text-sm leading-6 text-rose-600">{render_slot(@inner_block)}</p>
    """
  end

  @doc "Form wrapper that renders a Phoenix.HTML.Form with submit handler."
  attr :for, :any, required: true
  attr :as, :any, default: nil
  attr :rest, :global, include: ~w(autocomplete name rel action enctype method novalidate target multipart phx-change phx-submit phx-trigger-action phx-disable-with)
  slot :inner_block, required: true
  slot :actions

  def simple_form(assigns) do
    ~H"""
    <.form :let={f} for={@for} as={@as} {@rest}>
      <div class="space-y-4">
        {render_slot(@inner_block, f)}
        <div :for={action <- @actions} class="mt-4 flex items-center justify-end gap-2">
          {render_slot(action, f)}
        </div>
      </div>
    </.form>
    """
  end

  @doc "Data table with :col slots."
  attr :id, :string, required: true
  attr :rows, :list, required: true
  attr :row_id, :any, default: nil, doc: "function that returns the id for the row"
  attr :row_click, :any, default: nil, doc: "function or {JS, …} to invoke on row click"
  attr :row_item, :any, default: &Function.identity/1, doc: "function to derive the row data shown to the slot"
  slot :col, required: true do
    attr :label, :string
  end
  slot :action, doc: "trailing per-row action column"

  def table(assigns) do
    assigns = assign_new(assigns, :row_id, fn -> nil end)

    ~H"""
    <div class="overflow-x-auto">
      <table id={@id} class="min-w-full divide-y divide-zinc-200 text-sm">
        <thead class="bg-zinc-50">
          <tr>
            <th :for={col <- @col} class="px-3 py-2 text-left font-semibold text-zinc-700">{col[:label]}</th>
            <th :if={@action != []} class="px-3 py-2 text-right font-semibold text-zinc-700">
              <span class="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-zinc-100 bg-white">
          <tr :for={row <- @rows} id={@row_id && @row_id.(row)} class={@row_click && "hover:bg-zinc-50 cursor-pointer"}>
            <td :for={col <- @col} phx-click={@row_click && @row_click.(row)} class="px-3 py-2 text-zinc-900">
              {render_slot(col, @row_item.(row))}
            </td>
            <td :if={@action != []} class="px-3 py-2 text-right">
              <span :for={action <- @action}>{render_slot(action, @row_item.(row))}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    """
  end

  @doc "Colored pill — used for status / enum displays."
  attr :class, :string, default: nil
  slot :inner_block, required: true

  def badge(assigns) do
    ~H"""
    <span class={["inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700", @class]}>
      {render_slot(@inner_block)}
    </span>
    """
  end

  @doc "Empty-state placeholder rendered when a list is empty."
  attr :class, :string, default: nil

  def empty(assigns) do
    ~H"""
    <div class={["text-center text-sm text-zinc-500 py-8", @class]}>
      No items.
    </div>
    """
  end

  @doc """
  A modal dialog driven by \`show_modal/1\` + \`hide_modal/1\` JS
  commands.  The \`:title\` slot renders the heading; the default
  slot is the body (typically a \`<.simple_form>\`).
  """
  attr :id, :string, required: true
  attr :show, :boolean, default: false
  attr :on_cancel, JS, default: %JS{}
  slot :title
  slot :inner_block, required: true

  def modal(assigns) do
    ~H"""
    <div
      id={@id}
      phx-mounted={@show && show_modal(@id)}
      phx-remove={hide_modal(@id)}
      class="relative z-50 hidden"
    >
      <div id={"#{@id}-bg"} class="fixed inset-0 bg-zinc-900/30 transition-opacity" aria-hidden="true" />
      <div
        class="fixed inset-0 overflow-y-auto"
        aria-labelledby={"#{@id}-title"}
        role="dialog"
        aria-modal="true"
        tabindex="0"
      >
        <div class="flex min-h-full items-center justify-center p-4">
          <div class="w-full max-w-lg">
            <.focus_wrap
              id={"#{@id}-container"}
              phx-window-keydown={hide_modal(@on_cancel, @id)}
              phx-key="escape"
              phx-click-away={hide_modal(@on_cancel, @id)}
              class="relative hidden rounded-md bg-white p-6 shadow-lg ring-1 ring-zinc-200 transition"
            >
              <div class="absolute top-4 right-4">
                <button
                  type="button"
                  phx-click={hide_modal(@on_cancel, @id)}
                  class="rounded-md p-1 text-zinc-400 hover:text-zinc-600"
                  aria-label="close"
                >
                  &times;
                </button>
              </div>
              <h2
                :if={@title != []}
                id={"#{@id}-title"}
                class="text-lg font-semibold leading-7 text-zinc-900 mb-4"
              >
                {render_slot(@title)}
              </h2>
              <div id={"#{@id}-content"}>
                {render_slot(@inner_block)}
              </div>
            </.focus_wrap>
          </div>
        </div>
      </div>
    </div>
    """
  end

  # ---- Internal helpers -----------------------------------------------------

  @doc false
  def show_modal(js \\\\ %JS{}, id) when is_binary(id) do
    js
    |> JS.show(to: "##{id}")
    |> JS.show(
      to: "##{id}-bg",
      transition:
        {"transition-all transform ease-out duration-200", "opacity-0", "opacity-100"}
    )
    |> JS.show(
      to: "##{id}-container",
      transition:
        {"transition-all transform ease-out duration-200",
         "opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95",
         "opacity-100 translate-y-0 sm:scale-100"}
    )
    |> JS.focus_first(to: "##{id}-content")
  end

  @doc false
  def hide_modal(js \\\\ %JS{}, id) do
    js
    |> JS.hide(
      to: "##{id}-bg",
      transition:
        {"transition-all transform ease-in duration-150", "opacity-100", "opacity-0"}
    )
    |> JS.hide(
      to: "##{id}-container",
      transition:
        {"transition-all transform ease-in duration-150",
         "opacity-100 translate-y-0 sm:scale-100",
         "opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"}
    )
    |> JS.hide(to: "##{id}", transition: {"block", "block", "hidden"})
    |> JS.pop_focus()
  end

  defp translate_error({msg, opts}) do
    Enum.reduce(opts, msg, fn {key, value}, acc ->
      String.replace(acc, "%{#{key}}", fn _ -> to_string(value) end)
    end)
  end
end
`;
}

function renderLayouts(_appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
  return `# Auto-generated.
defmodule ${webModule}.Layouts do
  use ${webModule}, :html

  embed_templates "layouts/*"
end
`;
}

function renderRootLayout(appName: string): string {
  return `<!DOCTYPE html>
<html lang="en" class="[scrollbar-gutter:stable]">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="csrf-token" content={get_csrf_token()} />
    <.live_title suffix=" · ${appName}">
      <%= assigns[:page_title] || "${appName}" %>
    </.live_title>
    <link phx-track-static rel="stylesheet" href={~p"/assets/app.css"} />
    <script defer phx-track-static type="text/javascript" src={~p"/assets/app.js"}>
    </script>
  </head>
  <body class="bg-white antialiased">
    <%= @inner_content %>
  </body>
</html>
`;
}

function renderAppLayout(): string {
  return `<header class="px-4 sm:px-6 lg:px-8">
  <div class="flex items-center justify-between border-b border-zinc-100 py-3 text-sm">
    <div class="flex items-center gap-4">
      <nav class="flex items-center gap-4 font-semibold leading-6 text-zinc-900">
        <a href="/">Home</a>
      </nav>
    </div>
  </div>
</header>
<main class="px-4 py-20 sm:px-6 lg:px-8">
  <div class="mx-auto max-w-2xl">
    <.flash_group flash={@flash} />
    <%= @inner_content %>
  </div>
</main>
`;
}

/** Minimal ErrorJSON module — Phoenix's render_errors pipeline calls
 *  `render/2` with template names like "404.json" / "500.json" and
 *  expects a map back.  Phoenix.Controller.status_message_from_template/1
 *  turns the template ("500.json") into a status reason string ("Internal
 *  Server Error"), which we surface in the envelope. */
function renderErrorJson(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorJSON do
  @moduledoc "Render exceptions as JSON envelopes for the API."

  # Catch-all: e.g. "404.json" → %{error: "Not Found"}, "500.json" → %{error: "Internal Server Error"}.
  def render(template, _assigns) do
    %{error: Phoenix.Controller.status_message_from_template(template)}
  end
end
`;
}

/** Minimal ErrorHTML module — Phoenix's render_errors pipeline picks
 *  json or html based on the request's Accept header.  Browser requests
 *  hit this one; the body is intentionally minimal so an exception
 *  doesn't leak internal state. */
function renderErrorHtml(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorHTML do
  @moduledoc "Render exceptions as a plain HTML body for browser callers."

  def render(template, _assigns) do
    Phoenix.Controller.status_message_from_template(template)
  end
end
`;
}

function renderConfigExs(
  appName: string,
  appModule: string,
  contexts: BoundedContextIR[],
  ashDomainsBlock?: readonly string[],
): string {
  // Ash 3.x requires every domain to be registered here; without it
  // `mix compile --warnings-as-errors` rejects with
  // "Domain <Mod> is not present in :ash_domains".  Domains are
  // \`<appModule>.<PascalContextName>\` (matching what
  // emitAggregateResources emits as the resource's :domain).
  //
  // System-mode emit passes the block in via `ashDomainsBlock` (the
  // `ashStyleAdapter.emitDi` output — F7d adapter-dispatch seam);
  // legacy single-context emit synthesises it locally so the function
  // stays standalone.
  const ashLines = ashDomainsBlock ?? [
    `config :${appName},`,
    `  ash_domains: [${contexts.map((ctx) => `${appModule}.${upperFirst(ctx.name)}`).join(", ")}]`,
  ];
  return `# Auto-generated.
import Config

config :${appName}, ecto_repos: [${appModule}.Repo]
config :${appName}, ${appModule}Web.Endpoint,
  url: [host: "localhost"],
  # Wire the generated ErrorJSON / ErrorHTML modules so an exception in a
  # controller (e.g. a 500 on /api/openapi.json) renders through them
  # instead of crashing again on a missing default ErrorView.
  render_errors: [
    formats: [json: ${appModule}Web.ErrorJSON, html: ${appModule}Web.ErrorHTML],
    layout: false
  ]

${ashLines.join("\n")}

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

function renderDevExs(appName: string, appModule: string, port: number): string {
  return `# Auto-generated.
import Config

config :${appName}, ${appModule}.Repo,
  username: "postgres",
  password: "postgres",
  hostname: "localhost",
  database: "${appName}_dev",
  stacktrace: true,
  show_sensitive_data_on_connection_error: true,
  pool_size: 10

config :${appName}, ${appModule}Web.Endpoint,
  # PORT env var overrides the dev default so test harnesses + parallel
  # dev workflows can avoid port collisions without editing this file.
  http: [ip: {127, 0, 0, 1}, port: String.to_integer(System.get_env("PORT") || "${port}")],
  check_origin: false,
  code_reloader: true,
  debug_errors: true,
  secret_key_base: "dev-secret-key-base-replace-in-production-with-mix-phx-gen-secret",
  watchers: []

config :phoenix, :stacktrace_depth, 20
config :phoenix, :plug_init_mode, :runtime
config :phoenix_live_view, :debug_heex_annotations, true
`;
}

function renderProdExs(appName: string, appModule: string): string {
  return `# Auto-generated.
import Config

config :${appName}, ${appModule}Web.Endpoint,
  cache_static_manifest: "priv/static/cache_manifest.json",
  server: true

config :logger, level: :info
`;
}

function renderRuntimeExs(appName: string, appModule: string): string {
  return `# Auto-generated.
import Config

if config_env() == :prod do
  database_url = System.fetch_env!("DATABASE_URL")
  config :${appName}, ${appModule}.Repo,
    url: database_url,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "10")

  secret_key_base = System.fetch_env!("SECRET_KEY_BASE")
  host = System.get_env("PHX_HOST") || "example.com"
  port = String.to_integer(System.get_env("PORT") || "4000")

  config :${appName}, ${appModule}Web.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    http: [ip: {0, 0, 0, 0, 0, 0, 0, 0}, port: port],
    secret_key_base: secret_key_base

  # SSL to the database is opt-in.  Managed Postgres (RDS, Cloud SQL, etc.)
  # usually requires it; local docker-compose Postgres doesn't support it
  # out of the box, so default off and let deployments flip DATABASE_SSL=1.
  if System.get_env("DATABASE_SSL") in ["1", "true"] do
    config :${appName}, ${appModule}.Repo,
      ssl: true,
      ssl_opts: [verify: :verify_none]
  end
end
`;
}

function renderRelEnv(appName: string): string {
  return `#!/bin/sh
# Auto-generated.

# Elixir release env — set env vars that differ between environments.
# Variables here override config/runtime.exs values.

# Uncomment to use a custom release name:
# export RELEASE_NAME="${appName}"
`;
}

function renderRelServer(appName: string): string {
  // `#!/bin/sh` here is dash on Debian, which doesn't support
  // `pipefail`.  Drop that flag — `set -eu` is enough for a one-line
  // exec, and the path is rooted relative to the release directory
  // (which the Dockerfile copies into `/app/`, so the binary lives
  // at `/app/bin/<app>`, NOT `/app/<app>/bin/<app>`).
  return `#!/bin/sh
# Auto-generated.
set -eu

exec "./bin/${appName}" start
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function toSnakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

export function toModulePrefix(snakeName: string): string {
  return snakeName
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}
