# Test parity across generated backends

> Status: **first pass — 2026-06-21; F1 partially closed (pure-subset
> ExUnit shipped for Phoenix).** Empirical snapshot of what the `.ddd`
> `test` / `test e2e` declarations actually emit on each of the five
> backends. Read alongside [`docs/generators.md`](../generators.md)
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
| Domain `test "…"` → unit-test file | ✅ vitest `*.test.ts` | ✅ xUnit `*Tests.cs` | ◑ ExUnit `*_test.exs` (**pure-subset**: in-memory tests run, `create`/op/`toThrow` tests `@tag :skip`) | ✅ pytest `tests/test_*.py` | ✅ JUnit 5 `*Tests.java` |
| `expect(x).toBe/…` (5 value matchers) | ✅ | ✅ | ✅ (pure tests) | ✅ | ✅ |
| `expect(call).toThrow()` | ✅ | ✅ | skipped (no in-mem raise) | ✅ | ✅ |
| `create({…})` input coercion (ids / VOs / datetime / omitted-optional fill) | ✅ | ✅ | skipped (DB-backed) | ✅ | ✅ |
| `currentUser`-gated op → synthetic admin actor threaded | ✅ | ✅ | skipped (op = DB) | ✅ | ✅ |
| `expect` with no matcher (bare boolean) | throws (gated) | throws (gated) | — | `assert <expr>` | `assertTrue(<expr>)` |
| Dedicated unit test for the emitter | ✅ | ✅ | ✅ | ❌ | ❌ |
| **E2E `api`** (HTTP, multi-backend replay) | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised |
| **E2E `ui`** (Playwright) | ✅ (react/vue/svelte hosts) | — frontend-hosted — | (ashPhoenix HEEx page objects) | — frontend-hosted — | — frontend-hosted — |

## Findings

### F1 — Phoenix/Elixir silently drops domain `test "…"` blocks (major) — *partially closed*

> **Update (shipped):** `src/generator/elixir/tests-emit.ts` now emits a
> **pure-subset** ExUnit suite on both foundations (wired into
> `index.ts` and `vanilla/index.ts`; `test/<ctx>/<agg>_test.exs` +
> `test/test_helper.exs`). An in-memory test (value-object construction +
> field reads, asserted via `expect(x).<cmp>(y)`) runs; a test that calls
> aggregate `create`/operations or asserts a construction-time
> `expect(…).toThrow()` is emitted as an `@tag :skip` placeholder
> (name + reason preserved). The "silent drop" below is therefore gone —
> assertions are now either run or *visibly* skipped. The remaining gap
> (DB-backed `create`/op/invariant tests) needs a DataCase + sandbox
> harness to un-skip; see the recommendations. The original finding is
> kept below for context.

The original state: `src/generator/elixir/` contained **no test
emitter** — no reference to `agg.tests` / `TestIR` anywhere under it
(Ash *or* `foundation: vanilla` paths). The other four backends each
call an `emit/tests.ts`:

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

This was the single real parity break, and it was **not** documented:
the Phoenix section of `docs/generators.md` had no "Tests" row, while the
Java (`test "…"` → JUnit 5) and Python (`test "…"` → pytest) sections
did; the cross-platform matrix marked `test "name"` n/a only for the
*React* column; and the gap was not in "What the generators don't do".
(The Phoenix "Tests" row now exists.)

### F2 — No gate catches the silent drop (medium) — *mitigated*

The original concern: nothing failed when a backend that *can't* emit a
test was handed a `.ddd` full of them — compare F1's e2e sibling, which
rejects an unlowerable e2e statement loudly
(`loom.e2e-unsupported-statement`) rather than ship a "green-but-empty"
test.

The pure-subset emitter mitigates this at the **emission** layer: an
un-portable Phoenix test is now an `@tag :skip` with its reason inline,
not a dropped assertion — visible in the generated tree and in
`mix test` output (`N skipped`). What's still missing is a
**conformance assertion** that every domain-logic backend emits a test
artefact for an aggregate that declares `test` blocks (nothing in
`test/conformance/` checks test-file emission). That gate would also pin
the pure-vs-skip classification so a future change can't regress it.

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

1. ~~**Emit ExUnit domain tests on Phoenix**~~ — **done** (pure-subset):
   `src/generator/elixir/tests-emit.ts`, wired into `index.ts` +
   `vanilla/index.ts`, with a Phoenix "Tests" row in `docs/generators.md`
   and a generator test (`test/generator/elixir/exunit-tests-emit.test.ts`).
2. **Promote the skipped Phoenix tests to runnable** with a DataCase +
   `Ecto.Adapters.SQL.Sandbox` harness + a Postgres-backed `mix test`
   CI gate (the sibling of the `*-obs-e2e` legs that already stand up a
   Postgres sidecar). This is what un-skips the `create`/op/invariant
   tests — the remaining half of F1. Bigger lift; deferred deliberately
   (it makes Phoenix domain tests DB-backed integration tests, unlike the
   pure/in-memory tests of the other four backends).
3. **Add a conformance gate** that every domain-logic backend emits a
   test artefact for an aggregate declaring `test` blocks, and pin the
   Phoenix pure-vs-`@tag :skip` classification (closes F2's detection
   gap; nothing in `test/conformance/` checks test-file emission today).
4. **Unify the no-matcher / unknown-matcher failure mode** across the
   emitters (F3): python and java should `throw`, matching node/dotnet.
   (The new elixir emitter already `throw`s on an unknown matcher.)
5. **Backfill emitter unit tests** for the python and java domain-test
   emitters (F4), mirroring `create-in-test-emission.test.ts`.
