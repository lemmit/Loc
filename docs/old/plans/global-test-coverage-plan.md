# Global Test Coverage Plan — close the gaps, cover every feature on every backend

*Plan, 2026-06-20. Companion to [`docs/audits/e2e-suite-review.md`](../../audits/e2e-suite-review.md). Goal: turn the lopsided, near-duplicate fixture set into one declared feature×backend matrix with hard completeness gates, then layer real behavioural coverage on top.*

## The problem, in one table

Fixture count per backend build-gate (`test/e2e/fixtures/<backend>-build/`):

| Backend | Fixtures | Status |
|---|---|---|
| Java / Spring | **25** | de-facto most complete |
| Phoenix / Elixir | 15 | broad (plain Ecto/Phoenix — Ash foundation removed; the former ash row is gone) |
| Python / FastAPI | 16 | broad |
| **TS / Hono** | **9** | **thin — and this is the *reference* backend** |
| **.NET** | **6** | **thinnest first-class target** |

Two structural problems behind the numbers:

1. **Coverage is an accident of which directory happens to hold which file.** There is no declared "backend X supports feature Y, and a test proves it." Java got a 25-fixture matrix because someone built it out; Hono and .NET never caught up, even though they support nearly all the same features.
2. **Same-named fixtures are diverging near-duplicates.** `auth-oidc.ddd` exists as 5 separate files (md5 `7ac0fc86` / `f313a7ab` / `7207acda` / `ea54efd3` / `d2e712bb`), one per backend, hand-edited apart. Same for `tph`, `eventsourced-workflow`, etc. Every shared feature is maintained N times.

## Feature × backend coverage matrix (today)

✓ = a fixture exercises it · ✗ = gap · — = N/A for that backend

| Feature | Hono | .NET | Java | Python | Phoenix |
|---|:--:|:--:|:--:|:--:|:--:|
| core domain (VO/event/enum/containment/finds) | ✓ | ✓ | ✓ | ✓ | ✓ |
| auth — OIDC | ✓ | ✓ | ✓ | ✓ | ✓ |
| auth — simple / `auth: ui` guard | ✓ | ✗ | ✓ | ✓ | ✗ |
| event sourcing (log + appliers) | ✗ | ✓ | ✓ | ✓ | ✓ |
| ES → dispatcher fan-out | ✗ | ✗ | ✗ | ✗ | ✓ |
| workflow / saga (plain) | ✗ | ✗ | ✓ | ✓ | ✓ |
| eventsourced workflow | ✓ | ✓ | ✓ | ✓ | ✓ |
| outbox / durable channel | ✗ | ✗ | ✗ | ✓ | ✗ |
| inheritance — TPH | ✗ | ✓ | ✓ | ✓ | ✓ |
| inheritance — TPC / polymorphic find | ✗ | ✗ | ✗ | ✓ | ✗ |
| document (whole aggregate jsonb) | ✓ | ✗ | ✓ | ✓ | ✗ |
| embedded (containment jsonb columns) | ✗ | ✗ | ✓ | ✓ | ✓ |
| capability / context filter | ✓ | ✗ | ✓ | ✗ | ✓ |
| tenancy filter (principal) | ✓ | ✗ | ✓ | ✗ | ✓ |
| tenancy through ops / reified | ✗ | ✗ | ✓ | ✗ | ✓ |
| unions / operation-returns (exception-less) | ✓ | ✗ | ✓ | ✗ | ✓ |
| union find + absence (404) | ✗ | ✗ | ✓ | ✗ | ✓ |
| pagination (`paged`) | ✗ | ✗ | ✓ | ✗ | ✓ |
| seeding | ✗ | ✗ | ✓ | ✓ | ✓ |
| state gate (`when` / `canCommand`) | ✗ | ✗ | ✓ | ✓ | ✓ |
| resources (S3 / queue / http client) | ✗ | ✗ | ✓ | ✓ | ✗ |
| extern operations | ✗ | ✗ | ✓ | ✓ | ✗ |
| stamps (audit / softDelete) | ✗ | ✗ | ✓ | ✗ | ✗ |
| provenance (provenanced fields + snapshot) | ✗ | ✗ | ✗ | ✗ | ✗ |
| value collections (`Money[]`) | ✗ | ✗ | ✗ | ✗ | ✓ |
| single containment (`_parent`) | ✗ | ✗ | ✓ | ✗ | ✗ |
| views / read models | ✗ | ✗ | ✗ | ✗ | ✗ |
| criterion (reusable predicate) | ✗ | ✗ | ✓ | ✗ | ✓ |
| fullstack embed (SPA in backend) | ✗ | ✗ | ✓ | ✓ | ✓ |
| `byFeature` directory layout | ✓ | ✓ | ✗ | ✗ | ✗ |
| alt persistence | mikroorm | dapper | — | — | — |

