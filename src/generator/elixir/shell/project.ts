// ---------------------------------------------------------------------------
// Project-scaffold shell files — the multi-stage Dockerfile / .dockerignore.
// Pure string renderers consumed by the orchestrator (`vanilla/
// index.ts`).  The Mix project + formatter config are emitted by
// `vanilla/shell-emit.ts`.
// ---------------------------------------------------------------------------

export function renderDockerfile(
  appName: string,
  embedReact = false,
  spaOutDir = "dist",
  /** kafka-wired projects pull brod, whose crc32cer NIF builds via cmake
   *  (M-T4.4 slice 8d) — absent otherwise so the image stays lean. */
  needsCmake = false,
): string {
  // Embedded-React mode: a first `spa-build` stage runs the SPA's own
  // Vite build (the React project the orchestrator emitted under
  // `assets/`), then the builder stage copies its `dist/` into
  // `priv/static/app` so `mix release` packages it and `Plug.Static`
  // (at `/app`) serves it.  Mirrors the .NET multi-stage embed
  // (spa-build → app build → runtime).
  const spaBuildStage = embedReact
    ? `FROM node:24-alpine AS spa-build
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
    ? `COPY --from=spa-build /spa/${spaOutDir} priv/static/app
`
    : "";
  return `# syntax=docker/dockerfile:1
# Auto-generated.

ARG ELIXIR_VERSION=1.18.4
ARG OTP_VERSION=27.3.4
ARG DEBIAN_VERSION=bookworm-20260610-slim

ARG BUILDER_IMAGE="hexpm/elixir:\${ELIXIR_VERSION}-erlang-\${OTP_VERSION}-debian-\${DEBIAN_VERSION}"
ARG RUNNER_IMAGE="debian:\${DEBIAN_VERSION}"

${spaBuildStage}FROM \${BUILDER_IMAGE} AS build
RUN apt-get update -y && apt-get install -y build-essential${needsCmake ? " cmake" : ""} git ca-certificates \\
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
