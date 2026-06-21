# Test parity across generated backends

> Status: **first pass — 2026-06-21.** Empirical snapshot of what the
> `.ddd` `test` / `test e2e` declarations actually emit on each of the
> five backends. Read alongside [`docs/generators.md`](../generators.md)
> (per-backend feature matrix) and [`docs/conformance.md`](../conformance.md).

## Scope & method

The DSL has two test surfaces:

| Surface | IR node | Source form |
|---|---|---|
| **Domain unit test** | `TestIR` (`agg.tests`) | `test "name" { let … expect(x).toBe(y) … }` on an aggregate |
| **End-to-end test** | `TestE2EIR` (`sys.e2eTests`) | `test e2e "name" against <deployable> { api.orders.create({…}) … }` (`kind: "api"` \| `"ui"`) |

The two are emitted at **different pipeline layers**, and that is the
crux of the parity story:

- **Domain unit tests** are emitted **per-backend** by each generator's
  `emit/tests.ts` — five separate emitters, one per language.
- **E2E tests** are emitted **once at the system layer**
  (`src/system/e2e-render.ts` for `api`, `src/system/ui-e2e-render.ts`
  for `ui`) as a single TypeScript/vitest (api) or Playwright (ui) file
  that is **language-agnostic** — it drives any backend over HTTP / the
  browser.

Method: read every test emitter and its wiring in the backend
`index.ts`, the IR test types (`src/ir/types/loom-ir.ts`), the test-body
validator (`src/ir/validate/checks/test-checks.ts`,
`src/language/validators/match.ts`), and the matcher catalogue
(`src/util/intrinsic-matchers.ts`). Cross-checked against the
documented matrix in `docs/generators.md`.

## Parity matrix

Backends: TS/Hono (`node`), .NET (`dotnet`), Phoenix (`elixir`),
Python (`python`), Java (`java`).

| Capability | node | dotnet | elixir | python | java |
|---|:--:|:--:|:--:|:--:|:--:|
| Domain `test "…"` → unit-test file | ✅ vitest `*.test.ts` | ✅ xUnit `*Tests.cs` | ❌ **none emitted** | ✅ pytest `tests/test_*.py` | ✅ JUnit 5 `*Tests.java` |
| `expect(x).toBe/…` (5 value matchers) | ✅ | ✅ | — | ✅ | ✅ |
| `expect(call).toThrow()` | ✅ | ✅ | — | ✅ | ✅ |
| `create({…})` input coercion (ids / VOs / datetime / omitted-optional fill) | ✅ | ✅ | — | ✅ | ✅ |
| `currentUser`-gated op → synthetic admin actor threaded | ✅ | ✅ | — | ✅ | ✅ |
| `expect` with no matcher (bare boolean) | throws (gated) | throws (gated) | — | `assert <expr>` | `assertTrue(<expr>)` |
| Dedicated unit test for the emitter | ✅ | ✅ | — | ❌ | ❌ |
| **E2E `api`** (HTTP, multi-backend replay) | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised |
| **E2E `ui`** (Playwright) | ✅ (react/vue/svelte hosts) | — frontend-hosted — | (ashPhoenix HEEx page objects) | — frontend-hosted — | — frontend-hosted — |

## Findings

### F1 — Phoenix/Elixir silently drops domain `test "…"` blocks (major)

`src/generator/elixir/` contains **no test emitter** — no reference to
`agg.tests` / `TestIR` anywhere under it (Ash *or* `foundation: vanilla`
paths). The other four backends each call an `emit/tests.ts`:

- node — `src/generator/typescript/emit/tests.ts` → `domain/<agg>.test.ts`
- dotnet — `src/generator/dotnet/emit/tests.ts` → `Tests/<Plural>/<Agg>Tests.cs`
- python — `src/generator/python/emit/tests.ts` → `tests/test_<agg>.py`
- java — `src/generator/java/emit/tests.ts` → `<Agg>Tests.java`

The validator (`validateAggregateTestBodies`) accepts `test` blocks on
**any** aggregate regardless of target platform, so a `.ddd` that
declares domain tests and is generated to a `platform: elixir`
deployable produces **zero** test files — the assertions are dropped
without a diagnostic. A user who writes value-object invariant tests
and then targets Phoenix gets a green build that tested nothing on that
backend.

This is the single real parity break. It is **not** documented: the
Phoenix section of `docs/generators.md` (the `## Phoenix LiveView
fullstack` block) has no "Tests" row, while the Java (`test "…"` →
JUnit 5) and Python (`test "…"` → pytest) sections do; the
cross-platform matrix marks `test "name"` n/a only for the *React*
column; and the gap is not in "What the generators don't do".

ExUnit is the obvious target shape — `test/<app>_test.exs` with
`describe`/`test` blocks asserting through the Ash resource / vanilla
changeset factories, the elixir sibling of the existing four emitters.

