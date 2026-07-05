# Docker recipes — boot, migrate, probe, round-trip per backend

Copy-pasteable commands for booting the **generated** stack and proving it runs.
Every recipe ends the same way: migrations apply, `/ready` returns 200, and a
real read + write round-trips. `/health` is liveness only — it does not prove the
DB; always probe `/ready` and do the round-trip.

## Contents
- [Shared setup: dockerd + generate](#shared-setup)
- [The round-trip assertion (all backends)](#the-round-trip-assertion)
- [Hono (node)](#hono-node)
- [.NET](#net)
- [Java](#java)
- [Python](#python)
- [Elixir / Phoenix (+ the hex mirror)](#elixir--phoenix)
- [Per-backend boot facts table](#per-backend-boot-facts)

---

## Shared setup

Bring up the Docker daemon (sandbox ships the client, not a running daemon; root
+ passwordless sudo). It does **not** persist — relaunch if `docker info` starts
failing mid-session:
```bash
dockerd >/tmp/dockerd.log 2>&1 &
until docker info >/dev/null 2>&1; do sleep 1; done    # readiness gate
```

Generate the system (emits every backend dir + `docker-compose.yml` + `db/`
migrations + `db-init/00-create-databases.sql`):
```bash
node bin/cli.js generate system <file.ddd> -o /tmp/loom-verify
cd /tmp/loom-verify
```
Good small example: `scripts/k8s-e2e/k8s-smoke.ddd` (auth-free `Widget {name,
quantity}`, one backend) with fixture `scripts/k8s-e2e/k8s-smoke.smoke.json`.
Cross-backend parity: `examples/showcase.ddd` (one backend per platform).

The compose stack already encodes the healthy shape: `db` has a `pg_isready`
healthcheck, every backend `depends_on: { db: { condition: service_healthy } }`,
and each backend runs its migrations at boot. **Boot only your backend + db**
(the compose service name is `<slug>_api`, e.g. `hono_api`, `java_api`):
```bash
docker compose up -d db <slug>_api
docker compose ps                 # confirm db is healthy and the backend is up
```
Tear down with `docker compose down -v` — the `-v` drops the `pgdata` volume so
the next run migrates from clean (and a stale volume from a broken db shape can't
mask a fix; see PG18 landmine).

If outbound HTTPS is behind a TLS-intercepting proxy, the e2e harness injects
proxy CAs via `LOOM_E2E_CA_DIR=<dir-of-*.crt>`; a normal environment needs none.

---

## The round-trip assertion

After `/ready` is green, prove the data path — this is the gap `/ready` (a mere
connection check) leaves. Modeled on `scripts/k8s-e2e-smoke.sh` and its fixture
shape `scripts/k8s-e2e/k8s-smoke.smoke.json`:
```json
{ "create": { "path": "/widgets", "body": { "name": "Smoke Widget", "quantity": 7 } },
  "list": "/widgets", "idField": "id" }
```
A backend-agnostic round-trip (Loom's wire shape is identical across backends;
the Elixir backend mounts REST under `/api`, so probe both prefixes):
```bash
PORT=<backend-port>     # 3000 hono / 8080 dotnet / 8081 java / 8000 python / 4000 elixir
BASE="http://localhost:${PORT}"
# READ: list endpoint → migrated table → wire shape → 200 (a missing table 500s)
curl -fsS "${BASE}/widgets"            # or ${BASE}/api/widgets on Elixir
# WRITE: POST a REAL fixture body (domain invariants reject a synthesized one → 422)
curl -fsS -X POST "${BASE}/widgets" -H 'content-type: application/json' \
  -d '{"name":"Smoke Widget","quantity":7}' -i      # expect 201 + an id
# READ BACK: confirm the new id is in the list and the count grew
curl -fsS "${BASE}/widgets"
```
A 500 on the list with a green `/health` is the Flyway/migrate-skipped landmine; a
422 on POST means your fixture body violates a domain invariant — use a real one.
For a scripted, multi-backend version (prefix probing, id read-back, row-count
growth, success marker), lift the `node -` round-trip block from
`scripts/k8s-e2e-smoke.sh` (lines ~173–234).

---

## Hono (node)

Pure Node, lazy pg pool, fastest boot. Drizzle runtime migrator runs at startup
(`await migrate(db, { migrationsFolder: "./db/migrations" })`).

```bash
docker compose up -d db hono_api
until curl -fsS http://localhost:3000/ready >/dev/null 2>&1; do sleep 2; done
# round-trip on :3000 (REST at root). Then: docker compose down -v
```
- DB URL: `DATABASE_URL=postgres://postgres:postgres@db:5432/<slug>` (node-pg URL).
- Out-of-band migrate (inside the project): `npm run db:migrate` → `drizzle-kit migrate`.
- Surface: `src/platform/hono/v5/index.ts` → delegates to `hono/v4/`; routes/health in `src/generator/typescript/emit/`.

The Hono backend also boots **without docker** on PGlite in-process — that's the
`test/behavioral/run.mjs` path (api + unit). For a quick TS-only data-path check
that's faster than compose, see `test/behavioral/README.md`.

---

## .NET

Host has no .NET SDK; build in the SDK container that matches the `net10.0`
target. EF Core `db.Database.Migrate()` runs synchronously at startup.

```bash
# compose handles build+boot if dockerd is up:
docker compose up -d db dotnet_api
until curl -fsS http://localhost:8080/ready >/dev/null 2>&1; do sleep 2; done
# round-trip on :8080. Then: docker compose down -v
```
Spot-check the build by hand in the SDK image:
```bash
docker run --rm -v /tmp/loom-verify/dotnet_api:/src -w /src \
  mcr.microsoft.com/dotnet/sdk:10.0 sh -c 'dotnet restore && dotnet build /warnaserror'
```
- DB URL: `ConnectionStrings__Default=Host=db;Port=5432;Database=<slug>;Username=postgres;Password=postgres` (Npgsql keywords).
- Migrate at boot: `src/generator/dotnet/emit/program.ts` (`db.Database.Migrate()`); history in `__EFMigrationsHistory`.

---

## Java

`gradle testClasses bootJar` runs on the **host** (JDK 21 + Gradle present, no
container needed). Flyway runs on boot **via the starter** (bare `flyway-core`
silently skips migrations on Boot 4 — see landmine #1464).

```bash
# host compile (no docker):
( cd /tmp/loom-verify/java_api && gradle testClasses bootJar )
# full boot + DB via compose:
docker compose up -d db java_api
until curl -fsS http://localhost:8081/ready >/dev/null 2>&1; do sleep 2; done
# round-trip on :8081. Then: docker compose down -v
```
- DB URL: `SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/<slug>` + `SPRING_DATASOURCE_USERNAME/PASSWORD=postgres` (JDBC).
- Migrate at boot: Flyway via `spring-boot-starter-flyway`; `V<n>__<Module>_<Name>.sql` under `src/main/resources/db/migration/`. Build deps in `src/generator/java/emit/program.ts`.
- **The classic Java check:** green `/health` + 500 on the list = migrations skipped. Always do the read round-trip, not just `/ready`.

---

## Python

`uv sync` + ruff + `mypy --strict` + pytest run on the **host**. The migration
runner runs in the FastAPI lifespan at startup (a custom runner, tracked in
`__loom_migrations`, not Alembic).

```bash
# host compile/lint:
( cd /tmp/loom-verify/python_api && uv sync && uv run ruff check && uv run mypy --strict . )
# full boot + DB via compose:
docker compose up -d db python_api
until curl -fsS http://localhost:8000/ready >/dev/null 2>&1; do sleep 2; done
# round-trip on :8000. Then: docker compose down -v
```
- DB URL: `DATABASE_URL=postgresql+asyncpg://postgres:postgres@db:5432/<slug>` (asyncpg dialect).
- Migrate at boot: `await run_migrations()` in the lifespan; emitter `src/generator/python/emit/migrations.ts` → `app/db/migrate.py`. Out of band: `python -m app.db.migrate`.

---

## Elixir / Phoenix

`mix deps.get && mix compile` runs in the `hexpm/elixir` container (host has no
Elixir). `Ecto.Migrator` runs in the release `migrate/0` task before the server
starts (`rel/overlays/bin/server`).

```bash
# full boot + DB via compose (compile + release happen in the image build):
docker compose up -d db phoenix_api
until curl -fsS http://localhost:4000/ready >/dev/null 2>&1; do sleep 2; done
# round-trip on :4000 — REST is under /api here: curl .../api/widgets. down -v after.
```
Spot-check the build by hand:
```bash
docker run --rm -v /tmp/loom-verify/phoenix_api:/src -w /src \
  hexpm/elixir:1.18.4-erlang-27.3.4-debian-bookworm-20260610-slim \
  sh -c 'mix local.hex --force && mix deps.get && mix compile --warnings-as-errors'
```
- DB URL: `DATABASE_URL=ecto://postgres:postgres@db:5432/<slug>` (Ecto URL); also needs `SECRET_KEY_BASE`.
- Migrate at boot: `Ecto.Migrator.run(&1, :up, all: true)` in the generated `release.ex`; migrations under `priv/repo/migrations/`. Surface: `src/platform/elixir.ts`; config (incl. the `live_view` signing salt — landmine #1459) in `src/generator/elixir/shell/config.ts`.
- Watch for the audit/`timestamps()` migrate abort (#1475) and the LiveView 302→/login (#1459) — both in `runtime-landmines.md`.

### `LOOM_HEX_MIRROR=1` — Elixir behind a TLS-fingerprinting proxy

Some egress proxies allowlist by the client's **TLS fingerprint**: system OpenSSL
(curl/.NET/Gradle/Python `ssl`) passes, but **Erlang/OTP's `:ssl` gets a bare HTTP
503**, so `mix local.hex` / `mix deps.get` can't reach hex.pm from the container —
the only thing that fails (the daemon, the image pull, `generate system` all
succeed). Set `LOOM_HEX_MIRROR=1` to route hex.pm through a loopback
TLS-terminating mirror (`scripts/hex-mirror.py`, stdlib Python only) that
re-originates with the accepted fingerprint:
```bash
LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1 npm run test:phoenix
```
`test/e2e/support/hex-mirror.ts` starts the mirror, generates a throwaway CA +
`*.hex.pm` cert, and runs the build container with `--network host --add-host
{builds,repo,hex}.hex.pm:127.0.0.1`, the CA mounted, and `HEX_CACERTS_PATH`
pointed at the OS bundle (Hex uses its own CA store, not the OS one). Bytes pass
through verbatim so Hex's registry signature + tarball checksums still verify.
Needs `python3` + `openssl` and the privilege to bind `:443`. Unset (every CI
runner with direct hex.pm access) it's a no-op. Full write-up:
`experience_gathered.md` §14, `docs/tools.md` → "Compiling generated backends in
Docker".

---

## Per-backend boot facts

| Backend | Compose service | Host port | DB URL env / format | Migration at boot | Surface |
|---|---|---|---|---|---|
| Hono (node) | `hono_api` | 3000 | `DATABASE_URL` = `postgres://…@db:5432/<slug>` | Drizzle `migrate()` at startup | `src/platform/hono/v5/index.ts` |
| .NET | `dotnet_api` | 8080 | `ConnectionStrings__Default` = `Host=db;Port=5432;Database=<slug>;Username=postgres;Password=postgres` | EF Core `db.Database.Migrate()` | `src/platform/dotnet.ts` |
| Java | `java_api` | 8081 (→ container 8080) | `SPRING_DATASOURCE_URL` = `jdbc:postgresql://db:5432/<slug>` | Flyway (starter) on boot | `src/platform/java.ts` |
| Python | `python_api` | 8000 | `DATABASE_URL` = `postgresql+asyncpg://…@db:5432/<slug>` | runtime runner in FastAPI lifespan | `src/platform/python.ts` |
| Elixir | `phoenix_api` | 4000 | `DATABASE_URL` = `ecto://…@db:5432/<slug>` (+ `SECRET_KEY_BASE`) | `Ecto.Migrator` in `release.ex` | `src/platform/elixir.ts` |

All backends expose `/health` (liveness, no DB) and `/ready` (DB-aware). REST is at
the root except the Elixir backend, which mounts it under `/api`. The slug is
`serviceSlug(deployable.name)` (`-` → `_`); the compose `db-init` script creates
one database per slug. Exact ports/env are emitted by each surface's
`composeService` / `defaultPort` — read the surface file if a value looks off
(they can change on fresh `main`).
