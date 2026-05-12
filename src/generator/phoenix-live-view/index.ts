import type {
  BoundedContextIR,
  DeployableIR,
  SystemIR,
} from "../../ir/loom-ir.js";
import { pascal, snake, plural } from "../../util/naming.js";
import { emitWorkflows } from "./workflow-emit.js";
import { emitViews } from "./view-emit.js";
import { emitMigrations } from "./migrations-emit.js";
import {
  buildFindActions,
  findRepoFor,
  mergeViewFindsForAgg,
} from "./repository-emit.js";
import { renderAshType, renderExpr } from "./render-expr.js";
import { emitLiveViewPages, type LiveRoute } from "./liveview-emit.js";
import { emitApiControllers, type ApiRoute } from "./api-emit.js";
import { emitOpenApiSpec } from "./openapi-emit.js";
import { emitAuth } from "./auth-emit.js";
import { renderSidebarComponent } from "./sidebar-emit.js";
import { renderThemeCss } from "./theme-emit.js";
import { emitAggregateResources } from "./domain-emit.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView / Ash generator orchestrator.
//
// `generatePhoenixLiveViewProject` is the single entry point called by
// the platform's `emitProject`.  It mirrors dotnet/index.ts's shape:
//
//   - Iterates contexts, aggregates, workflows, views.
//   - Calls per-emitter functions (workflow-emit, view-emit, etc.).
//   - Emits Phoenix/Ash shell files: mix.exs, config/*, lib/<app>/*, etc.
//
// File layout:
//   lib/<app>/<ctx>/<agg>.ex                  — Ash.Resource modules
//   lib/<app>/<ctx>/workflows/<wf>.ex          — workflow modules
//   lib/<app>/<ctx>/views/<view>.ex            — view query modules
//   lib/<app>/<ctx>.ex                         — Ash.Domain per context
//   lib/<app>/repo.ex                          — Ecto.Repo
//   lib/<app>/application.ex                   — supervision tree
//   lib/<app>_web.ex                           — __using__ macro
//   lib/<app>_web/endpoint.ex                  — Phoenix.Endpoint
//   lib/<app>_web/router.ex                    — minimal router scaffold
//   lib/<app>_web/components/layouts.ex        — layout components
//   lib/<app>_web/components/layouts/root.html.heex
//   lib/<app>_web/components/layouts/app.html.heex
//   config/config.exs, dev.exs, prod.exs, runtime.exs
//   priv/repo/migrations/<ts>_create_<table>.exs
//   priv/repo/seeds.exs
//   rel/env.sh.eex, rel/overlays/bin/server
//   mix.exs, .formatter.exs, Dockerfile, .dockerignore
// ---------------------------------------------------------------------------

export interface GeneratePhoenixLiveViewArgs {
  contexts: BoundedContextIR[];
  deployable: DeployableIR;
  sys: SystemIR;
}