### F2 — No gate catches the silent drop (medium)

Nothing fails when a backend that *can't* emit domain tests is handed a
`.ddd` full of them. Compare F1's e2e sibling: `validateE2ETest` plus
the system renderer reject an unlowerable e2e statement loudly
(`loom.e2e-unsupported-statement`) rather than ship a "green-but-empty"
test — the stated design principle. The domain-test path has no
equivalent. Two honest options:

1. **Emit them** (close F1) — preferred.
2. **Gate them** — a validator diagnostic (e.g.
   `loom.domain-tests-unsupported-on-platform`) when an aggregate with
   `tests.length > 0` is hosted only on a backend that emits none, so
   the drop is a visible decision, not a silent one.

Either way there should be a **conformance assertion** that every
backend with domain logic emits a test artefact for an aggregate that
declares `test` blocks (today nothing in `test/conformance/` checks
test-file emission at all).

### F3 — `expect`-without-matcher contract diverges (minor)

The grammar validator (`checkExpectMatcher`) guarantees every `expect`
carries a matcher, so this is currently **dead code** — but the four
emitters disagree on what to do if one ever slipped through:

- node / dotnet: **throw** an internal error (`expect requires a
  matcher`).
- python: falls back to `assert <renderTestExpr(expr)>`.
- java: falls back to `assertTrue(<renderJavaExpr(expr)>)`.

The python/java fallbacks would also misfire for an *unrecognised*
matcher name (anything outside the five comparison matchers): python
emits `assert <the matcher method-call rendered as a python
expression>` and java `assertTrue(<…>)`, neither of which is the
intended assertion, where node would pass the matcher name straight to
vitest and dotnet/java/python's explicit-matcher path returns null. The
matcher catalogue (`intrinsic-matchers.ts`) restricts the *value*
matcher set to exactly `toBe`, `toBeGreaterThan`,
`toBeGreaterThanOrEqual`, `toBeLessThan`, `toBeLessThanOrEqual`
(+ `toThrow`), so all four in-scope backends are at real parity for the
allowed set — but the fallbacks make the *failure mode* inconsistent.
Recommendation: make python/java `throw` on the no-matcher /
unknown-matcher path too, matching node/dotnet, so an invariant
violation surfaces identically everywhere.

### F4 — Emitter test coverage is uneven (minor)

`test/generator/create-in-test-emission.test.ts` asserts the
`create({…})` coercion only for **TS and .NET**. The **Python and Java**
domain-test emitters have **no dedicated unit test** (grep for
`renderPyTestsFile` / `renderJavaTestsFile` across `test/` finds
none) — they are only exercised indirectly if a build-gated corpus
example happens to contain `test` blocks. The emitters that emit are
themselves unequally guarded.

## What is at parity (the positives)

- **E2E `api` parity is strong.** `renderE2EFile` emits one vitest file
  that **replays each `test e2e … against <backend>` block against every
  compatible backend deployable** (`compatibleBackends` + the multi-
  backend `against <slug>` suffix). Because it is black-box HTTP, the
  same suite exercises Phoenix, Java, Python, .NET and Hono identically
  — this is exactly the layer that catches response-shape / validation-
  order / error-format divergence the OpenAPI parity check can't see.
  Phoenix is therefore **not** untested at the integration level; only
  its *domain unit tests* are missing.
- **The four domain-test emitters that exist are semantically aligned**:
  same five value matchers, same `toThrow` handling, the same
  `create({…})` input-coercion strategy (brand ids, construct value
  objects in declared field order, fill omitted create-inputs), and the
  same synthetic full-access actor threaded into `currentUser`-gated op
  calls (`TEST_ACTOR` / `TEST_ACTOR_PY` / `__testUser` / the C# `User`
  stub). The divergences between them are idiomatic (vitest vs xUnit vs
  pytest vs JUnit), not behavioural.

## Recommendations (ranked)

1. **Emit ExUnit domain tests on Phoenix** (closes F1) — the
   highest-value gap; brings the five-backend set to full domain-test
   parity. New emitter `src/generator/elixir/*-tests-emit.ts` consumed
   by `src/generator/elixir/index.ts`, plus a `Tests` row in the
   Phoenix section of `docs/generators.md`.
2. **Add a conformance gate** that every domain-logic backend emits a
   test artefact for an aggregate declaring `test` blocks (closes F2's
   detection gap). Until F1 lands, the gate would document the Phoenix
   exception explicitly.
3. **Unify the no-matcher / unknown-matcher failure mode** across the
   four emitters (F3): python and java should `throw`, matching
   node/dotnet.
4. **Backfill emitter unit tests** for the python and java domain-test
   emitters (F4), mirroring `create-in-test-emission.test.ts`.
