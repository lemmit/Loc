# Headless behavioral test tier

Boots the **generated** Hono backend on **PGlite** (Postgres-in-WASM,
in-process — no docker, no separate Postgres) and runs the suites Loom
**emits** from the DSL:

- **api** — the generated `e2e/<Sys>.e2e.test.ts` (from `test e2e "…"
  against <node backend>`), dispatched straight into `app.fetch`.
  (`run.mjs`)
- **unit** — the generated pure-domain `*.test.ts` (from aggregate
  `test "…"` blocks). (`run.mjs`)
- **ui** — the generated `*.ui.spec.ts` (from `test e2e "…" against
  <react-deployable>`): real Playwright page-object round-trips against
  the `vite build`-built React frontend wired to the backend.
- **python** — the **generated FastAPI backend** run over real HTTP
  (`run-python.mjs`, corpus `corpus-python.json` + `corpus-python/`). Two
  tiers gate, mirroring the node tier:
  - **python unit** — the emitted pure-domain **pytest** suite
    (`tests/test_<agg>.py`, from aggregate `test "…"` blocks), the Python
    analogue of the node `unit` tier. DB-free (it constructs aggregates in
    memory and asserts), so the runner runs `uv run pytest tests/ -q` right
    after `uv sync`, **before** the uvicorn boot — a domain failure is caught
    even if the Postgres boot is flaky, and the run gates on pytest's exit
    code. Fixtures with no `test "…"` blocks emit no `tests/` dir → the tier
    is **skipped** (only `corpus-python/sales.ddd` carries domain tests today;
    payments/ledger/shapes don't). Per-test lines are parsed from pytest's
    `--junitxml` report and printed `✓ [unit] <fn>`.
  - **python api** — the SAME emitted api e2e, HTTP-dispatched at the booted
    backend. Python has no in-process Postgres, so this needs a real DB
    (`DATABASE_URL`); the emitted api suite is backend-agnostic (HTTP
    contract), so the runner just swaps `app.fetch` for `fetch(BASE + path)`.

  Its own `behavioral-e2e-python.yml` workflow (a `services: postgres`
  sidecar) — the A6.2 second backend for the runtime-semantics RS-rules (see
  `docs/conformance-semantics.md` and
  `docs/old/plans/a6.2-behavioral-tier-second-backend.md`). Needs `uv` + a
  reachable `DATABASE_URL`; run: `node run-python.mjs`. `LOOM_BH_PY_BASE`
  dispatches the api tier at an already-running server (and skips `uv sync`,
  so the unit tier is skipped too).
- **dotnet** — the SAME emitted api e2e, run against a booted **generated
  .NET backend** (ASP.NET + EF Core) over real HTTP (`run-dotnet.mjs`, corpus
  `corpus-dotnet.json` + `corpus-dotnet/`). Like Python, .NET has no
  in-process Postgres, so this boots the generated backend as a real process
  (`dotnet restore` + `dotnet run`) against a real DB and re-points the
  backend-agnostic api suite at it. Its own `behavioral-e2e-dotnet.yml`
  workflow (a `services: postgres` sidecar) — the RST-2 third backend for the
  runtime-semantics RS-rules (see
  `docs/old/plans/runtime-semantics-tier-followups.md`). Needs the .NET SDK
  (`dotnet`) + a reachable `ConnectionStrings__Default`; run:
  `node run-dotnet.mjs`. `LOOM_BH_DOTNET_BASE` dispatches at an
  already-running server (skips the boot).
- **dapper** — the SAME .NET runner and SAME emitted api suite, but forcing the
  `persistence: dapper` adapter (raw Npgsql + hand-rolled SQL, no EF Core)
  instead of the default EF Core (`run-dapper.mjs`). The ONLY delta is a source
  transform: the corpus/systems sources declare `platform: __PLATFORM__`, and
  this runner swaps `__PLATFORM__` for the realization clause
  `dotnet { persistence: dapper }` — literally the same corpus/tests, so the
  drained Dapper adapter gets the same RUNTIME coverage EF Core has (booted,
  migrated, CRUD round-tripped) rather than only the compile gate
  (`test/e2e/fixtures/dotnet-build/dapper*.ddd`). Its own
  `behavioral-e2e-dapper.yml` workflow (a `services: postgres` sidecar); same
  requirements as the EF runner; run: `node run-dapper.mjs`.
  `LOOM_BH_DAPPER_BASE` dispatches at an already-running server (skips the
  boot).
- **java** — the SAME emitted api e2e, run against a booted **generated
  Java backend** (Spring Boot + JPA) over real HTTP (`run-java.mjs`, corpus
  `corpus-java.json` + `corpus-java/`). Like Python/.NET, Java has no
  in-process Postgres, so this builds the generated backend (`gradle bootJar`,
  host-runnable — JDK 21 + Gradle) and boots the jar (`java -jar`) against a
  real DB, re-pointing the backend-agnostic api suite at it. Its own
  `behavioral-e2e-java.yml` workflow (a `services: postgres` sidecar) — the
  RST-3 fourth backend for the runtime-semantics RS-rules (see
  `docs/old/plans/runtime-semantics-tier-followups.md`). Needs JDK 21 + Gradle
  (`gradle`) + a reachable `SPRING_DATASOURCE_URL`; run: `node run-java.mjs`.
  `LOOM_BH_JAVA_BASE` dispatches at an already-running server (skips the boot).
- **elixir** — the SAME emitted api e2e, run against a booted **generated
  Phoenix backend** (plain Ecto/Phoenix) over real HTTP (`run-elixir.mjs`,
  corpus `corpus-elixir.json` + `corpus-elixir/`). Like Python/.NET/Java,
  Phoenix has no in-process Postgres, so this boots the generated project as a
  real process (`mix deps.get` + `ecto.create` + `ecto.migrate` + `phx.server`)
  against a real DB and re-points the backend-agnostic api suite at it. Its own
  `behavioral-e2e-elixir.yml` workflow (a `services: postgres` sidecar) — the
  M-T9.3 FIFTH and final backend on the behavioral tier (see
  `docs/new-plan/T9-toolchain-health.md`). Needs Erlang/OTP + Elixir (`mix`) +
  a reachable `DATABASE_URL` (ecto:// form); run: `node run-elixir.mjs`.
  `LOOM_BH_ELIXIR_BASE` dispatches at an already-running server (skips the
  boot). Behind a TLS-fingerprint-allowlisting egress proxy, `mix deps.get`
  can't reach hex.pm from Elixir's `:ssl` — set `HEX_MIRROR_URL` or run the
  repo's loopback hex mirror (CLAUDE.md → "Egress proxy wrinkle"); CI runners
  have direct hex.pm access, so no mirror is needed there.

  **Warm dependency reuse.** Every case generates a fresh project with the
  *same* hex dep tree, and compiling that tree per case (phoenix/ecto/postgrex/
  opentelemetry → grpcbox+chatterbox rebar3 builds) was ~90% of this leg's wall
  clock. So the DEPENDENCY build is primed once per distinct dep set into
  `LOOM_ELIXIR_DEP_CACHE` (default `.work-elixir/dep-cache`, cached across CI
  runs) and reused: `MIX_DEPS_PATH` points at the shared deps, and each
  `_build/<env>/lib/<dep>` is symlinked into the case's own `_build`. Only
  dependencies are shared — the generated app's build dir is never seeded, so it
  still compiles from scratch every case and a codegen bug can't be masked by a
  stale build. The tree is content-addressed by a hash of the generated
  `defp deps` block + the Erlang/Elixir versions; a mismatch (an `auth {}` case
  adds joken, say) just primes a second tree, and any trouble with the shared
  tree falls back to a full self-contained compile for that case.
  `LOOM_ELIXIR_NO_DEP_CACHE=1` turns the whole mechanism off.
- **mikroorm** — the SAME emitted api e2e, run against a booted **generated
  node/Hono backend on the MikroORM persistence adapter** (`persistence:
  mikroorm`) over real HTTP (`run-mikroorm.mjs`). The default node tier
  (`run.mjs`) boots Hono in-process on PGlite with the DEFAULT drizzle adapter;
  MikroORM uses `@mikro-orm/postgresql`, which needs a REAL Postgres, not
  PGlite, so this models the boot on the cross-backend runners: generate the
  node system, boot the generated server as a real process (`npm install` +
  `tsx index.ts`) against a real DB, and re-point the backend-agnostic api
  suite at it. The corpus is LITERALLY the default node tier's (manifest
  features + shared systems), with ONE source transform — a `persistence:
  mikroorm` realization clause injected onto the `platform: node` deployable
  before `generate system` — so the drained MikroORM adapter gets the SAME
  runtime coverage as drizzle (schema applies via `orm.schema.updateSchema()`
  at boot, CRUD round-trips), not merely tsc-compile coverage. Only the api
  tier gates (the unit tier is pure-domain / persistence-independent, already
  covered by `run.mjs`). Its own `behavioral-e2e-mikroorm.yml` workflow (a
  `services: postgres` sidecar). Needs `node` + a reachable `DATABASE_URL`
  (plain `postgres://` form); run: `node run-mikroorm.mjs`. `LOOM_BH_MIKRO_BASE`
  dispatches at an already-running server (skips the npm install + boot).
- **pagination** — the M-T1.1 / M-T2.6 runtime acceptance capstone
  (`pagination.mjs`, fixture `pagination.ddd`). Boots the generated Hono
  backend on PGlite (same in-process boot as `run.mjs`), then **seeds 1000
  rows** over the real HTTP create surface and drives the paged list endpoint
  (`GET /api/widgets?page=&pageSize=&sort=&dir=`), asserting the
  server-computed window, envelope counters (`total`/`totalPages`), and
  whitelisted ORDER BY. This is the seed-and-page property the emitted DSL
  `test e2e` **cannot** express — it has no loop, so it can't seed a real
  second page. The fixture seeds `name` in the reverse order of `rank` (name
  asc == rank desc), so a server that ignored the `sort` field, sorted by the
  wrong column, or dropped the offset is caught rather than masked by a
  coincidentally-shared order. Gates in `behavioral-e2e.yml` right after the
  api/unit tier; run: `node pagination.mjs`.
- **paged-ui** — the browser half of the same story (`paged-ui.mjs`, fixture
  `paged-ui.ddd`, spec `paged-ui.pw.ts`). `pagination.mjs` proves the *server*
  windows correctly; this proves the page an author actually **writes** can
  reach those windows. The fixture's `WidgetList` is the simplest spelling —
  a bare `Table` over `.all`, no `paged:`, no `page:`, no state block — which
  is auto-upgraded to server paging at the macro layer; before that it
  rendered the backend's default first window with no pager, so rows 21+ were
  unreachable and nothing on screen said so. It reuses the UI tier's
  one-origin stack (`ui-stack.mjs`: generated Hono backend on PGlite + the
  vite-built React bundle), seeds 1000 widgets over HTTP, then drives the
  built page in headless Chromium: `Next` must reach rows the first window
  never contained, the pager's count must come from the server's
  `totalPages`, and a column header must sort on the **server** by field *and*
  direction (again via the reversed `name`/`rank` seed). The spec is
  hand-authored rather than emitted for the same reason as `pagination.mjs` —
  the DSL's `test e2e` has no loop, so it can never seed a real second page;
  it is copied into the generated `e2e/` dir as `paged-ui.spec.ts` (the
  committed file is named `.pw.ts` so the repo's vitest run never discovers
  it). Gates in `behavioral-ui-e2e.yml` after the emitted round-trips; run:
  `node paged-ui.mjs`.
- **heex-ui** — the **rendered LiveView**, per PR (`run-heex-ui.mjs`, fixture
  `heex-ui.ddd`, extra spec `heex-ui-roundtrip.pw.ts`). Deliberately NOT the
  `run-ui.mjs` topology: that one serves a `vite build` bundle with `/api`
  delegated in-process to Hono-on-PGlite, and LiveView has neither half — it
  IS the server, rendering over a websocket against a real Postgres. So this
  leg boots the generated Phoenix app for real (`mix deps.get` → `ecto.create`
  → `ecto.migrate` → `phx.server`, host `mix` when present, otherwise the
  pinned `hexpm/elixir` image) and points headless Chromium at it. It runs the
  **emitted** `HeexUiSystem.ui.spec.ts` — what `src/system/ui-e2e-render.ts`
  lowers from the fixture's `test e2e` block, over the page objects
  `src/generator/elixir/page-objects-emit.ts` emits — plus a hand-written
  create → **list** → detail round-trip (the DSL has no "assert the row is in
  the list" verb; see `renderAggregateCall`). Every assertion is on **rendered
  text**, which is the point: `generated-elixir-vanilla-build` only proves the
  Elixir compiles, `behavioral-e2e-elixir` drives the *api* half over HTTP and
  never opens a browser, and `phoenix-ui-e2e` (post-merge / `run-e2e` label)
  runs the emitted `smoke.spec.ts`, which navigates each route and asserts its
  URL — it passes on an empty shell, and measurably on a **500**. Needs docker
  (postgres sidecar unless `LOOM_HEEX_UI_PG_URL` is set) and, behind a
  TLS-fingerprint egress proxy, `LOOM_HEX_MIRROR=1` (`pkill -f hex-mirror.py`
  after a killed run). Gates in `behavioral-heex-ui-e2e.yml`; run:
  `npm run test:behavioral-heex-ui`.

## Why

The behavioral domain assertions otherwise run **only nightly**, in the
docker `conformance-full` leg (`LOOM_E2E=1`). Everything per-PR is
*structural* — typecheck / build / lint / string-match generator tests
(`expect(out).toContain(...)`) — which proves code is *emitted*, not that
it *behaves*. This tier promotes the behavioral layer (for the Hono/TS
backend + pure domain) to a **fast, per-PR, docker-free gate**.

It reuses the **playground's own** runners (`web/src/testing/*`,
`web/src/runtime/ddl.ts`) and the same `createHarness()` the in-browser
*Tests* tab uses — so the node tier and the browser tier share one
execution path. The cross-backend (.NET/Java/Phoenix/Python) and
cross-pack UI behavioral coverage stays in the docker/nightly legs; this
tier is *additive*.

## Run

```bash
cd test/behavioral
npm ci                 # once — pins the generated-project runtime deps (isolated from the repo's)
node run.mjs           # whole corpus
node run.mjs sales-system    # one case
```

The repo toolchain must be built first (`npm run build` at the root) so
`bin/cli.js generate system` emits current output — a **stale `out/`**
will generate old code and produce misleading failures.

Both tiers gate: any `api` or `unit` failure, or a boot/infra error,
fails the run.

### Contract fuzzing (`run-schemathesis.mjs`)

A sibling runner reusing this tier's boot, for a different question. The
suites above ask *"does the backend do what the model said?"* with
example-shaped input. This one asks *"does the backend honour the contract
it published?"* with adversarial input — it serves the generated Hono app on
a **real port** (`@hono/node-server` over the same PGlite boot, because
Schemathesis is an out-of-process HTTP client and cannot reach `app.fetch`)
and feeds it its own emitted `/openapi.json`:

```bash
uv tool install schemathesis          # once (or pipx)
npm run test:schemathesis             # from the repo root; ~1 min
LOOM_SCHEMATHESIS=1 node run-schemathesis.mjs storefront-system   # one case
```

Known findings are **ratcheting root-cause rules** in
`schemathesis-waivers.json`, explained in
[`docs/audits/schemathesis-findings-2026-08.md`](../../docs/audits/schemathesis-findings-2026-08.md):
a finding no rule matches fails the run, and a rule that stops reproducing
fails it too, so a fix deletes its rule in the same PR. Nightly in CI
(`schemathesis.yml`), or on demand via the `run-schemathesis` label.

## Corpus

`corpus.json` is a curated allowlist. **Constraint:** each system has
exactly one `platform: node` (Hono) deployable, so dispatch
(host-agnostic, path-matched, like the playground) is unambiguous.
Multi-backend systems (`examples/showcase.ddd`, `examples/acme.ddd`)
stay in the docker `conformance-full` leg.

## Definition-of-Done rollup

After running, each case joins its outcomes onto the generated
requirements graph (`.loom/traceability.json`) via the same
`computeVerification` (`src/verify/`) the playground Tests tab uses, and
prints a per-system verdict line:

```
⟐ requirements: 2/4 verified, 2 unverified
```

- **verified** — every linked testCase passed.
- **unverified** — a linked test didn't run in *this* runner (e.g. a
  `against <web>` UI testCase is unverified under `run.mjs`, and an
  `against <api>` testCase is unverified under `run-ui.mjs`). The two
  runners are complementary: `run.mjs` verifies the api/unit testCases,
  `run-ui.mjs` verifies the UI ones. Does **not** fail the run.
