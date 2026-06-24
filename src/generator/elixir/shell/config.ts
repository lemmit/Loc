import { renderPhoenixLogCall } from "../../_obs/render-phoenix.js";

// ---------------------------------------------------------------------------
// Release shell files — the release env / server scripts and the
// `<App>.Release` migration task.  (The per-env `config/*.exs` files are
// emitted by `vanilla/shell-emit.ts`.)
// ---------------------------------------------------------------------------

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
  // Run pending Ecto migrations before booting the server.  The
  // per-backend database is created by the compose `db-init` SQL, but its
  // schema is empty on first boot — without this `eval` the server starts
  // against a tableless DB and every query 500s with `42P01 relation does
  // not exist`.  Mirrors the .NET backend's migrate-on-startup; the SQL
  // migrations under priv/repo/migrations ship inside the release.
  return `#!/bin/sh
# Auto-generated.
set -eu

./bin/${appName} eval "${snakeToModule(appName)}.Release.migrate()"

exec "./bin/${appName}" start
`;
}

/** Convert a snake_case OTP app name (`phoenix_api`) to its PascalCase
 *  module prefix (`PhoenixApi`) — local to keep `renderRelServer`'s single
 *  `appName` argument unchanged. */
function snakeToModule(appName: string): string {
  return appName
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** `lib/<app>/release.ex` — release task module.  `migrate/0` runs all
 *  pending Ecto migrations for every configured repo; invoked by
 *  `rel/overlays/bin/server` before the server starts so the schema exists
 *  on first boot.  The canonical Phoenix-release migration pattern (mix
 *  tasks like `ecto.migrate` aren't available in a release). */
export function renderRelease(appName: string, appModule: string): string {
  return `defmodule ${appModule}.Release do
  @moduledoc """
  Release task entry points.  \`migrate/0\` runs every pending Ecto
  migration for each configured repo; \`rel/overlays/bin/server\` calls it
  before booting so a fresh per-backend database gets its schema on first
  start (the generated SQL migrations under priv/repo/migrations ship inside
  the release).
  """
  @app :${appName}

  require Logger

  def migrate do
    load_app()

    for repo <- repos() do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &migrate_repo/1)
    end
  end

  # Runs every pending migration for one repo, emitting the cross-backend
  # migration-lifecycle catalog events (observability.md) at the same level +
  # field names Hono/.NET/Java/Python emit, so a fresh DB boot surfaces the
  # same log stream regardless of backend.
  defp migrate_repo(repo) do
    all = Ecto.Migrator.migrations(repo)
    names = Map.new(all, fn {_status, version, name} -> {version, name} end)
    pending = Enum.count(all, fn {status, _version, _name} -> status == :down end)

    ${renderPhoenixLogCall("migrationsStarting", [{ name: "count", valueExpr: "pending" }])}

    applied =
      try do
        Ecto.Migrator.run(repo, :up, all: true)
      rescue
        error ->
          ${renderPhoenixLogCall("migrationFailed", [
            { name: "error", valueExpr: "Exception.message(error)" },
          ])}
          reraise error, __STACKTRACE__
      end

    for version <- applied do
      ${renderPhoenixLogCall("migrationApplied", [
        { name: "id", valueExpr: "version" },
        { name: "name", valueExpr: "Map.get(names, version)" },
      ])}
    end

    ${renderPhoenixLogCall("migrationsComplete", [{ name: "applied", valueExpr: "length(applied)" }])}
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
