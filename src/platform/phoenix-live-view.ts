import type { ComposeServiceShape, PlatformSurface } from "./surface.js";
import { generatePhoenixLiveViewProject } from "../generator/phoenix-live-view/index.js";

// ---------------------------------------------------------------------------
// Phoenix LiveView platform — fullstack Elixir/Ash deployable.
//
// Unlike `dotnet`/`hono` (backend-only) and `react`/`static` (frontend-only),
// a `phoenixLiveView` deployable ships ONE project that both serves an
// Ash-derived API (when `serves:` is populated) AND mounts a `ui:`
// rendered as Phoenix LiveView modules against the `ashPhoenix` HEEx
// design pack.  It owns its own Postgres database (`needsDb: true`),
// matches the backend platforms for `serves:` validity, and matches
// the frontend platforms for `ui:` mount validity (`mountsUi: true`).
//
// V0 STUB: `emitProject` returns a minimal mix project shell so the
// `Platform` enum extension type-checks and existing pipelines stay
// green.  Phase 3 of the plan fills out the Ash domain emission;
// Phase 6 ships the `ashPhoenix` HEEx pack; Phase 7 emits the
// LiveView modules per page.
// ---------------------------------------------------------------------------

const phoenixLiveViewPlatform: PlatformSurface = {
  name: "phoenixLiveView",
  defaultPort: 4000,
  needsDb: true,
  mountsUi: true,
  // Ash code-interface conventions.  A user-declared find named one
  // of these would collide with the auto-generated CRUD action of
  // the same name on the resource module.
  reservedRepositoryFindNames: new Set(["get", "read", "create", "update", "destroy"]),
  emitProject({ contexts, deployable, sys }): Map<string, string> {
    return generatePhoenixLiveViewProject({ contexts, deployable, sys });
  },
  composeService({ slug }): ComposeServiceShape {
    return {
      env: [
        ["DATABASE_URL", `ecto://postgres:postgres@db:5432/${slug}`],
        ["SECRET_KEY_BASE", "loom-dev-secret-replace-in-production-with-mix-phx-gen-secret"],
        ["PHX_HOST", "localhost"],
        ["PHX_SERVER", "true"],
        ["PORT", "4000"],
      ],
      dependsOnDb: true,
      healthPath: "/health",
      internalPort: 4000,
    };
  },
};

export default phoenixLiveViewPlatform;

function snakeApp(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
}

function mixExs(appName: string): string {
  return `defmodule ${pascal(appName)}.MixProject do
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
      mod: {${pascal(appName)}.Application, []},
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
      {:plug_cowboy, "~> 2.5"}
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

function pascal(snake: string): string {
  return snake
    .split("_")
    .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : ""))
    .join("");
}

const FORMATTER_EXS = `[
  import_deps: [:ecto, :ecto_sql, :phoenix, :ash, :ash_postgres, :ash_phoenix],
  subdirectories: ["priv/*/migrations"],
  plugins: [Phoenix.LiveView.HTMLFormatter],
  inputs: ["*.{heex,ex,exs}", "{config,lib,test}/**/*.{heex,ex,exs}", "priv/*/seeds.exs"]
]
`;

const DOCKERFILE = `# syntax=docker/dockerfile:1
# Auto-generated.

ARG ELIXIR_VERSION=1.17.2
ARG OTP_VERSION=27.0.1
ARG DEBIAN_VERSION=bookworm-20240722-slim

ARG BUILDER_IMAGE="hexpm/elixir:\${ELIXIR_VERSION}-erlang-\${OTP_VERSION}-debian-\${DEBIAN_VERSION}"
ARG RUNNER_IMAGE="debian:\${DEBIAN_VERSION}"

FROM \${BUILDER_IMAGE} AS build
RUN apt-get update -y && apt-get install -y build-essential git \\
    && apt-get clean && rm -f /var/lib/apt/lists/*_*
WORKDIR /app
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
COPY --from=build --chown=nobody:root /app/_build/\${MIX_ENV}/rel/app ./
USER nobody
CMD ["/app/bin/server"]
`;

const DOCKERIGNORE = `# Auto-generated.
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
