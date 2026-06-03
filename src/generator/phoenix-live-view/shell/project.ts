// ---------------------------------------------------------------------------
// Project-scaffold shell files — the Mix project definition, formatter
// config, and the multi-stage Dockerfile / .dockerignore.  Pure string
// renderers consumed by `emitShellFiles` in ../shell-emit.ts.
// ---------------------------------------------------------------------------

export function renderMixExs(
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
      deps: deps(),
      # Dialyzer config — picked up by Dialyxir's \`mix dialyzer\`
      # task when added as a dep.  The ignore_warnings file ships
      # alongside this project at \`.dialyzer_ignore.exs\` with the
      # Ash + Phoenix.Router noise filter pre-tuned.
      dialyzer: [
        ignore_warnings: ".dialyzer_ignore.exs",
        plt_add_apps: [:mix, :ex_unit]
      ]
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

export function renderFormatterExs(): string {
  return `[
  import_deps: [:ecto, :ecto_sql, :phoenix, :ash, :ash_postgres, :ash_phoenix],
  subdirectories: ["priv/*/migrations"],
  plugins: [Phoenix.LiveView.HTMLFormatter],
  inputs: ["*.{heex,ex,exs}", "{config,lib,test}/**/*.{heex,ex,exs}", "priv/*/seeds.exs"]
]
`;
}

export function renderDockerfile(appName: string, embedReact = false): string {
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

export function renderDockerignore(): string {
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
