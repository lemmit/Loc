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
