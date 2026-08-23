# Testing — what goes where

Loom has many test tiers because it generates code for **ten** targets
(five backends, five frontends) and the interesting failures live at
different altitudes. This doc is the **placement guide**: given a change,
which tier proves it, and where a new test belongs. For the exact run
commands and env-var gates, `CLAUDE.md` → "Build & test commands" is the
authoritative list; the CI column here maps each tier to its workflow.

## The mental model

Two axes decide where a test lives:

- **Structural vs behavioral.** *Structural* tests assert the generator
  *emits* the right source — parse/validate the `.ddd`, lower to IR, and
  string-match or typecheck the output (`expect(out).toContain(...)`,
  `tsc --noEmit`). *Behavioral* tests assert the generated code *runs*
  correctly — boot it and exercise real round-trips.
- **Docker-free vs docker.** Most tiers boot in-process (PGlite,
  `app.fetch`, headless Chromium). The cross-backend stack
  (.NET/Java/Phoenix/Python over real Postgres) needs docker and runs
  nightly.

Per-PR coverage is mostly structural + the docker-free behavioral tiers;
the heavy cross-backend/runtime behavioral coverage is nightly.

## The tiers

| Tier | Proves | Run | CI workflow | Per-PR? |
| --- | --- | --- | --- | --- |
| **Fast vitest suite** | Parsing, validation, macro expansion, lowering, IR validate, per-backend **emission** (string-match), printer round-trips, layering invariants. The bulk of the suite. | `npm test` | `test.yml` | ✅ |
| **Langium drift** | `ddd.langium` ↔ committed `src/language/generated/` are in sync. | `npm run langium:generate` | `langium-generated.yml` | ✅ |
| **Behavioral — api / unit** | The **generated Hono backend** behaves: boots on PGlite (in-process, no docker) and runs the DSL-emitted `test e2e … against <node>` (api) + aggregate `test "…"` (unit) suites. DoD rollup onto the requirements graph. | `cd test/behavioral && npm ci && node run.mjs` | `behavioral-e2e.yml` | ✅ |
| **Behavioral — ui** | The **generated React frontend** behaves: `vite build` it, serve it + the Hono backend from one in-process origin, run the emitted `test e2e … against <react>` Playwright round-trips in headless Chromium. | `cd test/behavioral && npm ci && node run-ui.mjs` | `behavioral-ui-e2e.yml` | ✅ |
| **Per-backend build** | Generated backend **compiles** clean. TS (`tsc --noEmit` + tsup), .NET (`build /warnaserror`), Java (`gradle bootJar`), Python (`uv` + ruff + mypy + pytest), Elixir (plain Ecto/Phoenix `mix compile --warnings-as-errors`). | `npm run test:tsc` / `:dotnet` / `:java` / `:python` / `:phoenix` | `hono-build` / `dotnet-build` / `java-build` / `python-build` / `elixir-vanilla-build` | ✅ |
| **Generated frontend build** | Generated frontend typechecks + `vite build`s, per `{example × pack}`. React (`tsc`), Svelte (`svelte-check` + build), Vue (`vue-tsc` + build). | `npm run test:tsc-react` / `:svelte-build` / `:vue-build` | `generated-react-build` / `generated-svelte-build` / `generated-vue-build` | ✅ |
| **Generated frontend runtime** | The built Vue/Svelte bundle actually **runs** — `vite preview` + the emitted Playwright smoke spec (every param-less route loads). Pure client-side, no backend. | `npm run test:vue-e2e` / `:svelte-e2e` | `generated-vue-e2e` / `generated-svelte-e2e` | ✅ |
| **Observability e2e** | The generated backend emits the catalog envelope on stdout (per backend). | `npm run test:obs` (+ `:obs-dotnet/-phoenix/-java/-python`) | `*-obs-e2e.yml` | ✅ |
| **Conformance — parity** | Cross-backend **OpenAPI / wire-shape** parity (the contract is identical across backends). | part of conformance | `conformance-parity.yml` | ✅ |
| **k8s build** | `generate system --k8s` → `helm lint` + `helm template \| kubeconform`. | `npm run test:k8s` | `k8s-build.yml` | ✅ |
| **Pairwise corpus** | Generated feature×feature / feature×adapter **crossings** (capability × storage shape × authz × persistence adapter) get an answer, not an exception — plus node `tsc` and `psql -f` schema-load over an all-pairs cover. The intersections the one-fixture-per-feature corpus structurally cannot reach (#2412, #2387/#2391, #2492). See [`docs/audits/pairwise-corpus-findings-2026-08.md`](audits/pairwise-corpus-findings-2026-08.md). | `npm run test:pairwise-corpus` (+ `:-tsc` / `:-schema-load`) | — (local / on-demand this slice) | ❌ opt-in |
| **Conformance — full** | The DSL-emitted behavioral `test e2e` suites against the **full docker stack** (all backends + Postgres). | `LOOM_E2E=1 npm run test:e2e` | `conformance-full.yml` | ❌ nightly / `run-conformance` label |
| **k8s cluster e2e** | One backend's chart installed into a `kind` cluster + Postgres; real read/write round-trips through the migrated DB. | `npm run test:k8s-e2e` | `k8s-e2e.yml` | ❌ nightly / `e2e-k8s` label |
| **Playground e2e** | The browser playground end to end (editor → generate → **in-browser** bundle → boot → preview) against the production build. Network-gated (esm.sh / jsdelivr / npm). | `cd web && npx playwright test` | `playground-e2e.yml` | ❌ **post-merge** / daily / dispatch |

## Choosing where a new test goes

Walk these in order; stop at the first match.

1. **New/changed grammar, validator, macro, lowering, or IR shape** →
   fast vitest suite (`test/{language,macro,ir,...}`). Add a parsing test
   + a negative validator test where relevant. After a grammar edit,
   re-run `langium:generate` and commit the output.

2. **A backend/frontend now *emits* something new or different** →
   fast vitest suite, one **generator test per affected target**
   (`test/generator/<platform>/`), string-matching the emitted source.
   This is the default home for generator changes — it's fast and exact.
   If the emitted shape is captured in a baseline fixture
   (`test/fixtures/baseline-output/`, regenerated via
   `scripts/capture-baseline-fixture.mjs`), regenerate it.

3. **The emitted code might not *compile*** (a new import, type, or
   dependency) → the matching per-backend / generated-frontend **build**
   gate. Run at least one `LOOM_TS_BUILD=1` / `LOOM_REACT_BUILD=1` pass
   locally.

4. **The emitted code must *behave* — domain logic, an api round-trip, a
   page form** → a behavioral tier:
   - api or pure-domain on the Hono backend → **behavioral api/unit**
     (it's already exercised if the example is in
     `test/behavioral/corpus.json`; add a `test e2e … against <node>`
     or aggregate `test` to the `.ddd`).
   - a React page/form round-trip → **behavioral ui** (add a
     `test e2e … against <react>`; the corpus case needs `"ui": true`).
   - cross-backend behaviour (.NET/Java/Phoenix/Python) → it rides the
     **conformance-full** docker leg; keep the assertion in the emitted
     `test e2e` so every backend runs it.

5. **Cross-backend contract (OpenAPI / wire shape)** → **conformance
   parity** (per-PR). It's mostly automatic from `wireShape`; a new
   contract dimension goes in the parity harness.

6. **Something only observable in the real browser playground** (worker
   IO, service-worker handoff, iframe synthesis, IDB, in-browser npm
   bundle) → **playground e2e** (`web/e2e/`). Remember it's post-merge,
   network-gated, and self-skips when the sandbox can't reach the
   registry — so it's a signal, not a per-PR gate.

### Behavioral corpus constraint

The docker-free behavioral tiers (`test/behavioral/`) require each corpus
system to have **exactly one `platform: node` (Hono) deployable**, so the
host-agnostic, path-matched dispatch is unambiguous. Multi-backend
systems (`examples/showcase.ddd`, `examples/acme.ddd`) stay in the docker
`conformance-full` leg. See `test/behavioral/README.md` for the full
runner mechanics (one-origin serving, async-spawn, the DoD rollup).

### Why so many gates

Structural tests prove code is *emitted*; they can't catch a generated
form that submits a malformed value, a backend that 500s on a real
round-trip, or a duplicate-React bundle. Those only fail when the code
*runs* — which is what the behavioral/runtime/conformance tiers exist
for. Conversely, booting a docker stack to assert a string appears in a
file would be absurdly slow. Put each assertion at the **lowest altitude
that can actually catch the failure**.

## Running any CI gate locally — the reverse index

**Every CI gate runs locally.** Do not push a commit just to see whether a
gate passes — that burns the shared ~20-slot runner pool and turns a
3-minute local check into an hour of queue. This table is the *reverse*
index: given a workflow (check) name, the local command that runs the same
thing. Prerequisites: **docker** = start the daemon first
(`dockerd >/tmp/dockerd.log 2>&1 &`, then wait for `docker info`); **pg** =
a Postgres on `127.0.0.1:5432` with user/password `postgres` (one
`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:18-alpine`
serves every pg row below, or the suite starts its own sidecar where noted);
**mirror** = `LOOM_HEX_MIRROR=1` when hex.pm is unreachable through the
proxy (`docs/tools.md` → "Compiling generated backends in Docker" has the
full per-toolchain write-ups).

Completeness is pinned by `test/system/local-run-mapping.test.ts` — every
workflow file must have a row here, so a new gate without a local recipe
fails the fast suite.

| Workflow | Local command | Needs |
|---|---|---|
| `test.yml` | `npm test` (shards: `-- --shard=i/4`); lint job: `npm run lint && npm run test:biome-gen && npm run test:contrast && cd web && npx tsc -b && npm run test:ddl` | — |
| `langium-generated.yml` | `npm run langium:generate && git diff --exit-code src/language/generated` | — |
| `workflow-lint.yml` | `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest -color` | docker |
| `pr-gate.yml` | nothing to run — it aggregates the other checks; its decision core: `npx vitest run test/system/pr-gate.test.ts` | — |
| `hono-build.yml` | `npm run test:tsc` | — |
| `dotnet-build.yml` | `npm run test:dotnet` (no host SDK? build in `mcr.microsoft.com/dotnet/sdk:10.0`) | docker |
| `java-build.yml` | `npm run test:java` — host JDK is too old; build in `gradle:9-jdk25` per `docs/tools.md` | docker |
| `python-build.yml` | `npm run test:python` (uv on host) | — |
| `elixir-vanilla-build.yml` | `LOOM_HEX_MIRROR=1 npm run test:phoenix` | docker, mirror |
| `corpus-build.yml` | `npm run test:tsc-corpus` / `test:dotnet-corpus` / `test:java-corpus` / `test:python-corpus` (shard: `LOOM_CORPUS_<BACKEND>_CASE=<feature>`) | docker (java/dotnet) |
| `corpus-elixir-build.yml` | `LOOM_HEX_MIRROR=1 npm run test:elixir-corpus` | docker, mirror |
| `generated-react-build.yml` | `npm run test:tsc-react` (shard: `LOOM_REACT_BUILD_CASE=<ddd>:<pack>`) | — |
| `generated-vue-build.yml` | `npm run test:vue-build` | — |
| `generated-svelte-build.yml` | `npm run test:svelte-build` | — |
| `generated-angular-build.yml` | `npm run test:angular-build` | — |
| `generated-feliz-build.yml` | `node scripts/feliz-scaffold-smoke.mjs` (+ the other `scripts/feliz-*-smoke.mjs` scenarios; needs dotnet 10 — container works) | docker |
| `generated-flutter-build.yml` | `flutter analyze` + `flutter build web` over generated output — Flutter SDK container recipe in `docs/tools.md` → "Compiling generated FRONTENDS locally" | docker |
| `generated-react-e2e.yml` | `npm run test:react-e2e` (pack via `LOOM_REACT_E2E_PACK`) | — |
| `generated-vue-e2e.yml` | `npm run test:vue-e2e` | — |
| `generated-svelte-e2e.yml` | `npm run test:svelte-e2e` | — |
| `generated-angular-e2e.yml` | `npm run test:angular-e2e` | — |
| `behavioral-e2e.yml` | `cd test/behavioral && npm ci && node run.mjs` (PGlite — no docker) | — |
| `behavioral-e2e-python.yml` | `cd test/behavioral && node run-python.mjs` | pg |
| `behavioral-e2e-dotnet.yml` | `cd test/behavioral && node run-dotnet.mjs` | pg |
| `behavioral-e2e-dapper.yml` | `cd test/behavioral && node run-dapper.mjs` | pg |
| `behavioral-e2e-java.yml` | `cd test/behavioral && node run-java.mjs` | pg |
| `behavioral-e2e-elixir.yml` | `cd test/behavioral && node run-elixir.mjs` | pg, mirror |
| `behavioral-e2e-mikroorm.yml` | `cd test/behavioral && node run-mikroorm.mjs` | pg |
| `behavioral-ui-e2e.yml` | `cd test/behavioral && node run-ui.mjs` | — |
| `conformance-parity.yml` | `LOOM_E2E_STRICT_PARITY=1 npx vitest run test/e2e/e2e.test.ts` (spec-level parity, no stack boot) | — |
| `conformance-full.yml` | `LOOM_E2E=1 npm run test:e2e` | docker |
| `differential-report.yml` | `LOOM_DIFF_REPORT=1 npx vitest run test/e2e/e2e.test.ts` | docker |
| `schema-load.yml` | `npm run test:schema-load` (or point `LOOM_MIGRATION_PG_URL` at a running pg) | docker |
| `schemathesis.yml` | `npm run test:schemathesis` (needs `uv tool install schemathesis` + `cd test/behavioral && npm ci`) | — |
| `migration-evolution-e2e.yml` | `npm run test:migration-evolution{,-python,-java,-dotnet,-elixir}` | docker |
| `tenancy-e2e.yml` | `npm run test:tenancy{,-python,-java,-dotnet,-elixir}` + `test:tenancy-hierarchy{…}` + `test:tenancy-subtree-explain` (or `LOOM_TENANCY_PG_URL`) | docker |
| `hono-obs-e2e.yml` | `npm run test:obs` | — |
| `dotnet-obs-e2e.yml` | `npm run test:obs-dotnet` | docker |
| `java-obs-e2e.yml` | `npm run test:obs-java` (or `LOOM_OBS_PG_URL`) | docker |
| `python-obs-e2e.yml` | `npm run test:obs-python` (or `LOOM_OBS_PG_URL`) | docker |
| `elixir-vanilla-obs-e2e.yml` | `npm run test:obs-phoenix` | docker |
| `hono-oidc-e2e.yml` | `npm run test:auth-e2e` (dockerized Keycloak) | docker |
| `dotnet-oidc-e2e.yml` | `npm run test:auth-e2e-dotnet` | docker |
| `java-oidc-e2e.yml` | `npm run test:auth-e2e-java` | docker |
| `python-oidc-e2e.yml` | `npm run test:auth-e2e-python` | docker |
| `elixir-oidc-e2e.yml` | `npm run test:auth-e2e-phoenix` | docker, mirror |
| `auth-oidc-compose-e2e.yml` | `npm run test:auth-e2e-compose` (full generated compose stack + dev Keycloak) | docker |
| `elixir-vanilla-vo-e2e.yml` | `LOOM_VO_E2E_PHOENIX_VANILLA=1 npx vitest run test/e2e/vo-roundtrip-elixir-vanilla.test.ts` | docker, mirror |
| `phoenix-ui-e2e.yml` | `npm run test:phoenix-ui-e2e` | docker, mirror |
| `api-call-e2e.yml` | `LOOM_API_CALL_CALLER=<node\|python\|dotnet\|java\|elixir> npm run test:api-call` (pg via `LOOM_API_CALL_PG_URL`; elixir caller adds mirror) | pg |
| `channels-e2e.yml` | `npm run test:channels` family — `test:channels{,-mikroorm,-python,-dotnet,-java,-elixir}`, `-rabbit*` (incl. `-rabbit-mikroorm`), `-kafka*`, `-auth` (pg via `LOOM_CHANNELS_PG_URL`; redis/rabbit/kafka via docker; the two `*-mikroorm` legs are the redis/rabbit suites with `LOOM_CHANNELS_PERSISTENCE=mikroorm` and shifted ports, so they run beside the default ones — the RABBIT one is the durable/outbox-relay leg) | docker, pg |
| `email-e2e.yml` | `npm run test:email{,-python,-dotnet,-java,-elixir}` (pg + a Mailpit container: `LOOM_MAILPIT_SMTP`/`LOOM_MAILPIT_API`) | docker, pg |
| `context-integration-e2e.yml` | `bash scripts/context-integration-e2e.sh <node\|python\|dotnet\|java\|elixir>` | pg |
| `k8s-build.yml` | `npm run test:k8s` (helm + kubeconform on PATH) | — |
| `k8s-e2e.yml` | `kind create cluster` then `npm run test:k8s-e2e` (kind + kubectl + helm) | docker |
| `generated-a11y.yml` | `LOOM_A11Y_E2E=1 LOOM_A11Y_PACK=<pack> npx vitest run test/e2e/generated-a11y-e2e.test.ts` (Playwright chromium) | — |
| `frontend-fullstack-e2e.yml` | `cd test/behavioral && node run-ui.mjs <case>` (non-React cases) | — |
| `playground-e2e.yml` | `cd web && npm ci && npm run e2e` (network-gated: esm.sh/jsdelivr/npm) | network |
| `playground-e2e-no-network.yml` | `cd web && npx playwright test --project=chromium <workspace/history/builder/requirements/editor specs>` + `node scripts/check-eager-chunks.mjs` | — |
| `playground-realm-check.yml` | `cd web && npm run e2e:realm` | — |
| `pages.yml` | `node docs/build.mjs && cd web && npm ci && npm run typecheck && npm run test:ddl && npm run e2e:smoke && npm run build` (deploy half is CI-only) | — |
| `ci-red-alarm.yml` | CI-only housekeeping (main-red notifier) — nothing to reproduce locally | — |
| `quality-delta.yml` | `node scripts/quality-delta.mjs --dry-run` (prints the full report, posts nothing; the Actions-API and R12 sections need `GITHUB_TOKEN` + `GITHUB_REPOSITORY`) | — |
| `cleanup-artifacts.yml` | CI-only housekeeping (artifact tidy) — nothing to reproduce locally | — |
| `flake-budget.yml` | `GITHUB_TOKEN=<token> node scripts/flake-budget.mjs` (prints the report; add `--out r.json` for the issue payloads). Classification logic alone: `npx vitest run test/system/flake-budget.test.ts`. The issue-filing half is CI-only | network |
