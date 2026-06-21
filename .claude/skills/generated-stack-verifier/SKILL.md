---
name: generated-stack-verifier
description: >-
  Boot the GENERATED Loom app stack locally and prove it actually runs —
  migrations apply, the backend reaches its database, and a real read + write
  round-trips — to catch the migrate/runtime bugs the per-PR compile gates
  (`tsc --noEmit`, `mix compile`, `gradle testClasses`) are structurally blind
  to. Use this whenever the question is "does the generated stack actually run?",
  "do the migrations apply?", "boot backend X and hit it", "why is the
  conformance-parity / obs-e2e / k8s-e2e gate red?", or "the db won't come up /
  ECONNREFUSED / relation does not exist / 302 to /login". Reach for it on ANY
  change to the migration emitters, the generated `docker-compose.yml`, the
  postgres `db` service, the DB connection wiring, the boot/health endpoints,
  audit/timestamp columns, or LiveView/auth session seeding — anything where the
  code compiles green but might die when the stack actually boots. It substitutes
  a 3-minute local boot for "wait a day for the nightly heavy gate to tell you the
  db won't start", so you don't push a commit that's red on main. Use it BEFORE
  pushing a change in that blast radius, not after CI goes red.
---

# Generated-stack verifier

Loom's per-PR gates compile the *generated* code (`tsc --noEmit`, `mix compile
--warnings-as-errors`, `gradle testClasses bootJar`, `ruff`/`mypy`, `vue-tsc`).
That catches type errors. It is **structurally blind** to anything that only
fails when the stack actually boots and talks to a real Postgres:

- A bundled `timestamps()` that adds a *second* `updated_at` next to the audit
  columns — the schema module **compiles fine**, but `ecto.migrate` aborts with
  `column "updated_at" specified more than once` (#1475).
- `postgres:18` moved `PGDATA` and the declared `VOLUME`; mount the volume at the
  legacy `.../data` path and the db container **refuses to start** ("unused
  mount/volume") → every backend gets `ECONNREFUSED` (#1464/#1465).
- Bare `flyway-core` on Spring Boot 4 no longer auto-configures Flyway, so the
  backend **boots healthy** but silently skips migrations → the first query hits
  a missing table (`relation "x.x" does not exist`, HTTP 500) (#1464).
- A generated LiveView **compiles**, then 302-redirects every page to `/login`
  and the first dead-render 500s because nothing seeds the dev session (#1459).

All four were invisible to compile-CI and only fired on **already-red `main`**,
caught a day later by a nightly/heavy job (`conformance-parity`, the `obs-*`
legs, `k8s-e2e`). This skill turns that into a local 3-minute check: **generate →
boot → migrate → `/ready` → real read+write round-trip**, the exact gap the
compile gates miss. Run it before you push, and you don't ship the red commit.

The detailed, copy-pasteable per-backend commands live in
`references/docker-recipes.md`. The diagnostic catalogue — every known
migrate/boot failure, its symptom string, root cause, and fix — is
`references/runtime-landmines.md`; **read it first when a boot fails**, the error
string usually maps straight to a known landmine.

## Before anything: orient on fresh `main`

`main` moves fast (parallel agents land PRs continuously) and a stale base lies
twice — you re-verify already-fixed bugs *and* boot code that no longer exists.
Sync first: `git fetch origin main && git reset --hard origin/main` (or rebase).
Several of the landmines above were *fixed* on `main` within hours of being
found; verify against the current emitters, not your memory of them.

Confirm the toolchain is built (`npm install` ran the `prepare` lifecycle;
`src/language/generated/` exists). You generate with `node bin/cli.js`, so the
toolchain must be compiled.

## Step 1 — Orient: which backend, does it need a DB?

A stack verification is scoped to **one target backend at a time** (booting all
five is the nightly `conformance-parity` job's job, not yours). Decide:

1. **Which backend** does your change touch? Match it to its platform surface in
   `src/platform/` (`hono/v5`, `dotnet.ts`, `java.ts`, `python.ts`, `elixir.ts`).
2. **Does it `needsDb`?** Every standard backend does (`needsDb: true`), so a DB
   bug is in scope. A pure-frontend or DB-less change is not what this skill is
   for — use the `LOOM_*` build / `*-e2e` gates instead.
3. **Host compiler vs Docker.** Java (host Gradle, JDK 21) and Python (host `uv`)
   compile and can run *without Docker* — but a real DB round-trip still wants a
   Postgres, easiest via the generated compose. Hono/.NET/Elixir boot via Docker.
   The per-backend matrix and exact commands are in `references/docker-recipes.md`.

The per-backend boot facts you'll need (full table in the recipes file):

| Backend | Port | DB URL env / format | Migration at boot | Health |
|---|---|---|---|---|
| Hono (node) | 3000 | `DATABASE_URL` = `postgres://…@db:5432/<db>` | Drizzle runtime `migrate()` | `/health`, `/ready` |
| .NET | 8080 | `ConnectionStrings__Default` = `Host=db;…` | EF Core `db.Database.Migrate()` | `/health`, `/ready` |
| Java | 8081→8080 | `SPRING_DATASOURCE_URL` = `jdbc:postgresql://db:…` | Flyway (starter) on boot | `/health`, `/ready` |
| Python | 8000 | `DATABASE_URL` = `postgresql+asyncpg://…` | runtime runner in lifespan | `/health`, `/ready` |
| Elixir | 4000 | `DATABASE_URL` = `ecto://…@db:5432/<db>` | `Ecto.Migrator` in `release.ex` | `/health`, `/ready` |