export function generatePhoenixLiveViewProject(
  args: GeneratePhoenixLiveViewArgs,
): Map<string, string> {
  const { contexts, deployable, sys } = args;
  const out = new Map<string, string>();

  const appName = toSnakeApp(deployable.name);
  const appModule = toModulePrefix(appName);

  // --- Per-context domain files -------------------------------------------
  for (const ctx of contexts) {
    emitContext(appName, ctx, appModule, out);
  }

  // --- Workflow + view files -----------------------------------------------
  for (const ctx of contexts) {
    emitWorkflows(appName, ctx, appModule, out);
    emitViews(appName, ctx, appModule, out);
  }

  // --- Migrations -----------------------------------------------------------
  emitMigrations(appName, contexts, appModule, out);

  // --- LiveView pages (Phase 7) --------------------------------------------
  // Per PageIR in the deployable's `ui:` block: one
  // lib/<app>_web/live/<page>_live.ex module + a router entry the
  // shell renderer splices into router.ex.
  const { files: liveFiles, routes: liveRoutes } = emitLiveViewPages({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
  });
  for (const [path, content] of liveFiles) out.set(path, content);

  // --- API controllers (Batch A) -------------------------------------------
  // Workflows / Views / Health controllers + their router entries.
  // Workflows / Views are only emitted when `serves:` is populated;
  // Health is always emitted (router references it unconditionally).
  const { files: apiFiles, apiRoutes: baseApiRoutes } = emitApiControllers({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
  });
  for (const [path, content] of apiFiles) out.set(path, content);

  // --- OpenAPI spec (Batch D2) ----------------------------------------------
  // Emits <Api>Spec module, per-aggregate/workflow/view schema modules,
  // OpenapiController, and a GET /api/openapi.json route entry.
  const { files: openApiFiles, routes: openApiRoutes } = emitOpenApiSpec({
    contexts,
    deployable,
    sys,
    appName,
    appModule,
  });
  for (const [path, content] of openApiFiles) out.set(path, content);
  const apiRoutes = [...baseApiRoutes, ...openApiRoutes];

  // --- Auth modules (Batch E4) ----------------------------------------------
  // Emits Auth plug + LiveAuth on_mount when deployable.auth?.required.
  const { files: authFiles, enabled: authEnabled } = emitAuth({
    sys,
    deployable,
    appName,
    appModule,
  });
  for (const [path, content] of authFiles) out.set(path, content);

  // --- Sidebar component (Batch C) -----------------------------------------
  // Emitted when the deployable mounts a `ui:` — derived from
  // MenuBlockIR or per-page menuMeta, identical structure to the
  // React generator's sidebar.
  if (deployable.uiName) {
    const ui = sys.uis.find((u) => u.name === deployable.uiName);
    if (ui) {
      out.set(
        `lib/${appName}_web/components/sidebar.ex`,
        renderSidebarComponent({ ui, appName, appModule }),
      );
    }
  }

  // --- Theme CSS (Batch C) -------------------------------------------------
  // System-level `theme { primary: ..., neutral: ..., radius: ... }`
  // tokens lower to CSS custom properties consumable from any
  // generated layout.  Always emit (empty theme produces a stub).
  out.set(`priv/static/assets/theme.css`, renderThemeCss(sys.theme));

  // --- Shell files ----------------------------------------------------------
  emitShellFiles(appName, appModule, deployable, sys, liveRoutes, apiRoutes, authEnabled, out);

  return out;
}

// ---------------------------------------------------------------------------
// Context emission — one Ash.Resource per aggregate + one Ash.Domain per ctx
// ---------------------------------------------------------------------------

function emitContext(
  appName: string,
  ctx: BoundedContextIR,
  appModule: string,
  out: Map<string, string>,
): void {
  const ctxSnake = snake(ctx.name);
  const contextModule = `${appModule}.${pascal(ctx.name)}`;

  // Enums — Ash enum types
  for (const en of ctx.enums) {
    const path = `lib/${appName}/${ctxSnake}/${snake(en.name)}.ex`;
    out.set(path, renderEnumModule(en, contextModule));
  }

  // Value objects — Ash embedded resources
  for (const vo of ctx.valueObjects) {
    const path = `lib/${appName}/${ctxSnake}/${snake(vo.name)}.ex`;
    out.set(path, renderValueObjectModule(vo, contextModule));
  }

  // Events
  for (const ev of ctx.events) {
    const path = `lib/${appName}/${ctxSnake}/events/${snake(ev.name)}.ex`;
    out.set(path, renderEventModule(ev, contextModule));
  }

  // Aggregates — Ash.Resource modules (D1: validations from operation
  // preconditions / aggregate invariants lower through emitAggregateResources
  // which has the validate-clause emission; this replaces the orchestrator's
  // older renderAggregateModule path).
  const allResources: string[] = [];
  const aggFiles = emitAggregateResources(ctx, appModule, appName);
  for (const [path, content] of aggFiles) out.set(path, content);
  for (const agg of ctx.aggregates) {
    allResources.push(`${contextModule}.${pascal(agg.name)}`);
    for (const part of agg.parts) {
      allResources.push(`${contextModule}.${pascal(part.name)}`);
    }
  }
  // Custom find actions (repository finds + view-derived finds) are
  // spliced in via a separate side-channel — emitAggregateResources
  // doesn't yet consume customFinds, so we wrap each aggregate's
  // emitted source by injecting custom find action lines.  Until
  // emitAggregateResources accepts customFinds, the orchestrator
  // keeps its repository-find responsibility here as a post-pass.
  for (const agg of ctx.aggregates) {
    const repo = findRepoFor(ctx, agg.name);
    const repoWithViews = mergeViewFindsForAgg(agg, repo, ctx);
    if (!repoWithViews) continue;
    const customFinds = buildFindActions(repoWithViews, agg, contextModule);
    if (customFinds.length === 0) continue;
    const path = `lib/${appName}/${ctxSnake}/${snake(agg.name)}.ex`;
    const existing = out.get(path);
    if (!existing) continue;
    // Splice find actions before the `defaults` line inside `actions do`.
    out.set(
      path,
      existing.replace(
        /(  actions do\n)/,
        `$1${customFinds.map((s) => "    " + s).join("\n")}\n\n`,
      ),
    );
  }

  // Domain module per context
  const domainPath = `lib/${appName}/${ctxSnake}.ex`;
  out.set(domainPath, renderDomainModule(ctx, contextModule, allResources));
}

