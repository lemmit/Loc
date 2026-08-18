---
name: loom-test-suites
description: >-
  The full Loom test-suite catalog — every opt-in slow suite and its LOOM_* env gate, the corpus
  compile gates, the runtime e2e legs (tenancy, migrations, channels, email, auth/OIDC,
  observability, schema-load, Schemathesis), the behavioral tier and its wire-golden differential,
  plus the Docker recipes for compiling each generated backend locally. Use whenever the task is
  to RUN, pick, or debug a test suite — "run the tenancy e2e", "which suite covers X", "how do I
  compile the generated Java/.NET/Elixir backend", "what does LOOM_<VAR> gate", "mix deps.get
  cannot reach hex", "start dockerd" — or any request to verify a change against a heavier tier
  than `npm test`.
---

# Loom test suites and local build recipes

The `npm test` default excludes every slow suite below; each is gated on its own
`LOOM_*` env var. Placement guidance (which tier a new test belongs in) is
[`docs/testing.md`](../../../docs/testing.md); the toolchain recipes are
[`docs/tools.md`](../../../docs/tools.md).

## Tests

The default `npm test` excludes the slow opt-in suites below. Run a single test by path:

```bash
npm test                                   # fast vitest suite (~all unit + IR + generator tests)
npm run test:watch                         # same, watch mode
npx vitest run test/parsing.test.ts        # one suite
npx vitest run -t "test name pattern"      # filter by name

# Opt-in slow suites (each gated on a LOOM_* env var; default `npm test` excludes them):
npm run test:e2e          # LOOM_E2E=1 — boots docker-compose stack + hits /health + runs DSL e2e + Playwright UI + OpenAPI parity diff
npm run test:tsc          # LOOM_TS_BUILD=1 — emits TS projects and runs `tsc --noEmit` against them
npm run test:tsc-react    # LOOM_REACT_BUILD=1 — emits React projects for every example × design pack and tscs them
                          # CI shards via LOOM_REACT_BUILD_CASE=<ddd-path>:<pack>
npm run test:svelte-build # LOOM_SVELTE_BUILD=1 — emits SvelteKit projects (examples × svelte packs), svelte-checks + vite-builds them
                          # CI shards via LOOM_SVELTE_BUILD_CASE=<ddd-path>:<pack>
npm run test:vue-build    # LOOM_VUE_BUILD=1 — {minimal,scaffold,showcase} × {vuetify,shadcnVue}: vue-tsc + vite build
                          # CI shards via LOOM_VUE_BUILD_CASE=<case>:<pack>
npm run test:angular-build # LOOM_ANGULAR_BUILD=1 — `ng build` over the Angular case × pack matrix (shard via LOOM_ANGULAR_BUILD_CASE)
npm run test:react-e2e    # LOOM_REACT_E2E=1 — RUNTIME e2e: vite build + `vite preview` + emitted Playwright smoke spec
                          # (pure client-side; pack via LOOM_REACT_E2E_PACK). Vue/Svelte/Angular siblings:
npm run test:vue-e2e      # LOOM_VUE_E2E=1 (pack via LOOM_VUE_E2E_PACK)
npm run test:svelte-e2e   # LOOM_SVELTE_E2E=1
npm run test:angular-e2e  # LOOM_ANGULAR_E2E=1 (pack via LOOM_ANGULAR_E2E_PACK)
npm run test:dotnet       # LOOM_DOTNET_BUILD=1 — `dotnet build /warnaserror` against generated .NET projects
npm run test:java         # LOOM_JAVA_BUILD=1 — `gradle testClasses bootJar` against generated Spring Boot projects (JDK 25 + Gradle 9.1+)
npm run test:python       # LOOM_PYTHON_BUILD=1 — `uv sync` + `ruff check` + `mypy --strict` + `pytest` against generated FastAPI projects (uv)
npm run test:phoenix      # LOOM_PHOENIX_VANILLA_BUILD=1 — `mix compile --warnings-as-errors` against plain Ecto/Phoenix in Elixir docker

# Corpus compile gates — every feature fixture in test/fixtures/corpus/*.ddd (feature list from the typed
# manifest test/fixtures/corpus/manifest.ts, minus each backend's COMPILE_SKIP map) compiled per backend:
npm run test:tsc-corpus     # LOOM_TS_BUILD=1  (per-feature shard via LOOM_CORPUS_<BACKEND>_CASE)
npm run test:dotnet-corpus  # LOOM_DOTNET_BUILD=1
npm run test:dapper-corpus  # LOOM_DOTNET_BUILD=1 — same fixtures with persistence: dapper forced
npm run test:java-corpus    # LOOM_JAVA_BUILD=1
npm run test:python-corpus  # LOOM_PYTHON_BUILD=1
npm run test:elixir-corpus  # LOOM_ELIXIR_BUILD=1 — mix compile per feature in the hexpm/elixir image (needs LOOM_HEX_MIRROR)

# Tenancy runtime e2e — flat isolation + registry self-scope/signup bootstrap, all five backends
# (shared harness; docker postgres sidecar, or LOOM_TENANCY_PG_URL to skip it):
npm run test:tenancy               # LOOM_TENANCY_E2E=1 — Hono
npm run test:tenancy-{python,java,dotnet,elixir}   # LOOM_TENANCY_E2E_<BACKEND>=1 — same assertions per backend
# Hierarchy siblings (tenantRegistry TREE: materialized-path setPath + per-request orgPath resolver + row stamp
# + descendant-or-self predicate must AGREE → subtree-scoped reads):
npm run test:tenancy-hierarchy{,-python,-java,-dotnet,-elixir}

# Migration-evolution runtime e2e — proves migrations EVOLVE on data, not just emit/first-boot: per SQL
# backend, (1) migrate-chain schema ≡ fresh-create schema, and (2) seed v1 → evolve .ddd → forward-migrate
# → the row survives with correct values (rename preserved, backfill populated, nullable add NULL).  Shared
# harness (one pg server, chain+fresh DBs, order-independent schema fingerprint via host psql):
npm run test:migration-evolution{,-python,-java,-dotnet,-elixir}   # LOOM_MIGRATION_E2E[_<BACKEND>]=1

# Schema-load gate — does the emitted DDL actually LOAD?  The compile tiers are blind to the
# emitted SCHEMA (it is data, not code), so a chain Postgres will refuse still compiles green on
# every backend (G2/#2316).  Generates every corpus fixture and `psql -f`s its migration chain into
# a throwaway db — nothing compiled, nothing booted.  One db per (fixture, deployable), matching how
# compose provisions them.  node only: MigrationsIR + sql-pg.ts are shared, so one chain covers the
# derivation python/java also emit from.  Runs per-PR (schema-load.yml), not behind a label.
npm run test:schema-load           # LOOM_SCHEMA_LOAD=1 (docker sidecar, or LOOM_MIGRATION_PG_URL)

# Spec-driven contract fuzzing (M-T9.21) — boots the generated Hono backend on PGlite over a real
# port and feeds it its OWN emitted /openapi.json to Schemathesis: never a 500, responses conform to
# the declared schema, declared required/format/enum/bounds honored.  Known findings are ratcheting
# ROOT-CAUSE rules in test/behavioral/schemathesis-waivers.json (unattributed finding fails the run;
# a rule that stops reproducing fails it too), documented in docs/audits/schemathesis-findings-2026-08.md.
# Needs `uv tool install schemathesis` + `cd test/behavioral && npm ci`.  ~1 min; nightly in CI.
npm run test:schemathesis          # LOOM_SCHEMATHESIS=1 (node/Hono leg; other four backends are follow-ups)

# Channels runtime e2e — cross-deployable eventing (redis/rabbitmq/kafka, CloudEvents + outbox relay);
# per-broker × per-backend legs, each behind its own LOOM_CHANNELS_E2E[_<BROKER>][_<BACKEND>] var:
npm run test:channels                                    # redis, Hono
npm run test:channels-{python,dotnet,java,elixir}        # redis, other backends
npm run test:channels-rabbit{,-python,-dotnet,-java,-elixir}
npm run test:channels-kafka{,-python,-dotnet,-java,-elixir}
npm run test:channels-auth                               # broker-auth variant

npm run test:api-call     # LOOM_API_CALL_E2E=1 — typed in-system `api` call between deployables, runtime round-trip

# Email runtime e2e — workflow `mail.send(...)` delivered to a Mailpit sidecar (from/to/subject/body
# asserted via its REST inbox), all five backends:
npm run test:email{,-python,-dotnet,-java,-elixir}       # LOOM_EMAIL_E2E[_<BACKEND>]=1

# Auth/OIDC runtime e2e — generated OIDC code flow (PKCE + refresh rotation) against dockerized Keycloak:
npm run test:auth-e2e              # LOOM_AUTH_E2E=1 — Hono, native boot
npm run test:auth-e2e-{dotnet,java,python}         # LOOM_AUTH_E2E_<BACKEND>=1 — native per backend
npm run test:auth-e2e-compose      # LOOM_AUTH_E2E_COMPOSE=1 — full generated docker-compose stack + bundled dev Keycloak
npm run test:auth-e2e-phoenix      # LOOM_AUTH_E2E_PHOENIX=1 — the Phoenix compose sibling

npm run test:obs          # LOOM_OBS_E2E=1 — boots generated Hono backend, asserts catalog envelope on stdout
npm run test:obs-dotnet   # LOOM_OBS_E2E_DOTNET=1 — same for the .NET backend (postgres sidecar via docker)
npm run test:obs-phoenix  # LOOM_OBS_E2E_PHOENIX_VANILLA=1 — same for the Phoenix backend (postgres sidecar via docker)
npm run test:obs-java     # LOOM_OBS_E2E_JAVA=1 — same for the Java backend (docker postgres, or LOOM_OBS_PG_URL override)
npm run test:obs-python   # LOOM_OBS_E2E_PYTHON=1 — same for the Python backend (docker postgres, or LOOM_OBS_PG_URL override)
npm run test:phoenix-ui-e2e # LOOM_PHOENIX_UI_E2E=1 — LiveView UI smoke against the booted Phoenix backend
npm run test:biome-gen    # LOOM_BIOME=1 — Biome lint against emitted TS/TSX (already run in `test.yml`)
npm run test:contrast     # per-pack WCAG-AA design-token contrast gate (runs in test.yml's lint job)
npm run test:k8s          # LOOM_K8S=1 — `generate system --k8s` → helm lint + helm template | kubeconform (+ raw k8s/); needs helm + kubeconform on PATH
npm run test:k8s-e2e      # cluster smoke — install ONE backend's chart (per-deployable enabled toggle) into a kind cluster + throwaway postgres, assert it boots + /ready + real read (findAll GET) AND write (POST a fixture body → 201 → read back) round-trips; parametrized SMOKE_DDD/SMOKE_BACKEND/SMOKE_FIXTURE (k8s-e2e.yml fans it across backends as a matrix); needs kind + kubectl + helm + docker (run `kind create cluster` first)
```

