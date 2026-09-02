// ---------------------------------------------------------------------------
// Shell renderers — plain Phoenix + Ecto skeleton
// (vanilla-foundation-tdd-plan.md): a minimal project that
// `mix compile --warnings-as-errors` accepts.
// The router accepts per-aggregate routes spliced into /api.
// Observability: `renderApplication` / `renderLogFormatter` /
// `renderTelemetry` in `../shell/runtime.ts` + `../telemetry-emit.ts` are
// wired through here so the backend emits the same cross-backend log-event
// catalog (`server_starting` / `_listening` / `_shutdown` / `_drained` +
// `request_start` / `_end`) over the same JSON-per-line envelope as the
// Hono, .NET, Java, and Python backends.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../../ir/types/loom-ir.js";
import { AUTH_BASE_PATH } from "../../../util/api-base.js";
import { lines } from "../../../util/code-builder.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { packChromeCatalog } from "../../_packs/pack-chrome.js";
import type { ApiRoute } from "../api-emit.js";
import {
  GETTEXT_DEP,
  GETTEXT_DOMAIN,
  heexIcuEnabled,
  ICU_DEPS,
  renderCldrBackend,
  renderGettextBackend,
  renderGettextCatalog,
  renderIcuRuntime,
  shellChromeAria,
  shellChromeText,
} from "../i18n.js";
import type { LiveRoute } from "../liveview-emit.js";
import {
  renderApplication,
  renderLiveNav,
  renderLogFormatter,
  renderRequestContext,
} from "../shell/runtime.js";
import { renderLayouts } from "../shell/web.js";
import { renderTelemetry } from "../telemetry-emit.js";
import { renderGuardErrorModule } from "./denial.js";
import { renderObanConfig } from "./scheduler-emit.js";

