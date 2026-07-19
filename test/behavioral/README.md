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

## How it works

Per case: `generate system` → locate the one node deployable → esbuild
bundles a tiny boot entry (its `createApp` + `schema` + drizzle/pglite +
the repo's `synthDDL`/runners) → PGlite → `exec(synthDDL)` →
`drizzle(pglite,{schema})` → `createApp(db)` → run the emitted suites
against `app.fetch`. All third-party deps stay external (resolved from
this dir's `node_modules`), so there is one drizzle instance and PGlite's
wasm assets load normally.

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
