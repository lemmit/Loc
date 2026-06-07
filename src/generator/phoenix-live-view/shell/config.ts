import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Config + release shell files — config/config.exs (with the Ash domain
// registration block), the per-env config files, and the release env /
// server scripts.  Consumed by `emitShellFiles` in ../shell-emit.ts.
// ---------------------------------------------------------------------------

export function renderConfigExs(
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

export function renderDevExs(appName: string, appModule: string, port: number): string {
  return `# Auto-generated.
import Config

# Honor DATABASE_URL when set (containerized dev + e2e harnesses point
# the app at a provisioned database / port), otherwise fall back to the
# local default.  Ecto rejects mixing \`url:\` with discrete host/database
# options, so exactly one branch configures the repo.
if url = System.get_env("DATABASE_URL") do
  config :${appName}, ${appModule}.Repo,
    url: url,
    stacktrace: true,
    show_sensitive_data_on_connection_error: true,
    pool_size: 10
else
  config :${appName}, ${appModule}.Repo,
    username: "postgres",
    password: "postgres",
    hostname: "localhost",
    database: "${appName}_dev",
    stacktrace: true,
    show_sensitive_data_on_connection_error: true,
    pool_size: 10
end

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

export function renderProdExs(appName: string, appModule: string): string {
  return `# Auto-generated.
import Config

config :${appName}, ${appModule}Web.Endpoint,
  cache_static_manifest: "priv/static/cache_manifest.json",
  server: true

config :logger, level: :info
`;
}

export function renderRuntimeExs(appName: string, appModule: string): string {
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

export function renderRelEnv(appName: string): string {
  return `#!/bin/sh
# Auto-generated.

# Elixir release env — set env vars that differ between environments.
# Variables here override config/runtime.exs values.

# Uncomment to use a custom release name:
# export RELEASE_NAME="${appName}"
`;
}

export function renderRelServer(appName: string): string {
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