- **untested** — requirement has no testCase at all.
- **FAILING** — a linked test failed. **Fails the run** (a cross-check on
  top of the per-test gate).

So the rollup surfaces requirement coverage honestly without false-gating
on coverage the node tier can't provide.

## Principals — and the authorization ladder (M-T9.28)

The tier authenticates as a **canonical principal** (`DEV_CLAIMS` in
`cases.mjs`, or the mock-issuer token under OIDC). For a long time that
was the *only* identity available, and it capped what the tier could say
about authorization: it could assert "the satisfying principal gets
through", which a `requires` **emitted as a no-op passes identically**.
That is exactly how #2446 shipped a guarded `create` with an open route.

There are now **two** principals, in both auth flavours:

| | dev-stub | OIDC |
|---|---|---|
| authorized | `DEV_CLAIMS` (`role: "agent"`) | `oidc.token` |
| authenticated-but-**un**authorized | `DEV_CLAIMS_UNAUTHORIZED` (`role: "visitor"`) | `oidc.unauthorizedToken` |

Both members of each pair verify identically — same issuer and signing key
under OIDC, same claim channel under the dev stub — so the **only** thing
separating them by the time a request reaches a route is the authorization
predicate. A 403 from the second one therefore cannot be confused with a
verifier failure (which is a 401).

