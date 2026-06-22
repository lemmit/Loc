import type { BoundedContextIR } from "../../../ir/types/loom-ir.js";
import { upperFirst } from "../../../util/naming.js";
import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

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
  # controller (e.g. a 500 on /openapi.json) renders through them
  # instead of crashing again on a missing default ErrorView.
  render_errors: [
    formats: [json: ${appModule}Web.ErrorJSON, html: ${appModule}Web.ErrorHTML],
    layout: false
  ],
  # LiveView signs the session token embedded in the dead-render (the initial
  # static HTML, before the socket connects).  Without a configured salt the
  # very first render of any LiveView raises, so a generated LiveView UI 500s
  # out of the box — the salt must be present even though the @session_options
  # cookie store carries its own.
  live_view: [signing_salt: "loom-generated"]

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
  //
  // Migrations are no longer run here via a separate `eval` process.  The
  // generated app runs them IN-PROCESS at boot — a supervised one-shot
  // `<App>.Release.Migrator` child placed BEFORE the Endpoint in
  // `Application.start/2` — so the schema exists before the endpoint serves
  // traffic AND the migration-lifecycle log events (`migrations_starting` /
  // `migration_applied` / `migrations_complete` / `migration_failed`) surface
  // on the same structured JSON stream as the rest of the app.  `start` boots
  // the supervision tree (which includes that migrator child), so it's all
  // that's needed here.  `<App>.Release.migrate/0` is still emitted for
  // out-of-band manual runs (`bin/<app> eval`), now sharing the same
  // instrumented `Ecto.Migrator` path.
  return `#!/bin/sh
# Auto-generated.
set -eu

exec "./bin/${appName}" start
`;
}

/** `lib/<app>/release.ex` — release task module + the in-process boot
 *  migrator.
 *
 *  `migrate/0` is the in-process boot migrator: `Application.start/2` calls it
 *  BEFORE building the supervision tree (and so before the Phoenix Endpoint
 *  starts), so a fresh per-backend database gets its schema before any request
 *  is served (the canonical Phoenix migrate-at-boot pattern).  It runs every
 *  pending Ecto migration for each configured repo via `Ecto.Migrator`,
 *  emitting the cross-backend migration-lifecycle log events around the run:
 *    - `migrations_starting {count}` (info) before,
 *    - `migration_applied {id, name}` (info) per applied version,
 *    - `migrations_complete {applied}` (info) after,
 *    - `migration_failed {id, name, error}` (error) in the failure path,
 *      re-raised so a failed migration crashes boot (fail-fast, like the
 *      other backends' boot runners).
 *  These match the catalog entries in `src/generator/_obs/log-events.ts`
 *  exactly, so a downstream log consumer sees one schema across all backends.
 *
 *  `migrate/0` doubles as the out-of-band manual-run entry point
 *  (`bin/<app> eval "<App>.Release.migrate()"`).  It uses
 *  `Ecto.Migrator.with_repo`, which starts + stops its own short-lived Repo,
 *  so it does not depend on the supervised Repo.  Foundation-neutral (pure
 *  Ecto), so both the Ash and vanilla foundations emit it unchanged. */
export function renderRelease(appName: string, appModule: string): string {
  // Migration-lifecycle log calls — identical catalog events the Hono / .NET
  // / Python / Java boot runners emit, so a cross-backend dashboard pivots on
  // one event name (see PR-C #1509 + PR-A #1508).
  const startingCall = renderPhoenixLogCall("migrationsStarting", [
    { name: "count", valueExpr: "length(pending)" },
  ]);
  const appliedCall = renderPhoenixLogCall("migrationApplied", [
    { name: "id", valueExpr: "to_string(version)" },
    { name: "name", valueExpr: "name" },
  ]);
  const completeCall = renderPhoenixLogCall("migrationsComplete", [
    { name: "applied", valueExpr: "length(applied)" },
  ]);
  const failedCall = renderPhoenixLogCall("migrationFailed", [
    { name: "id", valueExpr: "to_string(version)" },
    { name: "name", valueExpr: "name" },
    { name: "error", valueExpr: "Exception.message(error)" },
  ]);
  return `defmodule ${appModule}.Release do
  @moduledoc """
  Release task entry points + the in-process boot migrator.

  \`migrate/0\` is the in-process boot migrator: \`${appModule}.Application.start/2\`
  calls it BEFORE the supervision tree (and so the Phoenix Endpoint) starts, so
  a fresh per-backend database gets its schema before any request is served
  (the canonical Phoenix migrate-at-boot pattern; the generated SQL migrations
  under priv/repo/migrations ship inside the release).  It emits the
  cross-backend migration-lifecycle log events (\`migrations_starting\` /
  \`migration_applied\` / \`migrations_complete\` / \`migration_failed\`) over the
  JSON log stream.  It doubles as the out-of-band manual entry point
  (\`bin/<app> eval "${appModule}.Release.migrate()"\`).
  """
  require Logger
  @app :${appName}

  def migrate do
    load_app()

    for repo <- repos() do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &run_migrations(&1))
    end
  end

  # Runs the repo's pending migrations with the lifecycle events bracketed
  # around the \`Ecto.Migrator.run\`.  \`Ecto.Migrator.migrations/1\` reports the
  # full {status, version, name} list; the pending ones (\`:down\`) give the
  # pre-run count + the version→name map used to label each applied version.
  defp run_migrations(repo) do
    all = Ecto.Migrator.migrations(repo)
    pending = Enum.filter(all, fn {status, _v, _n} -> status == :down end)
    names = Map.new(all, fn {_status, v, n} -> {v, to_string(n)} end)
    ${startingCall}

    try do
      applied = Ecto.Migrator.run(repo, :up, all: true)

      for version <- applied do
        name = Map.get(names, version, "")
        ${appliedCall}
      end

      ${completeCall}
      applied
    rescue
      error ->
        # Best-effort: blame the lowest still-pending version (the one the run
        # would have started on).  \`id\`/\`name\` are "" when nothing was pending.
        version =
          case pending do
            [{_status, v, _n} | _] -> v
            _ -> nil
          end

        name = if version, do: Map.get(names, version, ""), else: ""
        ${failedCall}
        reraise error, __STACKTRACE__
    end
  end

  defp repos do
    Application.fetch_env!(@app, :ecto_repos)
  end

  defp load_app do
    Application.load(@app)
  end
end
`;
}