// ---------------------------------------------------------------------------
// Ash.Resource rendering (aggregate)
// ---------------------------------------------------------------------------

function renderAggregateModule(
  agg: import("../../ir/loom-ir.js").AggregateIR,
  _ctx: BoundedContextIR,
  contextModule: string,
  customFinds: string[],
): string {
  const moduleName = `${contextModule}.${pascal(agg.name)}`;
  const tableName = plural(snake(agg.name));
  const idType = idAshType(agg.idValueType);

  // Attributes
  const attrLines = agg.fields.map((f) => {
    const ashType = renderAshType(f.type, contextModule);
    const opts = f.optional ? "allow_nil?: true" : "allow_nil?: false";
    return `    attribute :${snake(f.name)}, ${ashType}, ${opts}`;
  });

  // Relationships (containments)
  const relLines = agg.contains.map((c) => {
    const partModule = `${contextModule}.${pascal(c.partName)}`;
    if (c.collection) {
      return `    has_many :${snake(c.name)}, ${partModule}`;
    }
    return `    has_one :${snake(c.name)}, ${partModule}`;
  });

  // Calculations (derived fields)
  const calcLines = agg.derived.map((d) => {
    const ashType = renderAshType(d.type, contextModule);
    return `    calculate :${snake(d.name)}, ${ashType}, expr(${renderAshExprInline(d.expr, contextModule)})`;
  });

  // Validations (invariants)
  const validationLines = agg.invariants.map((inv) => {
    const exprStr = renderAshExprInline(inv.expr, contextModule);
    if (inv.guard) {
      const guardStr = renderAshExprInline(inv.guard, contextModule);
      return `    validate attribute_does_not_equal(:_placeholder, nil) do\n      where [${exprStr}]\n      message "Invariant: ${inv.source.replace(/"/g, "'")}"\n    end`;
    }
    void exprStr;
    return `    # invariant: ${inv.source}`;
  });

  // Actions — defaults + custom finds
  const defaultActions = `    defaults [:read, :create, :update, :destroy]`;
  const customActionBlock = customFinds.length > 0
    ? "\n" + customFinds.join("\n\n")
    : "";

  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Resource,
    otp_app: :${snake(contextModule.split(".")[0] ?? "app")},
    domain: ${contextModule},
    data_layer: AshPostgres.DataLayer

  postgres do
    table "${tableName}"
    repo ${contextModule.split(".")[0]}.Repo
  end

  attributes do
    uuid_primary_key :id
${attrLines.join("\n")}
  end
${relLines.length > 0 ? "\n  relationships do\n" + relLines.join("\n") + "\n  end\n" : ""}${calcLines.length > 0 ? "\n  calculations do\n" + calcLines.join("\n") + "\n  end\n" : ""}${validationLines.length > 0 ? "\n  validations do\n" + validationLines.join("\n") + "\n  end\n" : ""}
  actions do
${defaultActions}${customActionBlock}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Ash.Resource rendering (entity part / child)
// ---------------------------------------------------------------------------

function renderPartModule(
  part: import("../../ir/loom-ir.js").EntityPartIR,
  parentAgg: import("../../ir/loom-ir.js").AggregateIR,
  contextModule: string,
): string {
  const moduleName = `${contextModule}.${pascal(part.name)}`;
  const tableName = plural(snake(part.name));
  const parentModule = `${contextModule}.${pascal(parentAgg.name)}`;

  const attrLines = part.fields.map((f) => {
    const ashType = renderAshType(f.type, contextModule);
    const opts = f.optional ? "allow_nil?: true" : "allow_nil?: false";
    return `    attribute :${snake(f.name)}, ${ashType}, ${opts}`;
  });

  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Resource,
    otp_app: :${snake(contextModule.split(".")[0] ?? "app")},
    domain: ${contextModule},
    data_layer: AshPostgres.DataLayer

  postgres do
    table "${tableName}"
    repo ${contextModule.split(".")[0]}.Repo
  end

  attributes do
    uuid_primary_key :id
${attrLines.join("\n")}
  end

  relationships do
    belongs_to :${snake(parentAgg.name)}, ${parentModule}, allow_nil?: false
  end

  actions do
    defaults [:read, :create, :update, :destroy]
  end
end
`;
}

// ---------------------------------------------------------------------------
// Enum module
// ---------------------------------------------------------------------------

function renderEnumModule(
  en: import("../../ir/loom-ir.js").EnumIR,
  contextModule: string,
): string {
  const moduleName = `${contextModule}.${pascal(en.name)}`;
  const values = en.values.map((v) => `  :${snake(v)}`).join(",\n");
  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Type.Enum, values: [
${values}
  ]
end
`;
}

// ---------------------------------------------------------------------------
// Value object module (embedded Ash.Resource)
// ---------------------------------------------------------------------------

function renderValueObjectModule(
  vo: import("../../ir/loom-ir.js").ValueObjectIR,
  contextModule: string,
): string {
  const moduleName = `${contextModule}.${pascal(vo.name)}`;
  const attrLines = vo.fields.map((f) => {
    const ashType = renderAshType(f.type, contextModule);
    const opts = f.optional ? "allow_nil?: true" : "allow_nil?: false";
    return `    attribute :${snake(f.name)}, ${ashType}, ${opts}`;
  });

  return `# Auto-generated.
defmodule ${moduleName} do
  use Ash.Resource, data_layer: :embedded

  attributes do
${attrLines.join("\n")}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Event module
// ---------------------------------------------------------------------------

function renderEventModule(
  ev: import("../../ir/loom-ir.js").EventIR,
  contextModule: string,
): string {
  const moduleName = `${contextModule}.Events.${pascal(ev.name)}`;
  void renderAshType; // used in sibling fns
  return `# Auto-generated.
defmodule ${moduleName} do
  @moduledoc "Domain event: ${pascal(ev.name)}"

  defstruct ${ev.fields.map((f) => `:${snake(f.name)}`).join(", ")}
  @type t :: %__MODULE__{
${ev.fields.map((f) => `    ${snake(f.name)}: term()`).join(",\n")}
  }
end
`;
}

// ---------------------------------------------------------------------------
// Ash.Domain rendering (per context)
// ---------------------------------------------------------------------------

function renderDomainModule(
  ctx: BoundedContextIR,
  contextModule: string,
  resources: string[],
): string {
  // E2 — Ash 3.x: `define` calls live INSIDE the `resource ... do`
  // block, NOT in a separate top-level `code_interface do` block
  // (that was Ash 2.x; removed in 3.0).
  const resourceBlocks: string[] = [];
  const partResources = new Set<string>();
  for (const agg of ctx.aggregates) {
    for (const part of agg.parts) {
      partResources.add(`${contextModule}.${pascal(part.name)}`);
    }
  }
  for (const r of resources) {
    const aggName = r.split(".").pop()!;
    // Locate the IR aggregate to enumerate its custom finds.
    const agg = ctx.aggregates.find((a) => pascal(a.name) === aggName);
    if (!agg) {
      // Entity-part resource (child table) — registered with no
      // code-interface defines; Ash 3.x's `resource X` shorthand.
      resourceBlocks.push(`    resource ${r}`);
      continue;
    }
    const defines: string[] = [
      `      define :create_${snake(agg.name)}, action: :create`,
      `      define :list_${snake(plural(agg.name))}, action: :read`,
      `      define :get_${snake(agg.name)}, action: :read, get_by: [:id]`,
      `      define :update_${snake(agg.name)}, action: :update, get_by: [:id]`,
      `      define :destroy_${snake(agg.name)}, action: :destroy, get_by: [:id]`,
    ];
    const repo = ctx.repositories.find((rr) => rr.aggregateName === agg.name);
    if (repo) {
      for (const find of repo.finds) {
        // Skip the IR-enriched "all" find — `define :list_X, action: :read`
        // (above) already provides the equivalent code-interface entry.
        // Emitting `define :all_X, action: :all` would also require a
        // matching custom `read :all do end` action on the resource;
        // dropping both keeps the domain block minimal and compile-clean.
        if (find.name === "all") continue;
        const argsList = find.params.map((p) => `:${snake(p.name)}`).join(", ");
        const argsClause = argsList ? `, args: [${argsList}]` : "";
        defines.push(
          `      define :${snake(find.name)}_${snake(agg.name)}, action: :${snake(find.name)}${argsClause}`,
        );
      }
    }
    resourceBlocks.push(`    resource ${r} do\n${defines.join("\n")}\n    end`);
  }

  return `# Auto-generated.
defmodule ${contextModule} do
  use Ash.Domain

  resources do
${resourceBlocks.join("\n")}
  end
end
`;
}

// ---------------------------------------------------------------------------
// Inline Elixir expression rendering (for Ash expr/filter contexts)
// Delegates to the Phase 3A render-expr module.
// ---------------------------------------------------------------------------

function renderAshExprInline(
  expr: import("../../ir/loom-ir.js").ExprIR,
  contextModule: string,
): string {
  return renderExpr(expr, { thisName: "record", contextModule });
}

// ---------------------------------------------------------------------------
// Shell files — Phoenix boilerplate
// ---------------------------------------------------------------------------

function emitShellFiles(
  appName: string,
  appModule: string,
  deployable: DeployableIR,
  _sys: SystemIR,
  liveRoutes: LiveRoute[],
  apiRoutes: ApiRoute[],
  authEnabled: boolean,
  out: Map<string, string>,
): void {
  const port = deployable.port ?? 4000;

  out.set("mix.exs", renderMixExs(appName, appModule));
  out.set(".formatter.exs", renderFormatterExs());
  out.set("Dockerfile", renderDockerfile(appName));
  out.set(".dockerignore", renderDockerignore());
  // certs/ is the CA-bake landing slot — see the COPY in renderDockerfile.
  // .gitkeep keeps the dir present in git so the COPY is a no-op when
  // no proxy CAs are configured.
  out.set("certs/.gitkeep", "");

  // lib/<app>/repo.ex
  out.set(`lib/${appName}/repo.ex`, renderRepo(appName, appModule));

  // lib/<app>/application.ex
  out.set(`lib/${appName}/application.ex`, renderApplication(appName, appModule));

  // lib/<app>_web.ex
  out.set(`lib/${appName}_web.ex`, renderWebModule(appName, appModule));

  // lib/<app>_web/endpoint.ex
  out.set(`lib/${appName}_web/endpoint.ex`, renderEndpoint(appName, appModule));

  // lib/<app>_web/router.ex
  out.set(
    `lib/${appName}_web/router.ex`,
    renderRouter(appName, appModule, liveRoutes, apiRoutes, authEnabled),
  );

  // lib/<app>_web/components/core_components.ex — minimal stub so
  // the html_helpers macro's `import ...CoreComponents` resolves.
  // Standard Phoenix 1.7 generators ship a much richer module; we
  // emit just the empty wrapper for now since LiveView pages
  // reference components by full module path.
  out.set(
    `lib/${appName}_web/components/core_components.ex`,
    renderCoreComponents(appModule),
  );

  // lib/<app>_web/components/layouts.ex
  out.set(`lib/${appName}_web/components/layouts.ex`, renderLayouts(appName, appModule));

  // lib/<app>_web/components/layouts/root.html.heex
  out.set(`lib/${appName}_web/components/layouts/root.html.heex`, renderRootLayout(appName));

  // lib/<app>_web/components/layouts/app.html.heex
  out.set(`lib/${appName}_web/components/layouts/app.html.heex`, renderAppLayout());

  // Config
  out.set("config/config.exs", renderConfigExs(appName, appModule));
  out.set("config/dev.exs", renderDevExs(appName, appModule, port));
  out.set("config/prod.exs", renderProdExs(appName, appModule));
  out.set("config/runtime.exs", renderRuntimeExs(appName, appModule));

  // Priv
  out.set("priv/repo/seeds.exs", `# Auto-generated — empty seeds stub.\n`);

  // Release
  out.set("rel/env.sh.eex", renderRelEnv(appName));
  out.set("rel/overlays/bin/server", renderRelServer(appName));
}

// ---------------------------------------------------------------------------
// Individual shell file renderers
// ---------------------------------------------------------------------------

function renderMixExs(appName: string, appModule: string): string {
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
      {:phoenix, "~> 1.7"},
      {:phoenix_live_view, "~> 1.0"},
      {:phoenix_html, "~> 4.1"},
      {:phoenix_ecto, "~> 4.4"},
      {:ecto_sql, "~> 3.10"},
      {:postgrex, ">= 0.0.0"},
      {:ash, "~> 3.0"},
      {:ash_postgres, "~> 2.0"},
      {:ash_phoenix, "~> 2.0"},
      {:jason, "~> 1.2"},
      {:bandit, "~> 1.5"},
      {:plug_cowboy, "~> 2.5"},
      {:open_api_spex, "~> 3.0"}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ash.setup"],
      "ecto.setup": ["ecto.create", "ash.codegen", "ash.migrate"],
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

function renderDockerfile(appName: string): string {
  return `# syntax=docker/dockerfile:1
# Auto-generated.

ARG ELIXIR_VERSION=1.17.2
ARG OTP_VERSION=27.0.1
ARG DEBIAN_VERSION=bookworm-20240722-slim

ARG BUILDER_IMAGE="hexpm/elixir:\${ELIXIR_VERSION}-erlang-\${OTP_VERSION}-debian-\${DEBIAN_VERSION}"
ARG RUNNER_IMAGE="debian:\${DEBIAN_VERSION}"

FROM \${BUILDER_IMAGE} AS build
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
COPY mix.exs mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config
COPY config/config.exs config/$MIX_ENV.exs config/
RUN mix deps.compile
COPY priv priv
COPY lib lib
RUN mix compile
COPY config/runtime.exs config/
COPY rel rel
RUN mix release

FROM \${RUNNER_IMAGE}
RUN apt-get update -y \\
    && apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates \\
    && apt-get clean && rm -f /var/lib/apt/lists/*_*
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
WORKDIR /app
RUN chown nobody /app
ENV MIX_ENV="prod"
COPY --from=build --chown=nobody:root /app/_build/\${MIX_ENV}/rel/${appName} ./
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
  return `# Auto-generated.
defmodule ${appModule}.Application do
  use Application

  @impl true
  def start(_type, _args) do
    children = [
      ${appModule}.Repo,
      {Phoenix.PubSub, name: ${appModule}.PubSub},
      ${appModule}Web.Endpoint
    ]

    opts = [strategy: :one_for_one, name: ${appModule}.Supervisor]
    Supervisor.start_link(children, opts)
  end

  @impl true
  def config_change(changed, _new, removed) do
    ${appModule}Web.Endpoint.config_change(changed, removed)
    :ok
  end
end
`;
}

function renderWebModule(appName: string, appModule: string): string {
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

function renderEndpoint(appName: string, appModule: string): string {
  const webModule = `${appModule}Web`;
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
      ? liveLines.replace(/^      /gm, "    ")
      : `    # No pages declared in this deployable's ui: block.`;
    liveScopeBody = `\n${flatLines}`;
  }

  // API routes — Batch A's emitApiControllers returns:
  //   - paths prefixed with `!root:` → outside `/api` scope (health / ready)
  //   - bare paths → inside `scope "/api"`
  const rootApiRoutes = apiRoutes.filter((r) => r.path.startsWith("!root:"));
  const scopedApiRoutes = apiRoutes.filter((r) => !r.path.startsWith("!root:"));
  const scopedLines = scopedApiRoutes
    .map(
      (r) =>
        `    ${r.method} ${JSON.stringify(r.path)}, ${r.controller}, ${r.action}`,
    )
    .join("\n");
  const scopedBody = scopedLines || `    # No API routes — backend has no workflows / views or 'serves:' is empty.`;
  const rootLines = rootApiRoutes
    .map((r) => {
      const path = r.path.slice("!root:".length);
      return `  ${r.method} ${JSON.stringify(path)}, ${webModule}.${r.controller}, ${r.action}`;
    })
    .join("\n");

  // Auth plug line in the :api pipeline — only when auth is enabled.
  const authApiPlug = authEnabled ? `\n    plug ${webModule}.Auth` : "";

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

${rootLines}
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
  \`input\`, \`simple_form\`, \`table\`, \`badge\`, \`empty\`.

  Layouts are intentionally minimal/Tailwind-ish — projects can swap
  in a richer component module without touching the emitter.
  """
  use Phoenix.Component

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

  # ---- Internal helpers -----------------------------------------------------

  defp translate_error({msg, opts}) do
    Enum.reduce(opts, msg, fn {key, value}, acc ->
      String.replace(acc, "%{#{key}}", fn _ -> to_string(value) end)
    end)
  end
end
`;
}

function renderLayouts(appName: string, appModule: string): string {
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

function renderConfigExs(appName: string, appModule: string): string {
  return `# Auto-generated.
import Config

config :${appName}, ecto_repos: [${appModule}.Repo]
config :${appName}, ${appModule}Web.Endpoint, url: [host: "localhost"]

config :${appName},
  ash_domains: [
    # Phase 3 populates this list; domains are registered per context.
  ]

config :phoenix, :json_library, Jason

import_config "\#{config_env()}.exs"
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
  http: [ip: {127, 0, 0, 1}, port: ${port}],
  check_origin: false,
  code_reloader: true,
  debug_errors: true,
  secret_key_base: "dev-secret-key-base-replace-in-production-with-mix-phx-gen-secret",
  watchers: []

config :logger, :console, format: "[$level] $message\\n"
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

  config :${appName}, ${appModule}.Repo,
    ssl: true,
    ssl_opts: [verify: :verify_none]
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
  return `#!/bin/sh
# Auto-generated.
set -euo pipefail

exec "./${appName}/bin/${appName}" start
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSnakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

function toModulePrefix(snakeName: string): string {
  return snakeName
    .split("_")
    .filter(Boolean)
    .map((s) => s[0]!.toUpperCase() + s.slice(1))
    .join("");
}

function idAshType(idValueType: string): string {
  switch (idValueType) {
    case "int": return ":integer";
    case "long": return ":integer";
    case "string": return ":string";
    default: return ":uuid";
  }
}

// suppress unused warning — used in inline require above
void plural;
void idAshType;