`AUTHZ_LADDERS` (`cases.mjs`) declares, per case, one or more
`requires`-gated surfaces; `__authzLadder` (the shared recorder preamble in
`wire-differential.mjs`, so every leg can adopt it) walks the three rungs
over each of them:

```
unauthenticated                → 401     authn precedes authz
authenticated-but-unauthorized → 403     the gate actually denies
authorized                     → 2xx     the gate is not always-deny
```

The third rung is what keeps the first two honest — a backend that denied
*everything* would pass rungs 1 and 2 on its own.

Two deliberate properties:

- **An unavailable rung is reported `skip`, never a quiet pass.** The
  emitted dev-stub verifier accepts every request and falls back to its
  built-in identity when no `x-loom-dev-claims` header is present, so under
  the dev stub there is no anonymous caller to express and the 401 rung is
  *unavailable*, not green. Only the OIDC flavour asserts it.
- **The ladder rides the UNRECORDED dispatch.** Its requests are assertions
  about status codes, not part of the wire contract, so routing them through
  the recorder would shift the ordinals the golden aligns on — and would do
  so only on the legs that have adopted the ladder, failing the differential
  for a reason unrelated to the wire. (M-T9.11 may promote the ladder to a
  recorded probe; that is a golden rebaseline, taken deliberately.)