(The former separate `Phoenix`/`vanilla` columns are collapsed into one `Phoenix` column — Ash foundation removed; elixir is plain Ecto/Phoenix only. A ✓ reflects coverage on either former foundation.)

**The white space is the work.** Hono and .NET are mostly-empty columns; `provenance`, `views`, and `value collections` are nearly-empty *rows* (gaps on every backend); TPC, outbox, and stamps are covered on a single backend each.

> Note: this is *static-compile* coverage. The runtime gaps (domain logic never executed, single `/health` smoke, no React/Angular runtime e2e, one read+write round-trip in k8s-smoke only) are catalogued in the audit and addressed in Phase 4 below.

---

## Strategy — four levers, not a thousand fixtures

Building 6 backends × 30 features = 180 hand-maintained fixtures the old way would be unmaintainable. Instead:

1. **One shared fixture corpus, generated per backend.** A feature gets *one* canonical `.ddd` under `test/fixtures/corpus/<feature>.ddd` plus a capability declaration. The harness emits it for every backend that declares support and runs that backend's compile gate. Kills the N-way duplication; makes coverage *declared*, not incidental.
2. **Flip the dormant completeness gates from report-only to hard.** `showcase-completeness.test.ts` already measures every AST kind + walker primitive against `showcase.ddd` — it ships `HARD_GATE = false`. A parallel per-backend coverage gate makes "feature with no fixture on a supporting backend" a CI failure.
3. **Push everything cheap into the no-docker conformance tier.** `test/conformance/*` already proves cross-backend *wire* parity (findall/paged/union) in-memory with no container. Extend it to every wire-affecting feature so most parity is caught per-PR in seconds, leaving docker for true runtime.
4. **Add a behavioural runtime tier driven by the corpus.** Reuse the k8s-smoke read+write recipe shape as a backend-agnostic behavioural fixture format, run it against the compose stack, and execute the *generated domain tests* on every backend (today only the Acme TS case runs them).

---

## Implementation status (2026-06-20)

**Landed — Phase 0 + the Phase 1 enforcement gate:**

- `test/fixtures/corpus/` — the shared corpus: `backends.ts` (6 backend keys + `platform:` clauses), `harness.ts` (`generateCorpusCase(feature, backend)` — swaps `__PLATFORM__`, generates in-memory), `manifest.ts` (the declared feature × backend matrix), and **21 platform-agnostic feature `.ddd`s**.
- `test/conformance/corpus-coverage.test.ts` — the no-docker coverage gate, **in the fast `npm test` suite**. 153 tests: every declared (feature, backend) cell generates cleanly through lower → enrich → validate → compose, plus completeness checks (no orphan fixture, no dangling manifest row, no missing reference doc).
- **Coverage delivered:** 25 features each generation-verified across all 6 backends (one declared exception — `criterion-filter` on Java, a real renderer gap the gate now documents). Hono and .NET go from 9 / 6 fixtures to **25 features each at parity with every other backend** on the generation tier.
- The 25: core-domain, state-gate, operation-returns, union-find-absence, paged, single-containment, value-collections, document, embedded, inheritance (TPH+TPC), event-sourcing, eventsourced-workflow, saga, auth-oidc, auth-simple, outbox, workflow-view, tenancy-filter, stamps, extern, seeding, views, resources, provenance, criterion-filter.