`/health` is liveness (no DB — green while the process runs); `/ready` is
DB-aware. **`/health` passing proves nothing about the DB.** The whole point of
this skill is `/ready` + a real round-trip, because that's where the migrate and
wiring bugs surface.

## Step 2 — Bring up Docker (or use the host compiler)

The sandbox ships the Docker **client** but starts **no daemon**. Bring it up
yourself before any compose/container step (root + passwordless sudo available):

```bash
dockerd >/tmp/dockerd.log 2>&1 &
until docker info >/dev/null 2>&1; do sleep 1; done    # readiness gate
```

The daemon does not persist — if `docker info` starts failing mid-session, just
relaunch it. Image pulls from Docker Hub / `mcr.microsoft.com` work through the
standard egress. For Java and Python you can skip Docker for the *compile* and
boot the host process against a single throwaway Postgres container — see the
recipes file.

## Step 3 — Generate the system

```bash
node bin/cli.js generate system <file.ddd> -o /tmp/loom-verify
```

This emits the full multi-deployable tree: per-backend project dirs, the
`docker-compose.yml`, the `db/` migrations, and `db-init/00-create-databases.sql`
(one `CREATE DATABASE <slug>` per backend). Pick a `.ddd` that exercises your
change — for a CRUD/migrate check, a small single-backend example like
`scripts/k8s-e2e/k8s-smoke.ddd` (auth-free `Widget {name, quantity}`) is ideal;
for cross-backend parity use `examples/showcase.ddd` (one backend per platform).

## Step 4 — Boot + migrate + `/ready` + round-trip

This is the verification. The compose stack already encodes the right shape: the
backend `depends_on: { db: { condition: service_healthy } }`, the db has a
`pg_isready` healthcheck, and each backend runs its migrations at boot. Boot only
your backend's service (and `db`):

```bash
cd /tmp/loom-verify
docker compose up -d db <backend>_api          # e.g. hono_api / java_api
# poll /ready (NOT /health) until it answers 200:
until curl -fsS http://localhost:<port>/ready >/dev/null 2>&1; do sleep 2; done
```

If `/ready` never goes green, the db didn't boot or migrations failed — go
straight to `references/runtime-landmines.md` and `docker compose logs db
<backend>_api`. That is the signal this skill exists to surface.

