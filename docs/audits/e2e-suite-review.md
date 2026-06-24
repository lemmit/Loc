# E2E Suite Review — what do we *really* test?

> **(Superseded 2026: the Ash foundation was removed — `platform: elixir` is plain Ecto/Phoenix only, `foundation: ash` is now a validation error. The Ash-specific gates below — `generated-phoenix-build` against real Ash 3.x, the `elixir-ash`/`elixir-ash-dialyzer` CI jobs, the Ash-Phoenix obs leg — are historical; the elixir-vanilla gates compile against plain Ecto/Phoenix.)**

*Snapshot audit, 2026-06-20. Scope: everything under `test/e2e/` plus the generated-app build/runtime gates and their CI workflows.*

## TL;DR

The e2e tier is **opt-in, layered, and mostly about the generated artifact, not the compiler.** Nothing here re-checks the IR or the emitters' string output — that's the fast `npm test` suite. Every file in `test/e2e/` answers one of four questions about *generated projects*:

1. **Does it compile?** (static gates — the bulk of the tonnage)
2. **Does it boot and serve?** (runtime smoke — health + structured-log envelope)
3. **Do the backends agree?** (cross-backend OpenAPI / wire-shape parity)
4. **Does a real round-trip work?** (full-stack: auth against live Keycloak, read+write through a migrated DB in compose/k8s)

Coverage thins out exactly as you'd expect along that axis: **compile** is near-universal (6 backends × dozens of fixtures, 4 frontends × design-pack matrices); **boot** is one health request per backend; **round-trip** is a handful of curated fixtures. Almost nothing asserts *business-logic correctness* at runtime — that's delegated to (a) generated domain unit tests, run only on the Acme TS case, and (b) DSL-authored `test e2e` blocks + Playwright, run only in the full compose suite.

Everything is gated behind a `LOOM_*` env var and **excluded from `npm test`**. The CI split is the real strategy: **build/parity/k8s-validate gates run per-PR**; **everything that boots a process (obs, oidc, compose, k8s-cluster) runs on push-to-main / nightly / label only.**

---

## The four strategies, by layer

```
        cheap, per-PR, static  ───────────────────────────►  expensive, nightly, real runtime
   ┌──────────────┬─────────────────┬────────────────────┬──────────────────────────────┐
   │ ① COMPILE     │ ② BOOT/LOG       │ ③ CONTRACT PARITY   │ ④ ROUND-TRIP                  │
   ├──────────────┼─────────────────┼────────────────────┼──────────────────────────────┤
   │ tsc/vue-tsc/  │ start process,   │ fetch /openapi.json │ live Keycloak JWT,            │
   │ svelte-check/ │ GET /health,     │ from all 5 backends,│ POST→201→GET roundtrip        │
   │ ng/mix/gradle/│ assert structured│ diff 10 pairs ×     │ through migrated postgres,    │
   │ dotnet/mypy/  │ log envelope     │ 14 categories       │ Playwright UI nav             │
   │ ruff/biome/   │                  │                    │                              │
   │ dialyzer/fmt  │                  │                    │                              │
   └──────────────┴─────────────────┴────────────────────┴──────────────────────────────┘
```

---

## ① COMPILE — "does the emitter produce code the target toolchain accepts?"

This is the largest tier by far. Pure static: generate a project, run the language's compiler/typechecker/linter/formatter, assert exit 0 (+ that an artifact exists). **No process is started, no DB touched.** It catches generator drift invisible to IR-level unit tests: missing imports, wrong prop types, signature mismatches against framework APIs, non-canonical formatting.

### Backends