export function emitVanillaShellFiles(
  appName: string,
  appModule: string,
  // The deployable's loaded HEEx design pack — owns the design-vocabulary
  // shell surface (core_components.ex, root/app layouts).  The emitter
  // prepares the VMs; the pack's templates own the markup, so
  // `design: coreComponents` vs `design: daisyui` genuinely diverge.
  pack: LoadedPack,
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
  /** The mounted ui (M-T1.11) — present only when it has extractable
   *  user-visible strings, in which case the Gettext backend + `priv/gettext`
   *  catalog are emitted and the `gettext` dep + `html_helpers` import ride
   *  along.  Undefined ⇒ every emitted file is byte-identical to pre-i18n. */
  i18nUi: UiIR | undefined = undefined,
  /** This deployable's authored backend validation messages (M-T1.11) — the
   *  SECOND source of catalog entries beside the ui.  Non-empty turns the
   *  Gettext backend + `priv/gettext` tree + hex dep on even for a
   *  JSON-API-only deployable, whose 422 handler resolves through them. */
  validationMessages: readonly { code: string; text: string }[] = [],
  /** First-boot seed modules (`<App>.<Ctx>.Seeds`, M-T6.37) — appended to
   *  `Application.start/2` after the supervision tree is up.  Empty ⇒ every
   *  emitted file is byte-identical to pre-seeding. */
  seedModules: readonly string[] = [],
): void {
  const hasLiveView = liveRoutes.length > 0 || hasSidebar;
  // Either source of translatable strings turns the runtime on.
  const i18nEnabled = i18nUi !== undefined || validationMessages.length > 0;
  // The SECOND-tier i18n gate (D-I18N-HEEX-ICU): an ICU engine ships only for a
  // ui that actually INTERPOLATES, so a translatable-but-literal-only app pays
  // for no ICU dep.
  const icuEnabled = i18nUi !== undefined && heexIcuEnabled(i18nUi);
  // Swoosh boots its default API client (Hackney) when the `:swoosh`
  // application starts — even for the SMTP adapter, which sends through
  // gen_smtp and needs no HTTP client.  The smtp mailer pulls `swoosh` +
  // `gen_smtp` but NOT `hackney`, so left alone the app crashes at boot with
  // "missing hackney dependency".  When Swoosh is present with no HTTP adapter
  // (ses/sendgrid pull `hackney`), disable the api_client so `:swoosh` starts.
  const swooshSmtpOnly = "swoosh" in extraHexDeps && !("hackney" in extraHexDeps);
  out.set(
    "mix.exs",
    renderVanillaMixExs(
      appName,
      appModule,
      extraHexDeps,
      authEnabled && oidc,
      hasLiveView,
      i18nEnabled,
      icuEnabled,
    ),
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
    renderApplication(appName, appModule, schedulerChildren, preEndpointChildren, seedModules),
  );
  // `mix run priv/repo/seeds.exs` — the canonical Phoenix manual entry, over
  // the SAME modules the boot path calls (so a hand-run and a boot can't
  // disagree).  Emitted only when something actually seeds; the boot path is
  // what the runtime relies on.
  if (seedModules.length > 0) {
    out.set(
      "priv/repo/seeds.exs",
      lines(
        `# Auto-generated.  Do not edit by hand.`,
        `#`,
        `# Manual seeding entry: \`mix run priv/repo/seeds.exs\`.  The SERVER seeds`,
        `# itself at boot (\`<App>.Application.start/2\` calls the same modules once`,
        `# the Repo is supervised), so this script exists for the out-of-band case`,
        `# — e.g. applying an opt-in dataset to an already-migrated database:`,
        `#`,
        `#     LOOM_SEED=demo mix run priv/repo/seeds.exs`,
        `#`,
        `# Ship-once per dataset via the \`__loom_seed\` marker, so re-running is a`,
        `# no-op for datasets already applied.`,
        ...seedModules.map((m) => `${m}.run()`),
        ``,
      ),
    );
  }
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
  // The typed guard denial a pure body (`function` / `domainService` /
  // pure-core op) raises — `<App>.GuardError`, with the rung in its `:kind`
  // field so the controller rescue routes on a FIELD rather than on the
  // message prefix.  Domain layer, not `<App>Web.*`: `function-emit` /
  // `domain-service-emit` render into `lib/<app>/` (M-T6.20).
  out.set(`lib/${appName}/guard_error.ex`, renderGuardErrorModule(appModule));
  out.set(
    `lib/${appName}_web.ex`,
    // The TEMPLATE-side gate is the ui, not the merged catalog: `pgettext/2` in
    // `html_helpers` exists for `~H` templates, and a JSON-API-only deployable
    // has none (its 422 handler calls the gettext runtime fully-qualified).
    renderVanillaWebModule(appName, appModule, hasLiveView, i18nUi !== undefined, icuEnabled),
  );
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
    out.set(
      `lib/${appName}_web/components/core_components.ex`,
      pack.render("core-components", { webModule: `${appModule}Web` }),
    );
    out.set(`lib/${appName}_web/components/layouts.ex`, renderLayouts(appName, appModule));
    out.set(
      `lib/${appName}_web/components/layouts/root.html.heex`,
      pack.render("main", { appName }),
    );
    // The app layout's chrome strings arrive pre-rendered (raw English, or
    // the pgettext call under i18n) so the pack template only places them.
    out.set(
      `lib/${appName}_web/components/layouts/app.html.heex`,
      pack.render("app-shell", {
        hasSidebar,
        webModule: `${appModule}Web`,
        currentUser: authEnabled,
        skipToContent: shellChromeText("skipToContent", i18nEnabled),
        primaryNavAria: shellChromeAria("primaryNav", i18nEnabled),
      }),
    );
    out.set(`lib/${appName}_web/nav.ex`, renderLiveNav(appModule));
  }
  // Translation runtime (M-T1.11) — the Gettext backend, plus the source-language
  // catalog built from the SAME `buildUiCatalog` the other five frontends'
  // runtimes read, MERGED with this deployable's backend validation messages.
  // Two halves, one `.po` tree: a Loom key is globally unique and is always the
  // `msgctxt`, so `mix gettext.merge` and every `.po` importer see one catalog.
  //
  // NOT LiveView-gated: a JSON-API-only deployable with an authored
  // `message "…"` needs the backend + catalog too, and its 422 handler resolves
  // through them.  Neither half ⇒ no module, no `priv/gettext`, no dep.
  if (i18nEnabled) {
    out.set(`lib/${appName}_web/gettext.ex`, renderGettextBackend(appName, appModule));
    // The active HEEx pack's DECLARED chrome (D-PACK-CHROME) — English baked
    // into the pack's own `.hbs`, which no IR walk sees.  `pack ?` because a
    // JSON-API-only deployable reaches this with no pack at all, and since
    // #2480 that deployable can still have a catalog (authored rule messages).
    const packChrome = pack ? packChromeCatalog(pack.manifest) : {};
    out.set(
      `priv/gettext/${GETTEXT_DOMAIN}.pot`,
      renderGettextCatalog(i18nUi, "pot", validationMessages, packChrome),
    );
    out.set(
      `priv/gettext/en/LC_MESSAGES/${GETTEXT_DOMAIN}.po`,
      renderGettextCatalog(i18nUi, "po", validationMessages, packChrome),
    );
    // ICU formatting runs OVER gettext's result, so it ships only alongside
    // it — and only for a ui with an interpolated message.
    if (icuEnabled) {
      out.set(`lib/${appName}/cldr.ex`, renderCldrBackend(appModule));
      out.set(`lib/${appName}_web/i18n.ex`, renderIcuRuntime(appModule));
    }
  }
  out.set(`lib/${appName}_web/controllers/error_json.ex`, renderVanillaErrorJson(appModule));
  out.set(`lib/${appName}_web/body_parser.ex`, renderVanillaBodyParser(appModule));
  out.set(`lib/${appName}_web/fault_handler.ex`, renderVanillaFaultHandler(appModule));
  out.set(
    `lib/${appName}_web/controllers/not_found_controller.ex`,
    renderVanillaNotFoundController(appModule),
  );
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
  /** True when the mounted ui has extractable user-visible strings (M-T1.11) —
   *  adds the `gettext` dep the generated backend + `priv/gettext/**` need.
   *  False ⇒ the dep list is byte-identical to pre-i18n. */
  i18nEnabled = false,
  /** True when that ui INTERPOLATES (D-I18N-HEEX-ICU) — adds the ICU engine the
   *  generated `loom_icu/2` formats through.  Strictly narrower than
   *  `i18nEnabled`: a literal-only app never pays the CLDR compile. */
  icuEnabled = false,
): string {
  // LiveView dep — only when the deployable mounts a HEEx `ui:`.
  // `phoenix_html` is already in the base set; LiveView adds
  // `phoenix_live_view` (the `~H`/`live` runtime).  Pinned to `~> 1.0`.
  const liveViewDep = hasLiveView ? `,\n      {:phoenix_live_view, "~> 1.0"}` : "";
  // Dev convenience for the pack-emitted assets pipeline: `mix assets.build`
  // compiles assets/ (tailwind + esbuild via npm) into priv/static/assets —
  // the same step the Dockerfile's assets-build stage runs for the image.
  // Only LiveView deployables ship assets/, so only they get the alias.
  const assetsAlias = hasLiveView
    ? `,\n      "assets.build": [\n        "cmd --cd assets npm install --no-audit --no-fund",\n        "cmd --cd assets npm run build"\n      ]`
    : "";
  // Translation runtime (M-T1.11) — only when the ui has strings to translate.
  const gettextDep = i18nEnabled ? `,\n      ${GETTEXT_DEP}` : "";
  // The ICU engine (D-I18N-HEEX-ICU) — second-tier, so a translatable app with
  // no interpolation keeps the pre-slice dep list byte-for-byte.
  const icuDeps = icuEnabled ? ICU_DEPS.map((d) => `,\n      ${d}`).join("") : "";
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
      {:telemetry_metrics_prometheus_core, "~> 1.1"},
      # OpenTelemetry tracing: the RequestContext plug opens a SERVER
      # span per request; exported via OTLP/HTTP only when a collector endpoint
      # is set (config/runtime.exs).
      {:opentelemetry_api, "~> 1.4"},
      {:opentelemetry, "~> 1.5"},
      {:opentelemetry_exporter, "~> 1.8"}${liveViewDep}${gettextDep}${icuDeps}${extraBlock}${oidcDep}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.setup"],
      "ecto.setup": ["ecto.create", "ecto.migrate"],
      "ecto.reset": ["ecto.drop", "ecto.setup"]${assetsAlias}
    ]
  end