Then do the **real read + write round-trip** — the assertion shape the
`k8s-e2e` smoke uses (`scripts/k8s-e2e-smoke.sh`), because `/ready` only proves a
*connection*, not that the migrated tables exist and the data path works:

- **read** — `GET <list>` → migrations applied → `findAll` SELECT hits a real
  migrated table → wire shape serializes → `200` (a missing table 500s).
- **write** — `POST <create>` a fixture body → domain invariants → INSERT → `201`
  → read it back through the list and confirm the new id is present and the row
  count grew.

Drive it from a fixture (`scripts/k8s-e2e/k8s-smoke.smoke.json` is the model:
`{create: {path, body}, list, idField}`). Use a real fixture body, not a
synthesized one — domain invariants (e.g. `last4.length == 4`) live in the domain
and a made-up body 422s. The exact `curl`/`node` round-trip snippets are in
`references/docker-recipes.md`. Tear down with `docker compose down -v` (the `-v`
drops the `pgdata` volume so the next run migrates from clean).

## Step 5 — Read failures against the landmine catalogue

When the stack fails to boot/migrate, the error string almost always maps to a
known landmine. Open `references/runtime-landmines.md` and match the symptom:

- `column "updated_at" specified more than once` → audit-column / `timestamps()`
  collision at migrate (#1475).
- db container exits / `ECONNREFUSED` / `unused mount/volume` → PG18 PGDATA /
  volume path (#1464/#1465).
- `relation "…" does not exist`, HTTP 500 on first query, but `/health` is green
  → migrations silently skipped (Flyway-on-Boot-4 starter) (#1464).
- every page 302→`/login`, first LiveView dead-render 500s → dev-auth session not
  seeded / missing `live_view` signing salt (#1459).

Capture `docker compose logs <db|backend>` on failure (the e2e harness in
`test/e2e/e2e.test.ts` dumps `ps -a` + `logs --tail=400` to
`/tmp/loom-e2e-diagnostics.log` for exactly this reason — mirror that).

## Per-backend specifics

The boot mechanics differ enough per backend that the commands live in their own
reference. Read the relevant section of `references/docker-recipes.md`:

- **Hono** — pure Node, lazy pg pool; fastest boot. Drizzle runtime migrator.
- **.NET** — build in the `mcr.microsoft.com/dotnet/sdk:10.0` container (host has
  no SDK); EF Core `Database.Migrate()` at startup.
- **Java** — `gradle testClasses bootJar` on the **host** (JDK 21 + Gradle
  present, no container). Flyway-via-starter at boot.
- **Python** — `uv sync` + run on the **host**; runtime migration runner in the
  FastAPI lifespan.
- **Elixir** — `mix deps.get && mix compile` in the `hexpm/elixir` container.
  **Behind a TLS-fingerprinting egress proxy set `LOOM_HEX_MIRROR=1`** — Erlang's
  `:ssl` gets a bare 503 from the proxy where system OpenSSL passes, so
  `mix deps.get` can't reach hex.pm without the loopback mirror. Full recipe and
  the `Ecto.Migrator` release task in the recipes file.

## Which heavy gate each local check substitutes for

Run the local check so you don't push and wait days for the heavy gate to tell
you the same thing on already-red `main`:

| Local check (this skill) | Heavy gate it pre-empts |
|---|---|
| boot one backend + `/ready` + round-trip | `k8s-e2e.yml` (per-backend kind smoke, nightly / `e2e-k8s` label) |
| 5-backend compose boot + OpenAPI parity | `conformance-parity.yml` (per-PR but ~60min, often the red one) |
| boot + assert catalog envelope on stdout | the `*-obs-e2e.yml` legs (push-to-main, not per-PR) |
| full compose + behavioral DSL e2e | `conformance-full.yml` (nightly only) |

These gates run *after* merge or on a slow cadence, so a runtime bug rides on
`main` until they catch it. A local boot is the cheap pre-flight. Report what you
actually ran and the real result — never claim a round-trip you didn't see go
green.