**Behavioral tier — now ALL FIVE backends (plus a UI tier)** — runs the DSL-emitted `test e2e` (api) + `test` (unit) suites against a booted GENERATED backend, promoting the behavioral domain layer (otherwise nightly-docker-only in `conformance-full`) to a fast per-PR gate. The Hono leg boots on PGlite in-process (no docker, reusing the playground's runners `web/src/testing/*`, `web/src/runtime/ddl.ts`); the cross-backend legs re-point the same backend-agnostic emitted api suite at a real booted process (postgres sidecar; `LOOM_BH_{PY,DOTNET,JAVA,ELIXIR}_BASE` dispatches at an already-running server). Not part of `npm test` (own pinned deps — zod 3 etc.):

```bash
cd test/behavioral && npm ci
node run.mjs          # Hono on PGlite — api + unit both gate (see test/behavioral/README.md)
node run-python.mjs   # generated FastAPI    (behavioral-e2e-python.yml)
node run-dotnet.mjs   # generated .NET/EF    (behavioral-e2e-dotnet.yml)
node run-dapper.mjs   # generated .NET/Dapper — run-dotnet with persistence: dapper forced (behavioral-e2e-dapper.yml)
node run-java.mjs     # generated Spring Boot (behavioral-e2e-java.yml)
node run-elixir.mjs   # generated Phoenix    (behavioral-e2e-elixir.yml)
node run-mikroorm.mjs # generated Hono on the MikroORM persistence adapter (persistence: mikroorm) — real Postgres boot, api tier only (behavioral-e2e-mikroorm.yml; LOOM_BH_MIKRO_BASE)
node run-ui.mjs       # UI tier — vite-built React/Mantine frontend + Hono-on-PGlite origin, emitted *.ui.spec.ts Playwright round-trips (behavioral-ui-e2e.yml; non-React frontends run nightly via frontend-fullstack-e2e.yml)
```

Every one of those runner legs ALSO gates the **cross-backend runtime wire differential** (M-T9.11): each records its requests at its single `fetch` chokepoint and diffs the normalized responses against the committed canonical goldens in `test/behavioral/wire-golden/` (README there). A golden is a reviewed ANSWER KEY, not a majority vote — so the diff names a winner, and because A≡golden ∧ B≡golden ⇒ A≡B the five-way differential becomes five independent per-PR gates at zero new CI boot cost. Known divergences are explicit, ratcheting waivers in `test/_helpers/wire-waivers.ts`. Rebaseline deliberately with `LOOM_WIRE_UPDATE=1 node run.mjs` (node is the oracle) and review the golden diff as the wire-contract change it is; `LOOM_WIRE_OFF=1` is a local-debug escape hatch.

`test/behavioral/corpus.json` is the curated allowlist of BROAD multi-aggregate systems (single-`platform: node`-backend each, so dispatch is unambiguous; UI variants tagged `uiTier: "nightly"`); per-FEATURE cases come from the typed corpus manifest `test/fixtures/corpus/manifest.ts` instead.

`LOOM_E2E_CA_DIR=<dir-of-*.crt>` injects custom CAs when running the e2e suite behind a TLS-intercepting proxy.

## Docker (running the container-backed suites)

**Docker is runnable in the remote/sandbox environment** — the Docker-backed suites above (`test:e2e`, `test:phoenix`, the `obs-*` / `auth-e2e-*` legs, `test:k8s-e2e`) are *not* off-limits. The container ships the Docker **client** but **no running daemon by default, and the daemon is intentionally not auto-started** — bring it up yourself when a task needs it:

```bash
dockerd >/tmp/dockerd.log 2>&1 &     # root + passwordless sudo; backgrounded
until docker info >/dev/null 2>&1; do sleep 1; done   # readiness gate
```

It does **not** persist — if `docker info` starts failing mid-session, just relaunch it (the daemon process gets reaped). Image pulls from Docker Hub / `mcr.microsoft.com` work through the standard egress.

**Every backend target compiles locally without waiting on CI** (verified end-to-end here — generate → compile):

- **Java** — the generated projects target a **Java 25** toolchain (needs Gradle 9.1+). The sandbox host ships JDK 21 + Gradle 8.14, which **cannot** build them, so build in the `gradle:9-jdk25` container (matches the emitted Dockerfile): `docker run --rm --network host -v <deployable>:/src -w /src -v /root/.ccr:/root/.ccr:ro -e JAVA_TOOL_OPTIONS="$JAVA_TOOL_OPTIONS" gradle:9-jdk25 gradle --no-daemon testClasses bootJar`. (CI installs JDK 25 + a pinned Gradle 9.6.1 via `gradle/actions/setup-gradle`.)
- **.NET** — host has no SDK, so build in the `mcr.microsoft.com/dotnet/sdk:10.0` container (matches the `net10.0` target): `dotnet restore` + `dotnet build /warnaserror` are clean.
- **Phoenix/Elixir** — `mix deps.get && mix compile --warnings-as-errors` in the `hexpm/elixir` image, against plain Ecto/Phoenix.
- **Python** — `uv sync` + ruff + mypy + pytest on the host.

The fast recipe for spot-checking a backend by hand: `node bin/cli.js generate system <f.ddd> -o out`, then run that backend's compiler (host for Java/.NET/Python, `docker run … hexpm/elixir … 'mix deps.get && mix compile'` for Phoenix).

**Egress proxy wrinkle (Elixir only):** some proxies allowlist by *TLS fingerprint* — system OpenSSL (curl/.NET/Gradle/Python `ssl`) passes, but Erlang/OTP's `:ssl` gets a bare HTTP 503, so `mix deps.get` can't reach hex.pm from the container. Set **`LOOM_HEX_MIRROR=1`** to route hex.pm through a loopback TLS-terminating mirror (`scripts/hex-mirror.py` via `test/e2e/support/hex-mirror.ts`) that re-originates with the accepted fingerprint — `LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1 npm run test:phoenix` then runs green. Needs `python3` + `openssl` and the privilege to bind `:443`. Unset, it's a no-op (CI runners have direct hex.pm access). Full write-up: [`docs/tools.md`](docs/tools.md) → "Compiling generated backends in Docker"; gotcha log in `experience_gathered.md` §14.