**What the generation gate is and isn't:** it proves every feature is *reachable* (generates without crashing) on every declared backend — the high-frequency lowering/enrichment failure mode — per-PR, in seconds. The harness asserts clean parse+validation too, so an invalid fixture fails rather than emitting a partial model.

**Landed — Phase 1 compile tier (reference backend):**

- `test/e2e/corpus-tsc-build.test.ts` (gated `LOOM_TS_BUILD`, sharded by `LOOM_CORPUS_TSC_CASE`, `npm run test:tsc-corpus`) — generates each corpus feature for `node`, `npm install`s, and runs strict `tsc --noEmit`, upgrading the corpus from a generation floor to a **compile guarantee** on Hono, from the same single source of truth.
- **24 of 25 node features are compile-verified.** The tier immediately surfaced **7 real Hono generator bugs** no existing gate caught (the legacy TS gate never exercised these exact shapes). **Six were genuine emitter bugs — all fixed** (compile-verified, skip dropped):
  - `single-containment` / `embedded` — required single containment emitted null-unsafe repo code (TS18047/TS2345). Fixed: the wire projection + embedded doc-serialize now non-null-assert required single containment (parity with .NET's `= default!` owned entity); optional containment null-guards.
  - `outbox` — durable-channel workflow cast a union event to `DomainEvent` (TS2352). Fixed: cast through `unknown` (the `__loomEventId` envelope marker is out-of-band, not on the event union).
  - `union-find-absence` — union-find route spread a non-object union type (TS2698). Fixed: spread `repo.toWire(result) as Record<string, unknown>`.
  - `state-gate` — `when`/can-query route omitted the enum import (TS2304). Fixed at lowering: qualified enum access `EnumName.Value` in a `when`/invariant predicate now lowers to an `enum-value` ref, and the route file imports the enums its `when` gates reference.
  - `resources` — queue client missing `@types/amqplib` (TS7016). Fixed: the rabbitmq ResourceAdapter declares the dep.
- **The 7th is a FEATURE GAP, not an emitter bug** (still skip-listed, honestly labelled): `workflow-view` exercises **workflow own-state mutation** (`create(p) by p.order { attempts := 1 }`) — documented as "own-state mutation" (workflow.md) but not yet lowered: the assignment falls through to lower-workflow.ts's `__bad__` placeholder (TS2304). Wiring it is a **cross-backend slice**, not a one-line emitter fix — a new `assign` `WorkflowStmtIR` kind feeding all five workflow backends, **and** making the saga-state row writable (Java/.NET/Phoenix state classes are immutable today: package-private fields + getters, no setters / `private set`). Tracked as a Phase-5 feature item below, not a compile-tier skip to "just fix".

**Landed — Phase 1 compile tier extended to Java + Python:**

The Hono compile tier now has two siblings, so the corpus is a **compile guarantee on three backends** from the one source of truth:

- `test/e2e/corpus-java-build.test.ts` (`LOOM_JAVA_BUILD`, sharded by `LOOM_CORPUS_JAVA_CASE`, `npm run test:java-corpus`) — generates each corpus feature for `java`, runs `gradle testClasses bootJar`. **20 of 24 features compile.**
- `test/e2e/corpus-python-build.test.ts` (`LOOM_PYTHON_BUILD`, sharded by `LOOM_CORPUS_PYTHON_CASE`, `npm run test:python-corpus`) — generates each corpus feature for `python`, runs `uv sync` + `ruff check` + `mypy --strict` (+ `pytest`). **21 of 25 features pass.**

The Java tier immediately surfaced (and this slice **fixes**) a real Java bug: **enum-typed find/operation parameters weren't importing `domain.enums.*`** in the repository interface / JPA repo / repository impl / controller (javac "cannot find symbol" on the enum type). Fixed by adding the (always-safe, `_Namespace.java`-backed) enums wildcard import alongside `domain.ids.*`, matching what entity/dto/events already emit unconditionally — unblocking every enum-using feature.

The remaining failures are skip-listed with precise reasons (the compile-tier model: surface → skip-list → fix as follow-up), split into **platform limitations** (the CLI refuses at generate-time, by design) and **real bugs**:

- **Java** — *limitations:* `provenance` (runtime node/dotnet-only, DBT-1), `embedded` (jsonb id-array column unmapped on java).
- **Python** — *limitation:* `provenance` (node/dotnet-only). *Feature gap:* `value-collections` — inline value-object arrays (`Money[]`) aren't persisted on python at all (the SQLAlchemy schema emits no jsonb column; the repo's `save` root dict + `_hydrate`'s `_create(...)` both drop them). Mapping inline VO arrays to a jsonb column (+ serialize/hydrate) is the fix; bigger than a lint nit.

(`workflow-view` stays skip-listed on both as the documented cross-backend own-state-mutation feature gap.)

**Landed — compile-tier skip-list drained (Java `inheritance` + `event-sourcing`, Python `stamps` + `resources`):**

Re-validating the original skip-list against fresh `main` (after the typed-capabilities fixture ports) showed two were already **stale** and two were **genuine, fixed**:

- **Java `inheritance` (fixed).** A TPC base (`@MappedSuperclass`) is id-less — each concrete owns its typed id — but the base's `inspect` derived read `this.id`, which doesn't resolve on the base (`cannot find symbol`, `Asset.java`). Fix: the TPC base now declares `public abstract Object id();` (concretes covariantly override it with `<Concrete>Id id()`), and the base's derived bodies render via accessor getters (`this.id()` / `this.label()`) instead of direct field reads. TPH bases (which own the shared id field) are unchanged.
- **Python `resources` (fixed).** A dead workflow `let x = resource.get(...)` emitted an unused local (`ruff F841`). Fix: `expr-let` whose binding is never read (computed by a `collectUsedLetNames` walk over the workflow body) drops the assignment and keeps the still-side-effecting RHS as a bare `await …` statement — mirroring the existing bare-`resource-call` arm. Aggregate-binding lets (`repo-let`/`factory-let`/`repo-run`) save at exit and are never treated as unused.
- **Java `event-sourcing` + Python `stamps` (stale → dropped).** Both already compile/lint clean on current `main` (the `stamps` fixture's typed-capability rewrite incidentally fixed the old unused-`datetime.UTC` import; the java event-sourced repo no longer references the old undefined symbol). Skip entries removed; the corpus shards now gate them.

Net: Java compile tier **22/24**, Python **22/25** (each minus `workflow-view` feature gap + `provenance`/`embedded` platform limitations, and Python minus the `value-collections` VO-array-persistence feature gap).

**Landed — Phase 0 migration (legacy dup-set collapse):**

A `materializeCorpusFixture(feature, backend, dir)` helper lets the per-backend build gates generate a shared corpus feature (via a `corpus:<feature>` sentinel) instead of a per-backend duplicate `.ddd`. Two dup-sets collapsed onto the corpus, each cell compile-verified on-host (node/java/python) where the sandbox allows:

- **`auth-oidc`** (5 → 3): node/java/dotnet build gates repointed, their three legacy copies deleted. Python keeps its copy (shared with the runtime OIDC e2e, `auth-oidc-python-e2e.test.ts` — single-sourced rather than split); Phoenix's name-based cached gate deferred.
- **`eventsourced-workflow`** (4 → 1): node/java/python/dotnet all repointed, all four legacy copies deleted (none were e2e-shared).

- **`tph`** — a *new* corpus feature (the Vehicle/Car/Truck TPH-only canonical fixture, kept distinct from `inheritance`'s TPH+TPC showcase). Java's two consumers — the `generated-java-build` gate **and** the `generator-java-tph` unit test — now share it; `java-build/tph.ddd` deleted. Verified on host (gradle bootJar + the unit test's 4 structural assertions). The `dotnet`/`phoenix` `tph` fixtures are **genuinely different content** (dotnet is `Party`-based, asserts `PartyConfiguration.cs`; Phoenix's gate hardcodes the `phoenix_app` project dir) — not duplicates, correctly left in place.

(Sandbox note: `.NET`/Phoenix compile-verify is blocked here by package-registry egress — `NU1301` to nuget.org, `unknown_ca` to hex.pm; both compile in CI. The repointed .NET cells are CI-verified.)

**Remaining:** extend the compile tier to the other backends' docker gates (Phase 1 cont.), implement workflow own-state mutation across the five workflow backends (the lone remaining compile-tier skip — a feature, scoped as a Phase-5 item), flip showcase-completeness to hard (Phase 2), the manifest-driven wire-parity sweep (Phase 3), and the behavioural runtime tier (Phases 4–5).

---

## Phase 0 — Capability manifest + corpus scaffold (foundation) ✅ shipped

The keystone. Without it, every later phase is N-way copy-paste.

- **`test/fixtures/corpus/manifest.ts`** — one row per feature: `{ id, ddd: "<path>", backends: Set<Backend>, tier: "compile"|"wire"|"runtime", note }`. The `backends` set is the *declared* support matrix above, made machine-readable.
- **`test/fixtures/corpus/<feature>.ddd`** — the single canonical source per feature. Where a backend needs a variant (e.g. `platform:` pin), express it as a small *overlay* (a header swap applied at generation time), not a forked file.
- **Migrate the existing near-duplicates into the corpus.** Start with the 3 confirmed dup sets (`auth-oidc`, `tph`, `eventsourced-workflow`) — collapse 5/3/4 files into 1 + overlays each. Delete the per-backend copies; repoint the build gates at the corpus.
- **Harness helper** `generateCorpusCase(featureId, backend)` returning the file map, reused by every tier.

**Deliverable:** corpus infra + the 3 dup-sets migrated, build gates green and reading from the corpus. No coverage change yet — this is the refactor that makes the rest cheap.

## Phase 1 — Close the compile matrix (fill the white space)

Drive the manifest to full per the support matrix, **prioritising the empty columns first** (highest marginal value):

1. **Hono** → bring from 9 to parity: add document, embedded, tenancy, unions+absence, paged, seeding, `when`, resources, extern, stamps, fullstack, criterion, value-collections.
2. **.NET** → bring from 6 to parity: same list (its column is the emptiest).
3. **Fill the single-backend rows** so every backend that *supports* a feature has the corpus fixture: TPH on Hono, TPC beyond Python, outbox beyond Python, ES-dispatch beyond Elixir, stamps beyond Java.
4. **Fill the near-empty rows on every backend:** `views` / read models (currently ✗ everywhere), `provenance` (✗ everywhere), `value collections` (Phoenix only today).

Each addition = one corpus `.ddd` + a manifest row + the backend's existing compile gate picks it up automatically. CI sharding (`LOOM_*_BUILD_CASE`) already exists, so cost is bounded.

**Gate:** a new `corpus-coverage.test.ts` (fast, no-docker) asserts every `manifest` row marked for a backend has a generatable fixture and that no supported `(feature, backend)` cell is missing — making future regressions impossible.

## Phase 2 — Flip the completeness gates to hard

- **`showcase-completeness.test.ts`**: finish building `showcase.ddd` out to 100 % of AST kinds + walker primitives, then set `HARD_GATE = true`. A new grammar feature without showcase coverage now fails CI.
- **New `feature-doc-coverage.test.ts`**: cross-reference `docs/<feature>.md` (the 14 feature reference docs) against the manifest — a documented feature with no corpus fixture fails. Keeps docs and tests honest with each other.

## Phase 3 — Extend the cheap no-docker wire-parity tier

Generalise `test/conformance/*` (today: findall, paged-wire, union-wire, union-find-absence) into a **manifest-driven parity sweep**: for every corpus feature tagged `tier ≥ wire`, generate on all supporting backends in-memory and assert the emitted OpenAPI + `wire-spec.json` agree across the pair-set — the same 14-category diff `e2e.test.ts` runs live, but in-process and per-PR. This moves contract-parity coverage from "showcase only, behind docker, nightly" to "every feature, no docker, per-PR."

## Phase 4 — Behavioural runtime tier (close the audit's runtime gaps)

The static phases prove *it compiles*; this proves *it does the right thing*. All gated/nightly (process + DB cost), driven by the corpus so it scales with Phase 1.

1. **Run the generated domain tests on every backend.** Today only Acme TS executes its `vitest` domain tests; Java/.NET/Python *compile* their emitted test sources but never run them, pytest is optional+unasserted. Make each backend's build gate *execute and assert* its generated unit tests (no DB — pure domain logic).
2. **Backend-agnostic behavioural fixtures.** Promote the k8s-smoke `{create, list, idField}` JSON recipe shape into `test/fixtures/corpus/<feature>.behaviour.json` and run a **POST→201→GET round-trip per feature** against the compose stack — extend beyond the single inheritance-system smoke to cover unions (404 absence), paged (envelope shape), tenancy (cross-tenant 403/empty), `when` (state-gate 409), stamps (audit fields populated). One recipe, all backends, since the wire shape is identical.
3. **React + Angular runtime e2e.** Today only Vue and Svelte get `vite preview` + Playwright; React rides only the full compose suite and Angular has none. Add the `vite preview` + emitted-smoke-spec gate (the Vue/Svelte pattern) for both.
4. **Deeper Playwright assertions.** The current smoke specs only assert "route navigates, shell renders." Add form-submit → optimistic update → list-reflect for at least the scaffold and showcase cases, on one design pack per frontend.

## Phase 5 — Fill the long-tail runtime legs

- **Observability**: extend the single `/health` request to one domain-endpoint request per backend, asserting the request bracket correlation on a *real* route (not just the health probe).
- **Dialyzer**: lift from 1 fixture to the corpus matrix once the warm-PLT cache lands.
- **Resources / outbox / saga at runtime**: the only proof today is compile-time; add a compose leg with the actual S3/RabbitMQ sidecars asserting a message round-trips and the outbox relay dedups.

---

## Sequencing & independence

```
Phase 0 (corpus + manifest)  ──► everything else depends on this
   │
   ├─► Phase 1 (fill compile matrix)  ──► Phase 2 (hard completeness gates)
   │                                  └─► Phase 3 (cheap wire parity)   [parallel]
   │
   └─► Phase 4 (behavioural runtime)  ──► Phase 5 (long-tail runtime)
```

Phases 1, 3 are independently shippable slice-by-slice (one feature or one backend column per PR). Phase 2 gates flip only after Phase 1 fills the relevant coverage. Phase 4–5 are nightly-tier and can proceed in parallel with 2–3 once Phase 0 lands.

## What "done" looks like

- Every `(feature, backend)` cell that *should* be ✓ *is* ✓, enforced by `corpus-coverage.test.ts` — no more accidental gaps.
- One canonical `.ddd` per feature; zero hand-maintained duplicates.
- `showcase-completeness` and `feature-doc-coverage` are **hard** gates — a new grammar/feature without test + doc coverage cannot merge.
- Cross-backend wire parity is proven **per-PR, no docker**, for every wire-affecting feature.
- Every backend **executes** its generated domain tests; a behavioural read+write round-trip exists per feature; all four frontends have runtime e2e.

## Costs & risks

- **CI minutes.** Phase 1 multiplies build-gate cells (~+90 compile cases). Mitigated: compile gates are already sharded and run per-PR cheaply; the corpus lets cells share generation. The expensive Phase 4–5 stays nightly/label.
- **Corpus migration churn.** Collapsing N duplicates risks losing a backend-specific nuance encoded in a fork. Mitigation: migrate one dup-set at a time, asserting byte-identical generated output before/after (the same gate the walker/expr extractions used).
- **Showcase completeness may surface real generator gaps** (a feature with no emitter on some backend). That's the gate working — each becomes a tracked backend-support decision, not a silent hole.