| Suite | Env gate | Toolchain (the real assertion) | Where | Runs tests? |
|---|---|---|---|---|
| `generated-build.test.ts` (TS/Hono) | `LOOM_TS_BUILD` | `npm i` → `tsc --noEmit` → `tsup` (asserts `dist/index.js`) | host | **Yes (only case)** — Acme runs generated domain `test` blocks via `vitest` (pure domain logic, no DB) |
| `generated-dotnet-build.test.ts` | `LOOM_DOTNET_BUILD` | `dotnet restore` → `dotnet build /warnaserror` (asserts `.dll`) | host SDK | No (test-project build deferred — NuGet feeds) |
| `generated-dotnet-format.test.ts` | `LOOM_DOTNET_FORMAT` | `dotnet format --verify-no-changes` | host | — (format only) |
| `generated-java-build.test.ts` | `LOOM_JAVA_BUILD` | `gradle testClasses bootJar` (compiles emitted JUnit too, **doesn't run it**) | host JDK 21 | Compiles, no run |
| `generated-python-build.test.ts` | `LOOM_PYTHON_BUILD` | `uv sync` → `ruff check` → `mypy --strict` (+ `pytest` if present, **not gated**) | host (uv) | Optional, unasserted |
| `generated-phoenix-build.test.ts` | `LOOM_PHOENIX_BUILD` | `mix compile --warnings-as-errors` vs real Ash 3.x | docker (`hexpm/elixir`) | No |
| `generated-phoenix-format.test.ts` | `LOOM_PHOENIX_FORMAT` | `mix format --check-formatted` | docker | — |
| `generated-phoenix-dialyzer.test.ts` | `LOOM_PHOENIX_DIALYZER` | `mix dialyzer` (structural typing vs emitted `@spec`s) — **1 fixture** (cold PLT cost) | docker | No |
| `generated-elixir-vanilla-build.test.ts` | `LOOM_PHOENIX_VANILLA_BUILD` | `mix compile --warnings-as-errors`, **asserts zero Ash deps** in `mix.exs` | docker | No |
| `generated-biome.test.ts` | `LOOM_BIOME` | `biome lint` on emitted TS/TSX, **zero errors** (warnings OK) | host | — (lint only) |

**Fixture matrices are the real coverage story.** The fixtures under `test/e2e/fixtures/<backend>-build/` are a feature checklist: auth-oidc, event-sourcing (`eventlog`/`saga`/`eventsourced-workflow`/`outbox`), inheritance (`tph`/`inheritance`), document/embedded jsonb shapes, capability/tenancy filters, pagination (`paged`), unions (`union`/`operation-returns`), state gates (`when`), seeding, resources (S3/queue/http), `byfeature` layout, alternate persistence (`mikroorm`, `dapper`). Java (25) and Phoenix/Ash (25) carry the widest matrices; vanilla Elixir (15) deliberately mirrors the Ash set on the non-Ash codepath.

### Frontends (build gates)

| Suite | Env gate | Matrix | Toolchain |
|---|---|---|---|
| `generated-react-build.test.ts` | `LOOM_REACT_BUILD` | **13 examples × 8 packs = 104** (mantine v7/v9, shadcn v3/v4, mui v5/v7, chakra v2/v3) | `tsc --noEmit` → `vite build` |
| `generated-vue-build.test.ts` | `LOOM_VUE_BUILD` | 3 cases × 2 packs (vuetify v3, shadcnVue v1) | `vue-tsc --noEmit` → `vite build` |
| `generated-svelte-build.test.ts` | `LOOM_SVELTE_BUILD` | 2 examples × 2 packs (shadcnSvelte, flowbite) | `svelte-check --fail-on-warnings` → `vite build` |
| `generated-angular-build.test.ts` | `LOOM_ANGULAR_BUILD` | 3 cases × 1 pack (angularMaterial) | `ng build` (typecheck + bundle in one) |

CI shards these by `LOOM_*_BUILD_CASE=<ddd>:<pack>` (one matrix cell per shard). Each is **static only** — typecheck + bundle, no browser.

### Two specialised compile gates

- **`extern-component-build.test.ts`** (`LOOM_REACT_BUILD`) — proves the emitted `OrderCard.props.ts` contract *bites*: a hand-written extern widget reading `order.customerId` must `tsc`-pass; swap it to read a non-existent `order.totalAmount` and `tsc` must **fail naming `totalAmount`**. A negative test for the typed escape-hatch boundary.
- **Matrix-sync guards** (`react-build-matrix-sync.test.ts`, `svelte-build-matrix-sync.test.ts`) — the only two e2e files that **run in the fast `npm test` suite** (no gate). Pure string check: parse the CI workflow YAML's `EXAMPLES`/`pack` arrays and assert they equal the `*-build-cases.ts` lists, so a renamed example can't silently produce un-runnable CI shards.

---

## ② BOOT / LOG — "does it start, serve, and emit the observability catalog?"

The `observability-events-*` suites (`LOOM_OBS_E2E[_*]`) actually **start the generated backend** and assert the **structured-log envelope**, normalised to one catalog contract across six runtimes (Hono, .NET, Java, Python, Ash-Phoenix, vanilla-Phoenix).

What's asserted, identically across platforms:
- **Lifecycle events** present: `server_starting` → `server_listening` → `server_shutdown` (SIGTERM) → `server_drained`.
- **Envelope shape**: ISO-8601 `ts`, `level` ∈ the catalog set.
- **Request bracket correlation** — the central invariant: fire one `GET /health`, then assert `request_id` and `scope_id` are identical across `request_start` → `*_ok` → `request_end`, and that `method=GET`, `path=/health`, `status=200`, `duration_ms: number`. (Python additionally asserts the `x-request-id` response header echoes.)

Infra: Hono runs no DB (lazy pool, stub `DATABASE_URL`); every other backend brings a **postgres sidecar** (docker, or external via `LOOM_OBS_PG_URL`). Each normalises a platform-specific log format to the same shape — .NET's `AddJsonConsole` PascalCase + `Scopes[]`, Elixir's custom `LogFormatter` + `:telemetry` translation, etc. **This is the only tier that proves the backend actually runs** outside of the full compose/auth/k8s suites. It does *not* exercise any domain endpoint — only `/health`.

`test/e2e/support/hex-mirror.ts` is a no-op helper (gated `LOOM_HEX_MIRROR`) that re-originates hex.pm through a loopback TLS mirror so the Elixir suites work behind fingerprint-allowlisting proxies.

---

## ③ CONTRACT PARITY — "do the five backends agree on the wire?"

Lives inside **`e2e.test.ts`** (`LOOM_E2E`), the heaviest single file (565 LOC). It generates the **entire `showcase.ddd` system** (all 5 backends in one `docker-compose.yml`), `docker compose up`s it, and waits for all five `/health` endpoints.

Then it does the real work:
- **OpenAPI parity** — fetch `/openapi.json` from all 5, diff **all 10 backend pairs** across **~14 categories** (ops present, cardinality, schema field sets, required sets, property types/formats, path/query params, request/response bodies, operationIds, enum value-sets, error responses). Report-only locally; **hard-fails under `LOOM_E2E_STRICT_PARITY=1`** (CI).
- **Runtime authorization parity** — POST a guarded workflow with an empty-permission stub token to all 5, assert **403 everywhere**.
- **Generated DSL e2e** — discovers the emitted `test e2e` suite and runs it (`vitest`) against the live stack.
- **Generated Playwright UI** — installs chromium and runs the emitted page-object specs against the live React frontends.

Modes: `LOOM_E2E_PARITY_ONLY` (backends + openapi + auth only — the fast CI cut) vs full (adds DSL + Playwright). On any failure it dumps compose logs to `/tmp/loom-e2e-diagnostics.log`. This is the suite that proves **cross-backend wire compatibility is structural, not coincidental** — the architectural payoff of the shared `wireShape`.

---

## ④ ROUND-TRIP — "does a real request, end to end, actually work?"

### Auth (OIDC against live Keycloak)

Six suites (`auth-oidc[-dotnet|-java|-python]-e2e`, plus two `-compose-e2e`). Every one stands up **a real Keycloak 26.0** + postgres and runs a **real password-grant token flow** — no mock issuer. Identical assertion shape across backends:

1. `GET /api/tickets` **no token → 401**
2. acquire real JWT (`grant_type=password`, demo/demo) from Keycloak's token endpoint
3. `GET /api/tickets` **with token → 200** (verifier validates signature against Keycloak's **live JWKS**)
4. `GET /api/auth/me` → claims projected, including the **dotted path** `realm_access.roles` → `expect(roles).toContain("agent")`, `email == "demo@example.com"`
5. forged `Bearer not.a.token` → **401**

Python and Phoenix additionally smoke the **authorization-code redirect handshake** (`/api/auth/login` → 307/302, `Location` to Keycloak, `oidc_state` cookie). The split that matters:
- **Native-host suites** (`-e2e`, `-dotnet`, `-java`, `-python`) run the backend on the host against dockerised KC+PG — they prove the *runtime verifier* works.
- **`-compose-e2e` suites** (Hono, Phoenix) build the **generated Dockerfile** and run the **whole emitted `docker-compose.yml`**, validating cross-container wiring (`host.docker.internal`, `KC_HOSTNAME`, `depends_on` health gates) — the exact `docker compose up` a user runs.

### Kubernetes

- **`k8s-validate.test.ts`** (`LOOM_K8S`) — **static**, no cluster: `helm lint` + `helm template | kubeconform -strict` + kubeconform on raw `k8s/`, across 3 representative systems. Catches manifest schema drift (apiVersion, probe shapes, secretRefs).
- **`scripts/k8s-e2e-smoke.sh`** — **real kind cluster**: build backend image → `kind load` → throwaway in-cluster postgres named `db` → `helm install` (only the target workload via `enabled=false` on the rest) → assert `/health` + `/ready` (DB-aware) → **real read+write round-trip** (POST a fixture body satisfying domain invariants → 201 → read back via `findAll`). Proves migrations run at boot, secrets wire up, and the wire shape is identical across backends (one backend-agnostic fixture, fanned across the matrix in `k8s-e2e.yml`).

### Full-stack embed

- **`embed-react-phoenix.test.ts`** (`LOOM_EMBED_E2E_PHOENIX`) — boots Phoenix with an embedded React SPA built into `priv/static/app`, then asserts at runtime: `GET /app` → SPA shell with `<div id="root">` + assets load under the `/app/` base; `GET /app/products` deep-link → still the shell (catch-all fallback); `GET /api/products` → Ash JSON, same origin, no CORS. Catches static-mount / fallback-shadowing / basePath bugs that compile cleanly but break at runtime.

---

## What runs *when* (CI strategy)

| Trigger | Suites |
|---|---|
| **Per-PR** | `test.yml` (fast vitest + biome-gen + matrix-sync), all `*-build` gates (hono/dotnet/java/python/elixir-ash/elixir-vanilla, react/vue/svelte/angular), `conformance-parity`, `k8s-build` (helm-validate), `langium-generated`, `elixir-ash-dialyzer` |
| **Push-to-main / manual** | all `*-obs-e2e`, all `*-oidc-e2e`, `auth-oidc-compose-e2e` (the process-booting tiers) |
| **Nightly / label** | `k8s-e2e` (cluster smoke), `conformance-full`, `playground-e2e`, `elixir-vanilla-obs-e2e` |

The design: **per-PR stays static and fast** (compile + parity-diff + manifest-validate); **anything that boots a process, a DB, Keycloak, or a cluster is pushed off the PR path** to push/nightly/label, because each costs minutes of container build + boot.

---

## Coverage honestly assessed

**Strong:**
- Generator output *compiles* on every backend × a broad feature matrix, with warnings-as-errors / strict-typecheck / lint / format / dialyzer bars.
- Cross-backend wire contract is diffed structurally (10 pairs × 14 categories) and enforced in CI.
- Auth is exercised against a **real IdP with real JWT signature validation** — not mocked — on all four backends + two compose stacks.
- One genuine **read+write DB round-trip** per backend exists (k8s-e2e smoke), proving migrations + persistence + wire serialization.
- Frontends typecheck + bundle across the full design-pack matrix; two frameworks (Vue, Svelte) get real-browser routing smoke.

**Thin / delegated:**
- **Domain-logic correctness at runtime** is barely covered: generated unit tests run only on the Acme TS case; Java/Python/.NET compile their test sources but **don't execute them**; pytest is optional and unasserted.
- **Boot smoke is a single `/health` request** for most backends — no domain endpoint is hit outside the compose (`e2e.test.ts`) and k8s-smoke paths.
- **Playwright UI** only runs in the full `LOOM_E2E` compose suite (React) and the Vue/Svelte client-side smoke; specs are shallow (route navigates, shell renders) — no deep form-submit assertions in the matrix gates.
- **React/Angular have no runtime e2e** (build-only); only Vue and Svelte get `vite preview` + Playwright.
- **Dialyzer is one fixture**; the deeper structural-type matrix is deferred on PLT cost.

**Net:** the suite is optimised to catch **generator drift** (the high-frequency failure mode) cheaply and broadly, and to prove **integration wiring** (auth, compose, k8s, parity) on a few curated fixtures expensively. It is *not* a behavioural test suite for the generated business logic — that surface is the lightest-covered corner.
