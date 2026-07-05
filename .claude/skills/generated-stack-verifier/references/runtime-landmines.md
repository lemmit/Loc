# Runtime landmines — the migrate/boot failures compile-CI can't see

The compile gates (`tsc --noEmit`, `mix compile --warnings-as-errors`, `gradle
testClasses bootJar`, `ruff`/`mypy`) all check the **generated source**. Every
landmine below produces source that **compiles green** and only fails when the
stack actually boots and runs migrations against a real Postgres. That gap is the
entire reason to boot the stack locally. Match the symptom string to a row, then
read the root cause + fix.

## Quick symptom → landmine index

| Symptom string you'd see in `docker compose logs` | Landmine | PR |
|---|---|---|
| `column "updated_at" specified more than once` | audit/`timestamps()` collision | #1475 |
| db container exits; backends log `ECONNREFUSED`; pg logs `unused mount/volume` | PG18 PGDATA / volume path | #1464/#1465 |
| `/health` 200 but first query 500s with `relation "…" does not exist` | migrations silently skipped (Flyway-on-Boot-4) | #1464 |
| every page 302→`/login`; first LiveView dead-render 500s | dev-auth session not seeded + missing `live_view` salt | #1459 |
| guard 500s instead of 403 (`undefined currentUser`, `.length` on non-array) | runtime guard-eval crash | #759/#771 |

---

## 1. `timestamps()` collides with audit columns at migrate (#1475)

**Symptom.** `ecto.migrate` aborts on boot:
```
column "updated_at" specified more than once
```
The Elixir project **compiles cleanly** (`mix compile` validates the schema
module and the migration module separately — both are valid Elixir). The
collision only exists in the executed DDL, so it surfaces only at migrate time.

**Root cause.** A `with audit` / `auditable` capability declares explicit
`created_at` / `updated_at` columns on the state table. The Ecto migration
emitter *also* appended a bundled `timestamps()` macro on every state table,
which adds its **own** `updated_at` — two `updated_at`s in one `CREATE TABLE`.

**Fix (the healthy shape).** The `timestamps()` line is column-aware in
`src/generator/elixir/migrations-emit.ts`: it drops `timestamps()` entirely when
an `updated_at` column is present (the audit columns are the only timestamps) —
matches `src/generator/elixir/vanilla/schema-emit.ts`, so the audit `updated_at`
is emitted exactly once.

**How to catch it locally.** Generate a `.ddd` with an `auditable` aggregate
against the Elixir backend, boot the compose stack, and watch for the migrate
abort in `docker compose logs phoenix_api`. The unit guard is
`test/generator/elixir/elixir-stamping.test.ts` (asserts exactly one
`:updated_at` per migration), but only a boot proves migrate actually runs.

---

## 2. PostgreSQL 18 PGDATA / volume path (#1464 → #1465)

**Symptom.** The `db` container exits or never reaches healthy; every backend
floods `ECONNREFUSED`; the postgres log says something like:
```
PostgreSQL data in /var/lib/postgresql/data (unused mount/volume)
```
Nothing in the generated source is wrong — it compiles and the backends are fine.
The **compose db service** is the bug.