end
`;
}

function renderVanillaFormatterExs(): string {
  // The generated OpenApiSpex contract layer (lib/<app>_web/api/**) is a
  // machine-emitted nested-struct literal that `mix format` reflows by width; it
  // is never hand-edited, so it is excluded from the format gate.  Every
  // hand-extendable file (domain, controllers, workflows) IS formatted.
  // `.formatter.exs` is evaluated, so `inputs` is computed and the `_web/api/`
  // subtree rejected.
  return `[
  import_deps: [:ecto, :ecto_sql, :phoenix],
  inputs:
    (["mix.exs", ".formatter.exs"] ++ Path.wildcard("{config,lib,test}/**/*.{ex,exs}"))
    |> Enum.reject(&String.contains?(&1, "_web/api/"))
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

function renderVanillaWebModule(
  _appName: string,
  appModule: string,
  hasLiveView: boolean,
  /** True when the ui translates (M-T1.11) — `import <App>Web.Gettext` joins
   *  `html_helpers` so `pgettext/2` resolves unqualified inside every `~H`
   *  template.  False ⇒ byte-identical. */
  i18nEnabled = false,
  /** True when the ui interpolates — `import`s the generated ICU helper so
   *  `loom_icu/2` resolves inside every `~H` template (D-I18N-HEEX-ICU). */
  icuEnabled = false,
): string {
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
      import ${webModule}.CoreComponents${
        // Gettext >= 0.26 SPLIT the backend from the macros: `use Gettext.Backend`
        // defines the backend module, and a consumer gets `pgettext/2` from
        // `use Gettext, backend: …` — an `import` of the backend brings in
        // nothing, which the real compiler reports as `undefined function
        // pgettext/2` at every call site (M-T1.11).
        i18nEnabled ? `\n      use Gettext, backend: ${webModule}.Gettext` : ""
      }${
        // The ICU formatting step that runs over gettext's result.  Named
        // `loom_icu/2` rather than `format/2` precisely because this import
        // lands in every template, where a generic name would collide.
        icuEnabled ? `\n      import ${webModule}.I18n` : ""
      }
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

  plug ${appModule}Web.BodyParser,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  # The router is mounted THROUGH the app-global fault floor, not
  # directly: every fault raised at or below the router — a controller raise, a
  # plug in a pipeline, an \`Ecto\` timeout — is answered by us in RFC 7807
  # instead of by \`Phoenix.Endpoint.RenderErrors\` in whatever shape and content
  # type the framework picks.  See ${appModule}Web.FaultHandler.
  plug ${appModule}Web.FaultHandler
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
  // `!sse:` — the realtime SSE stream (channels.md Part I).  It CANNOT ride the
  // `:api` pipeline: `plug :accepts, ["json"]` answers 406 to the
  // `Accept: text/event-stream` an `EventSource` sends.  Spliced into its own
  // `:sse` pipeline at the router root instead (the path already carries the
  // `/api` prefix, so the served URL is unchanged from the other backends').
  const sseRoutes = apiRoutes.filter((r) => r.path.startsWith("!sse:"));
  const scopedApiRoutes = apiRoutes.filter(
    (r) => !r.path.startsWith("!root:") && !r.path.startsWith("!sse:"),
  );
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
  // Auth plug — populates `conn.assigns.current_user` from the Bearer JWT so
  // principal (tenancy) filters can scope reads by the actor, and 401s a
  // request that carries no valid credentials.  Shared by the `:api` and
  // `:sse` pipelines, so the split below cannot drift into an auth hole.
  const authApiPlug = authEnabled ? `\n    plug ${appModule}Web.Auth` : "";
  // The SSE pipeline runs no `:accepts` negotiation (see above) — that split is
  // the ONLY reason it exists, since `plug :accepts, ["json"]` answers 406 to
  // the `Accept: text/event-stream` an `EventSource` sends.  It DOES carry the
  // same Auth plug: an `auth: required` deployable must not serve an
  // unauthenticated stream, and an untenanted broadcast event carries its FULL
  // payload on this wire (only tenant-scoped events degrade to a refetch
  // ticket).  Hono mounts `/api/realtime` behind `authMiddleware` and python's
  // `AuthMiddleware` covers it — both 401 without credentials — so this is
  // parity, not a Phoenix-specific restriction.  (An earlier comment here
  // claimed those two streams were "likewise unauthenticated".  They are not.)
  const sseLines = sseRoutes
    .map((r) => {
      const path = r.path.slice("!sse:".length);
      return `    ${r.method} "${path}", ${appModule}Web.${r.controller}, ${r.action}`;
    })
    .join("\n");
  const sseBlock = sseLines
    ? `
  pipeline :sse do
    plug :fetch_query_params${authApiPlug}
  end

  scope "/" do
    pipe_through :sse
${sseLines}
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
  // (`authApiPlug` — the :api / :sse Auth plug — is defined above, next to the
  // `:sse` pipeline it also feeds.)
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
${rootApiScope}${sseBlock}${liveScope}${authScope}${spaScope}
  scope "/api", ${appModule}Web do
    pipe_through :api
${routeLines}
  end

  # Framework 404 — a path no route matched, or a verb an existing path does
  # not serve (phoenix's router raises NoRouteError for both).  Declared LAST
  # so it fires only when nothing above did.
  #
  # It exists to own the CONTENT TYPE.  The ErrorJSON view already renders the
  # RFC 7807 body, but phoenix renders it through the \`json\` format, whose
  # MIME type is \`application/json\`, and render_errors exposes no knob for
  # that — a controller is the only place \`application/problem+json\` can be
  # set.  So a
  # client that dispatches on the content type saw the API's one non-problem
  # error response here, at the single point every mistyped request lands.
  scope "/", ${appModule}Web do
    match :*, "/*path", NotFoundController, :not_found
  end
end
`;
}

function renderVanillaBodyParser(appModule: string): string {
  // `Plug.Parsers` runs in the ENDPOINT, before the router, so a body it cannot
  // read never reaches a generated controller.  It propagates to
  // `Phoenix.Endpoint.RenderErrors`, which owns TWO things we then cannot
  // control: the response FORMAT (rendering through `json`, whose MIME type is
  // `application/json` — not the `application/problem+json` every other error
  // on this API sends), and the dev/prod SWITCH (`debug_errors: true`, the
  // generated dev config, answers a full HTML debug page).
  //
  // Both are symptoms of the same thing: the fault is handled by phoenix's
  // machinery instead of by ours.  Rescuing inside a wrapper is the last point
  // where it is still ours — before RenderErrors exists as a concept — so one
  // change fixes the content type AND makes the answer identical in dev and
  // prod.  (Fixing `ErrorJSON`'s body left the content type wrong and the dev
  // HTML in place; routing error views through a `problem_json` format broke
  // negotiation for `Accept: */*`.  Both were downstream of the raise.)
  return `# Auto-generated.
defmodule ${appModule}Web.BodyParser do
  @moduledoc """
  \`Plug.Parsers\` with its failures answered by this app rather than by
  \`Phoenix.Endpoint.RenderErrors\` — see the RFC 7807 contract in
  docs/conformance-semantics.md.  Opts are \`Plug.Parsers\`' own.
  """
  @behaviour Plug

  @impl true
  def init(opts), do: Plug.Parsers.init(opts)

  @impl true
  def call(conn, opts) do
    Plug.Parsers.call(conn, opts)
  rescue
    e in [
      Plug.Parsers.ParseError,
      Plug.Parsers.UnsupportedMediaTypeError,
      Plug.Parsers.RequestTooLargeError
    ] ->
      status = Plug.Exception.status(e)
      title = Plug.Conn.Status.reason_phrase(status)

      # The exception message names the decoder and echoes the raw input, so it
      # is neither safe nor portable as a \`detail\`.  400 gets the one wording
      # every backend sends for this fault; the rest get the reason phrase.
      detail = if status == 400, do: "Malformed JSON in request body", else: title

      body =
        Jason.encode!(%{
          type: "about:blank",
          title: title,
          status: status,
          detail: detail,
          instance: conn.request_path
        })

      conn
      |> Plug.Conn.put_resp_content_type("application/problem+json")
      |> Plug.Conn.send_resp(status, body)
      |> Plug.Conn.halt()
  end
end
`;
}

function renderVanillaFaultHandler(appModule: string): string {
  // ── the app-global RFC 7807 floor (M-T6.30) ──────────────────────────────
  //
  // The four non-elixir backends install an APP-GLOBAL unhandled-exception
  // handler — `app.onError` (hono), `DomainExceptionFilter` (.NET),
  // `ApiExceptionAdvice` (java), `install_error_handlers` (python) — so ANY
  // unmodelled fault, on any route, in any system, answers the RFC 7807
  // envelope.  Vanilla Phoenix had none: its sanitized arm lived only inside
  // the `respond/2` dispatchers that `workflow-execution-emit` /
  // `explicit-handlers-emit` render, so a plain CRUD system emitted no such arm
  // AT ALL and a controller raise fell through to the framework — an HTML
  // debug page in dev (`debug_errors: true`), and in prod a body rendered
  // through `Phoenix.Endpoint.RenderErrors` under `application/json`, with the
  // exception's own message as `detail`.  Three ways to violate the contract on
  // the most common system shape.
  //
  // This is the mirror of node's ROOT `app.onError`: the floor sits at the
  // outermost point that still belongs to this app, and the per-router /
  // per-dispatcher arms stay as REFINEMENTS above it — a workflow's `respond/2`
  // still answers its own ladder; this only catches what nothing else did.
  //
  // WHY A WRAPPER PLUG.  `Plug.Builder` compiles `plug A` / `plug B` into
  // `B.call(A.call(conn))`, so a plug listed in the endpoint cannot rescue the
  // plugs that come AFTER it — a wrapping plug has to invoke the rest itself.
  // That is the same reason `BodyParser` wraps `Plug.Parsers` rather than
  // sitting in front of it, and it buys the same two properties: the content
  // type is ours (`render_errors` exposes no knob for it, and its `json` format
  // is `application/json`), and dev and prod answer IDENTICALLY, because
  // `Plug.Debugger` never sees an exception we already turned into a response.
  //
  // Faults raised by the endpoint plugs ABOVE this one (`Plug.RequestId`,
  // `Plug.Session`, `Plug.Head`, …) still reach `RenderErrors` — nothing in a
  // plug pipeline can wrap what runs before it.  They are framework plugs on a
  // request that has not reached this app's code yet, and `ErrorJSON` renders
  // the same 7807 members for them (the content type is the residue).  The
  // parsers, the one such plug that fails on ordinary bad input, are already
  // covered by `BodyParser`.
  return `# Auto-generated.
defmodule ${appModule}Web.FaultHandler do
  @moduledoc """
  The app-global RFC 7807 floor — see the contract in
  docs/conformance-semantics.md.

  Mounts the router and answers ANY fault below it with the same
  ProblemDetails envelope every modelled error on this API answers, under
  \`application/problem+json\`.  A route that maps the fault itself (a
  workflow's \`respond/2\`, an aggregate controller's rescue clauses) answers
  first and never reaches here; this is what the rest of the app inherits.
  """
  @behaviour Plug

  require Logger

  alias ${appModule}Web.ProblemDetails

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    ${appModule}Web.Router.call(conn, ${appModule}Web.Router.init([]))
  rescue
    # \`Phoenix.Router\`'s dispatch wraps a raise from a controller or pipeline
    # plug in a \`WrapperError\` carrying the conn AS IT WAS at the raise — the
    # one with the request id and any response headers already put.  Prefer it.
    #
    # \`e.kind\`, not a hardcoded \`:error\`: a WrapperError also wraps a THROW or
    # an EXIT (\`kind: :throw | :exit\`), and the kind is load-bearing twice
    # below — \`Exception.format/3\` formats a thrown term as an exception and
    # garbles the log line, and the already-sent re-raise
    # (\`:erlang.raise(kind, …)\`) would convert an exit into an error and lose
    # the original failure signal.
    e in Plug.Conn.WrapperError ->
      handle(e.conn || conn, e.kind, e.reason, e.stack)

    e ->
      handle(conn, :error, e, __STACKTRACE__)
  catch
    # A throw or an exit (an \`Ecto\` pool checkout timeout is the common one)
    # is just as unmodelled as a raise, and reaches the wire the same way.
    kind, reason ->
      handle(conn, kind, reason, __STACKTRACE__)
  end

  defp handle(conn, kind, reason, stack) do
    # The operator keeps everything; the caller gets none of it.  This is the
    # only place the fault is recorded in full, because the sanitized detail
    # below deliberately carries nothing about it.
    Logger.error(Exception.format(kind, reason, stack))

    status = status_for(kind, reason)

    # A response already on the wire cannot be replaced — a chunked SSE stream
    # that raises mid-send is past the point where an envelope is possible.
    # Re-raise so the framework tears the connection down instead of us
    # crashing on \`Plug.Conn.AlreadySentError\` and losing the original fault.
    if conn.state in [:unset, :set, :set_chunked, :set_file] do
      respond(conn, status)
    else
      :erlang.raise(kind, reason, stack)
    end
  end

  # An error the server did not model is a SERVER fault, and its
  # message names modules, SQL text, hosts and connection strings.  The wire
  # gets the one sanitized literal all five backends send; the log line above
  # got the truth.
  defp respond(conn, status) when status >= 500 do
    ProblemDetails.problem_response(conn, 500, "Internal Server Error", "internal")
  end

  # A \`Plug.Exception\` that names a 4xx classified the request, not the server
  # (\`Ecto.NoResultsError\` -> 404, \`Phoenix.ActionClauseError\` -> 400).  Honour
  # the status; the reason phrase is the detail, sanitized by construction the
  # same way \`BodyParser\` sanitizes the parser faults.
  defp respond(conn, status) do
    phrase = Plug.Conn.Status.reason_phrase(status)
    ProblemDetails.problem_response(conn, status, phrase, phrase)
  end

  defp status_for(:error, %{__exception__: true} = e), do: Plug.Exception.status(e)
  defp status_for(_kind, _reason), do: 500
end
`;
}

function renderVanillaNotFoundController(appModule: string): string {
  return `# Auto-generated.
defmodule ${appModule}Web.NotFoundController do
  use ${appModule}Web, :controller

  @moduledoc """
  Catch-all for a request no route matched — an unknown path, or a verb an
  existing path does not serve.  Answers the same RFC 7807 envelope every
  domain error on this API answers, under \`application/problem+json\`.

  The two cases get different statuses.  A phoenix router keys on
  (method, path), so its miss carries no reason and both used to answer 404 —
  but RFC 9110 §15.5.6 reserves 405 for a resource that exists and does not
  serve the method, and the difference is what tells a caller to fix the verb
  rather than the URL.  \`Phoenix.Router.route_info/4\` separates them: ask the
  router the same path under the other verbs.
  """

  @probe_methods ~w(GET POST PUT PATCH DELETE)

  def not_found(conn, _params) do
    allow =
      Enum.filter(@probe_methods, fn method ->
        method != conn.method and serves?(method, conn)
      end)

    case allow do
      [] ->
        respond(conn, 404, "Not Found", "no route for #{conn.method} #{conn.request_path}")

      methods ->
        conn
        |> put_resp_header("allow", Enum.join(methods, ", "))
        |> respond(
          405,
          "Method Not Allowed",
          "method #{conn.method} is not supported for #{conn.request_path}"
        )
    end
  end

  # This controller IS the catch-all, registered for \`:*\`, so route_info
  # matches it for every method on every path.  Counting those would report an
  # \`Allow\` on all four other verbs for a URL that serves nothing — so the
  # module's own route is excluded and only a REAL one counts.
  defp serves?(method, conn) do
    case Phoenix.Router.route_info(${appModule}Web.Router, method, conn.request_path, conn.host) do
      :error -> false
      %{plug: __MODULE__} -> false
      _ -> true
    end
  end

  defp respond(conn, status, title, detail) do
    body =
      Jason.encode!(%{
        type: "about:blank",
        title: title,
        status: status,
        detail: detail,
        instance: conn.request_path
      })

    conn
    |> put_resp_content_type("application/problem+json")
    |> send_resp(status, body)
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
  // The FRAMEWORK error view — what Phoenix renders when a request never
  // reaches a controller (`Phoenix.Router.NoRouteError` for an unknown path or
  // a verb the route does not serve, a 500 from a crash below the pipeline).
  //
  // This is RFC 7807, the same envelope `ProblemDetails` gives every DOMAIN
  // error, because a client parses ONE error shape per API or it parses two.
  // Phoenix's scaffold default, `%{errors: %{detail: …}}`, would answer a
  // wrong verb with a shape that appears nowhere else on the API and satisfies
  // none of RS-9 (`type` present and "about:blank") — framework errors are
  // where the five backends diverge most, so this pins the envelope.
  //
  // `template` is "404.json" / "405.json" / "500.json"; the status prefix is
  // the authority for the numeric member, and `status_message_from_template`
  // gives the reason phrase ("Not Found").
  return `# Auto-generated.
defmodule ${appModule}Web.ErrorJSON do
  def render(template, assigns) do
    status = template |> String.split(".") |> hd() |> String.to_integer()
    title = Phoenix.Controller.status_message_from_template(template)

    %{
      type: "about:blank",
      title: title,
      status: status,
      detail: detail_for(status, assigns, title),
      instance: instance_for(assigns)
    }
  end

  # A >= 500 is the fault nobody modelled, and the exception's message
  # names modules, SQL text and hosts.  It gets the sanitized literal all five
  # backends send, never \`reason.message\`.  (\`${appModule}Web.FaultHandler\`
  # answers everything at or below the router, so what still renders here is a
  # fault in an endpoint plug above it — but the leak must not depend on which
  # of the two paths a request happened to take.)
  defp detail_for(status, _assigns, _title) when status >= 500, do: "internal"

  # Below 500, phoenix passes the raised exception when there is one; its
  # message is a better \`detail\` than the bare reason phrase ("no route found
  # for PUT /api/items").  Falls back to the phrase so the member is never
  # absent.
  defp detail_for(_status, %{reason: %{message: message}}, _title) when is_binary(message),
    do: message

  defp detail_for(_status, _assigns, title), do: title

  defp instance_for(%{conn: %{request_path: path}}) when is_binary(path), do: path
  defp instance_for(_assigns), do: nil
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

# OpenTelemetry: a SERVER span opens per request (the RequestContext
# plug), threading trace_id/span_id onto Logger.metadata (log<->trace
# correlation).  A batch processor buffers spans; the OTLP exporter is turned
# ON in config/runtime.exs ONLY when a collector endpoint is set — default off
# here so a local boot makes no export attempt.  service.name is overridable by
# the OTEL_SERVICE_NAME env (the compose/k8s wiring sets it per deployable).
config :opentelemetry,
  span_processor: :batch,
  traces_exporter: :none

config :opentelemetry, :resource, service: %{name: "${appName}"}

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

# OpenTelemetry export: turn the OTLP/HTTP exporter ON only when a
# collector endpoint is set (the compose stack points it at the bundled jaeger
# collector).  Applies in every env — spans are always created (so trace_id
# rides the logs), but exported only here.  http/protobuf on the standard OTLP
# HTTP port; the exporter appends /v1/traces.
if otlp_endpoint = System.get_env("OTEL_EXPORTER_OTLP_ENDPOINT") do
  config :opentelemetry, traces_exporter: :otlp

  config :opentelemetry_exporter,
    otlp_protocol: :http_protobuf,
    otlp_endpoint: String.trim_trailing(otlp_endpoint, "/")
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
