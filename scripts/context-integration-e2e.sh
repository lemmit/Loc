#!/usr/bin/env bash
# Context-integration runtime e2e (test-placement.md, Phase 3b) — RUN the emitted
# per-context integration test for one backend against a real Postgres.
#
# Generates the `shop.ddd` fixture for the given backend's platform, then invokes
# that backend's NATIVE test runner over the emitted `*IntegrationTest*` file so
# the create → operation (mutate + persist) → find (read back) round-trip
# actually executes end-to-end.  This is the tier the per-PR compile gates are
# structurally blind to: `tsc --noEmit` / `mix compile` / `gradle testClasses`
# prove the test compiles, not that it round-trips through the DB.
#
# Usage:   scripts/context-integration-e2e.sh <node|python|dotnet|java|elixir>
# Env:     PG_HOST (default 127.0.0.1), PG_PORT (default 5432) — the Postgres the
#          URL-driven backends read; the elixir leg uses config/test.exs
#          (localhost:5432) + `mix ecto.create`, so it needs Postgres on 5432.
set -euo pipefail

BACKEND="${1:?usage: context-integration-e2e.sh <backend>}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$REPO_ROOT/test/e2e/fixtures/context-integration/shop.ddd"

OUT="$(mktemp -d)/proj"
DDD="$(mktemp).ddd"
# Swap the deployable platform for this backend; everything else is neutral.
sed "s/platform: node/platform: ${BACKEND}/" "$FIXTURE" > "$DDD"
node "$REPO_ROOT/bin/cli.js" generate system "$DDD" -o "$OUT"
APP="$OUT/api"
cd "$APP"

libpq_url="postgres://postgres:postgres@${PG_HOST}:${PG_PORT}/app"

case "$BACKEND" in
  node)
    npm install
    LOOM_PG_URL="$libpq_url" npx vitest run test/ordering.integration.test.ts
    ;;
  python)
    uv sync
    LOOM_PG_URL="postgresql+asyncpg://postgres:postgres@${PG_HOST}:${PG_PORT}/app" \
      uv run pytest tests/test_ordering_integration.py
    ;;
  dotnet)
    # ConnString() converts the libpq URL to an Npgsql keyword string.
    LOOM_PG_URL="$libpq_url" dotnet test Tests/Api.Tests/Api.Tests.csproj
    ;;
  java)
    # @DynamicPropertySource parses LOOM_PG_URL into spring.datasource.*.
    LOOM_PG_URL="$libpq_url" gradle --no-daemon test
    ;;
  elixir)
    # config/test.exs drives the datasource (localhost:5432, DB api_test); the
    # sandbox rolls back per test after `mix ecto.create && mix ecto.migrate`.
    mix local.hex --force >/dev/null
    mix local.rebar --force >/dev/null
    mix deps.get
    MIX_ENV=test mix ecto.create
    MIX_ENV=test mix ecto.migrate
    MIX_ENV=test mix test test/ordering_integration_test.exs
    ;;
  *)
    echo "unknown backend: $BACKEND" >&2
    exit 2
    ;;
esac