**Root cause.** The image bumped 16 → 18 (#1423). `postgres:18` moved the default
`PGDATA` to a major-version subdirectory (`/var/lib/postgresql/18/docker`) **and**
moved the declared `VOLUME` to `/var/lib/postgresql`. Mounting the named `pgdata`
volume at the old `/var/lib/postgresql/data` path makes the 18 image refuse to
start (it sees the mount as unused). See `docker-library/postgres#1259`.

**Fix (the healthy shape).** From `src/system/index.ts` `renderDockerCompose` —
this is what a correct generated `db:` block looks like:
```yaml
db:
  image: postgres:18-alpine
  environment:
    POSTGRES_DB: postgres
    POSTGRES_USER: postgres
    POSTGRES_PASSWORD: postgres
    PGDATA: /var/lib/postgresql/data        # pin PGDATA back to the legacy path …
  volumes:
    - pgdata:/var/lib/postgresql            # … but mount the VOLUME one level up
    - ./db-init:/docker-entrypoint-initdb.d:ro
  healthcheck:
    test: ["CMD", "pg_isready", "-U", "postgres"]
    interval: 5s
    timeout: 5s
    retries: 10
```
The two-part trick: **`PGDATA` at `.../data`** (legacy) **but the volume mounted
at `/var/lib/postgresql`** (the parent). The interim fix `1a08356` pinned only
`PGDATA`; the complete fix `ee7a7db`/#1465 moved the mount up a level. If you see
the volume mounted at `.../data`, that's the broken predecessor shape.

**How to catch it locally.** Boot any compose stack and check `db` reaches
healthy: `docker compose up -d db && docker compose ps` — if `db` is exited or
unhealthy, `docker compose logs db` shows the unused-mount line. Because the named
volume persists, always tear down with `docker compose down -v` between runs so a
stale `pgdata` from a broken shape doesn't mask the fix.

---

## 3. Migrations silently skipped — Flyway on Spring Boot 4 (#1464)

**Symptom.** The Java backend **boots healthy** (`/health` and even `/ready`
return 200 — the DB *connection* is fine), but the first real repository query
500s:
```
relation "<schema>.<table>" does not exist
```
`gradle testClasses bootJar` is green; the backend starts; only a query that
touches a migrated table fails.

**Root cause.** Spring Boot 4.x no longer auto-configures Flyway from
`flyway-core` alone — `FlywayAutoConfiguration` is now wired by the
`spring-boot-starter-flyway` starter. With bare `flyway-core` and
`ddl-auto: none`, Flyway never runs, so no tables are created, but the app starts
normally.

**Fix (the healthy shape).** In `src/generator/java/emit/program.ts` the build
deps are:
```
implementation("org.springframework.boot:spring-boot-starter-flyway")
implementation("org.flywaydb:flyway-database-postgresql")
```
Not bare `org.flywaydb:flyway-core`. Verified end-to-end against `postgres:18`:
Flyway applies the migration on boot, the schema table exists, and a real query
round-trips.

**How to catch it locally.** This is the textbook case for **why `/health` is not
enough**. Boot the Java backend, then do the read round-trip (`GET <list>`): a
green `/health` with a 500 on the list endpoint is exactly this landmine. The
migration files live under `src/main/resources/db/migration/` as
`V<n>__<Module>_<Name>.sql`.

---

## 4. LiveView dev-auth: 302→/login and dead-render 500 (#1459)

**Symptom.** A generated Phoenix LiveView UI doesn't render in dev:
- every page **302-redirects to `/login`** even though the JSON API works, and
- the first **dead render raises a 500**.

`mix compile` is green — it can't execute mount hooks or discover
config-driven failures.

**Root cause (two gaps).**
1. The dev stub authenticated only the `:api` JSON pipeline (the Auth plug
   accepts every request as a built-in admin). LiveViews authenticate from the
   **browser session** via `LiveAuth.verify_session`, which nothing seeds in dev
   → they redirect to `/login`.
2. The generated `config/config.exs` omitted `live_view: [signing_salt:
   …]`, which LiveView needs to sign the dead-render session token. Without it the
   first static render raises.

**Fix (the healthy shape).**
1. `LiveAuth`'s dev-stub path falls back to the same built-in admin
   (`Auth.dev_user/0`), symmetric with the `:api` plug
   (`src/generator/elixir/auth-emit.ts`). OIDC mode is unchanged — a missing
   session still redirects to `/login` for the real handshake.
2. The generated `config.exs` now emits `live_view: [signing_salt: "loom-generated"]`
   (`src/generator/elixir/shell/config.ts`).

**How to catch it locally.** Generate an Elixir UI deployable, boot it, and
`curl -i http://localhost:4000/public` (or any public page). A `302` to `/login`
or a `500` on the first GET is this landmine. The runtime gate is
`test/e2e/auth-gate-ui-e2e.test.ts` (the `behavioral-ui-e2e.yml` /
`*-oidc-e2e.yml` legs) — booting locally pre-empts it.

---

## 5. Runtime guard-eval crashes — 500 instead of 403 (#759/#771)

**Symptom.** A guarded workflow/operation that should deny with **403** instead
**500s** at request time. The generated code looks correct and compiles.

**Root cause.** The guard condition references something unbound or mistyped that
is valid syntax but crashes when *evaluated* at request time — e.g. Hono once
500'd on an unbound `currentUser` (#759); Phoenix once 500'd on `.length` field
access against a non-array, then on an uncaught `throw` (#771).

**How to catch it locally.** Boot the backend and hit the guarded endpoint
unauthenticated — assert it returns 403, not 500. The parity harness
(`test/e2e/e2e.test.ts`, the runtime-authorization-parity block) does exactly this
across all five backends and dumps each backend's response body + container logs
on any non-403, so the server-side stacktrace surfaces. Mirror that: on a 500,
read `docker compose logs <backend>_api` for the real error.

---

## The meta-lesson

Every row above is a **compile-green / runtime-red** failure: the generated source
type-checks, so the per-PR compile gate is structurally incapable of catching it.
The signal is always at boot or first-query time against a real Postgres. When you
touch a migration emitter, the compose db service, DB wiring, audit/timestamp
columns, or auth/session seeding, a 3-minute local boot + round-trip is the only
gate that sees these — the alternative is finding out a day later when the nightly
`conformance-parity` / `k8s-e2e` / `*-obs-e2e` job goes red on `main`.