The ladder runs on **all five** backend legs. That matters more than it
looks: the read-side gates it probes were dropped on *java/python/elixir*
specifically (the list route is special-cased out of the per-find loop on
each of them, so its `requires` was never read), so a node-only ladder
could not have seen the defect it exists to catch. Adoption on a leg is
credential plumbing, not a new prober — each runner passes
`AUTHZ_LADDERS[case]` plus `unauthorizedCredentials(...)` into its entry
source, and the shared preamble does the rest.

A spec may declare **several** gated surfaces and a **multi-step** seed.
Both exist for the read side: one system carries three distinct gated read
surfaces (the gated list read, a folded projection, a query-time
projection), and booting a fixture per surface would pay a whole
generate + migrate + boot each; the folded read model is populated by an
*event*, so its seed needs the create *and* the operation that emits. The
walk is **surface-major** — all three rungs per surface — so a mutating
surface's authorized arm cannot disturb the next surface's denial arms.

Slice 1 hand-writes `AUTHZ_LADDERS`. Slice 2 replaces that map with a
census **derived from the enriched IR** — every `requires`, `policy`
ladder, `mask unless` field and tenancy stance — so a gated surface with no
probe fails the gate.

## How it works

Per case: `generate system` → locate the one node deployable → esbuild
bundles a tiny boot entry (its `createApp` + `schema` + drizzle/pglite +
the repo's `synthDDL`/runners) → PGlite → `exec(synthDDL)` →
`drizzle(pglite,{schema})` → **`runSeeds(db)`** (only when the system
emitted `db/seed.ts`) → `createApp(db)` → run the emitted suites
against `app.fetch`. All third-party deps stay external (resolved from
this dir's `node_modules`), so there is one drizzle instance and PGlite's
wasm assets load normally.

The seeder step is the EMITTED one, imported not re-implemented, and it sits
exactly where the generated entrypoint puts it (`migrate` → `runSeeds` →
`createApp`). Before it existed, this leg — the wire-golden **oracle** — was the
one leg that never applied first-boot `seed` datasets, so a seeded table started
populated on the four cross-backend legs and empty here, and no collection read
on a seeded aggregate could be asserted anywhere without recording that gap as a
four-way wire divergence (`R.unseededListRead` in
`test/ir/api-caller-census-pins.ts`, now drained). Non-default datasets stay
opt-in via `LOOM_SEED`, as at runtime.

### Booting a real server (`proc.mjs`)

The node tier boots in-process, but the five cross-backend legs
(`run-{dotnet,dapper,python,java,mikroorm,elixir}.mjs`) spawn a real server per
case on ONE fixed port. That makes teardown a correctness concern, not a
tidiness one: a case that SIGTERMs its server without waiting leaves the socket
held, so the next case's `waitForPort` connects to the PREVIOUS case's app —
which then serves requests against a schema `resetDatabase` has just dropped
(`relation "…" does not exist` → 500 on the first write). `/ready` cannot save
you: readiness reports that *a* pool is healthy, never *which* app is behind the
socket.

So all six use `proc.mjs`:

- `waitForPort(port, timeoutMs)` — resolve once the server accepts.
- `stopServer(server, { graceMs })` — SIGTERM the process **group**, await the
  actual exit, escalate to SIGKILL after the grace period. Every runner spawns
  with `detached: true`, because the process holding the port is a child of the
  launcher (`dotnet run`, `uv run uvicorn`, `npm run dev`, `mix phx.server`).
- `waitForPortFree(port, timeoutMs)` — call before spawning; rejects if a
  leftover never releases the port, rather than booting on top of it.

The module is dependency-free on purpose (no `pg`/`esbuild` like `cases.mjs`) so
the main vitest suite can import it: `test/harness/behavioral-proc.test.ts`
gates this behaviour on every PR against a server that deliberately ignores
SIGTERM. Left to these legs, a race is only tested when it is lost.

## UI tier (`run-ui.mjs`)

The sibling runner for the **`ui`** tier — the emitted Playwright spec
Loom lowers from `test e2e "…" against <react-deployable>` (page-object
round-trips: `ui.orders.create(...)` → submit → read back). It exercises
the generated React pages/forms end to end against the real backend —
behaviour the in-process `app.fetch` api tier can't reach.

```bash
cd test/behavioral
npm ci                     # same deps as the api tier (adds nothing)
node run-ui.mjs            # every corpus case with `"ui": true`
node run-ui.mjs sales-system
```

Per case: `generate system` → `vite build` the generated React frontend
→ boot **one** in-process node HTTP server that serves the built `dist/`
**and** the generated Hono backend on PGlite (`/api`, `/health`, `/ready`
delegated straight to `app.fetch`) → run the emitted `*.ui.spec.ts` with
headless Chromium pointed at it.

Two non-obvious invariants make the wiring work (both were dead ends
first):

- **One origin, no proxy.** The browser, the static bundle, and the
  backend all share the single server's origin, so there's no `vite
  preview` proxy hop and no CORS. (`/api/*` is matched first and handed
  to `app.fetch`; everything else is static with an `index.html`
  fallback for client routes.)
- **Async `spawn`, never `spawnSync`.** Playwright is launched with async
  `spawn`: `spawnSync` blocks the node event loop, which would freeze the
  in-process server so every browser request hangs.

It sidesteps the playground's in-browser npm bundle entirely (and so
issue #1242). Heavier than the api/unit tiers (a real `npm install` of
the React/Mantine tree + `vite build` + a Chromium download), so it's
opt-in — its own `behavioral:ui` script and `behavioral-ui-e2e.yml`
workflow, never part of the fast `npm test`. Corpus cases without a
`test e2e … against <react>` block carry `"ui": false`.

## Flutter UI tier (`run-ui-flutter.mjs`)

Flutter was the **one** frontend with no full-stack runtime tier at all:
`generated-flutter-build.yml` is compile-only (`flutter analyze` +
`flutter build web`), which is precisely how the non-parsing-Dart
`FileRef??` emitter defect survived. This runner closes that hole with
`run-ui.mjs`'s exact topology and two substitutions.

```bash
cd test/behavioral
npm ci
npx playwright install --with-deps chromium   # needs the FULL chromium, see below
node run-ui-flutter.mjs                        # every case with `"uiFlutter": true`
node run-ui-flutter.mjs sales-system-flutter
FLUTTER=/path/to/flutter node run-ui-flutter.mjs   # SDK not on PATH
```

Per case: `generate system` → `flutter pub get` + `flutter build web
--release --no-web-resources-cdn` → boot the SAME one-origin server
(`ui-stack.mjs`, shared with `run-ui.mjs`) over `build/web` → seed rows
over `/api` → deep-link each list route and assert the app's own read
reached the backend, was answered 2xx, decoded, and rendered.

Four things about it are load-bearing and each one was a dead end first:

- **`--no-web-resources-cdn`.** A default `flutter build web` fetches
  CanvasKit from `gstatic.com` **at runtime**. On a network-isolated
  runner the bundle loads `main.dart.js`, silently fails to start its
  renderer, and paints nothing — **with no error of any kind**. The flag
  bundles CanvasKit locally, which the one-origin server then serves.
- **`.wasm` must be served as `application/wasm`.** `instantiateStreaming`
  rejects any other content-type, and CanvasKit streams its `.wasm`. The
  same silent no-boot as above. (Hence the MIME entry in `ui-stack.mjs`.)
- **The FULL chromium, not `headless_shell`.** CanvasKit needs a real
  WebGL context; the runner launches `channel: "chromium"` with
  `--enable-unsafe-swiftshader` so a GPU-less runner still has one.
- **Assertions read the ACCESSIBILITY TREE, not `data-testid`.** Flutter
  web renders to a canvas, so the emitted testid-driven `*.ui.spec.ts`
  page objects have nothing to select — the flutter emitter ships none
  (it maps `testid:` onto a widget `Key` for `flutter_test`). Clicking
  the engine's `flt-semantics-placeholder` makes Flutter build a real DOM
  mirror of the widget tree, and the probes read the seeded values out of
  it. The seeding is done over `/api`, not through a form: Flutter
  exposes a text field to the DOM only while it is focused, so a
  form-driven write is a flake source, and the READ half is where the
  wire contract lives.

A flutter case carries `"uiFlutter": true` **and** `"ui": false` in
`corpus.json`, so `run-ui.mjs` skips it instead of erroring on the
missing `e2e/playwright.config.ts`. Nightly: the `flutter` cell of
`frontend-fullstack-e2e.yml`.

## The wire differential — every leg gates the same canonical bytes

Every runner above (all five backends plus the `dapper` / `mikroorm`
persistence-adapter legs) records the requests its api tier makes, at the ONE
`fetch`/`app.fetch` chokepoint it already dispatches through, and diffs the
normalized responses against the committed goldens in
[`wire-golden/`](wire-golden/README.md). An unwaived divergence fails that
runner's exit code, so it fails that backend's **already per-PR**
`behavioral-e2e*.yml` workflow.

This is M-T9.11 slices (b) + (c). The alignment is free: the same emitted api
suite runs on every backend and `runTests` is strictly sequential, so request
*N* is the same code path everywhere and the sequence **ordinal** keys the diff
(ids can't — they differ per run).

Two design choices are the whole point:

- **A golden, not an all-pairs diff.** Pairwise disagreement says *they
  differ*, never *who is right*; RS-11 is the case where three backends agreed
  and were all three wrong. The golden is a reviewed **oracle**, and a wire
  change shows up as a diff on a checked-in file that a human approves.
- **Decomposed, not centralized.** A ≡ golden ∧ B ≡ golden ⇒ A ≡ B, so the
  five-way differential becomes five independent one-way gates riding boots
  that already happen — no new CI job, no compose stack.

```bash
LOOM_WIRE_UPDATE=1 node run.mjs ledger payments shapes sales   # rebaseline (node is the oracle)
LOOM_WIRE_OFF=1    node run-java.mjs                           # local-debug escape hatch
```

Known divergences live as explicit, self-expiring waivers in
[`test/_helpers/wire-waivers.ts`](../_helpers/wire-waivers.ts) — a waiver that
stops matching fails the gate as **stale**, so a fix deletes its waiver in the
same PR.
