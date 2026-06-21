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
| Domain `test "…"` → unit-test file | ✅ vitest `*.test.ts` | ✅ xUnit `*Tests.cs` | ✅ ExUnit `*_test.exs` (**vanilla**: full port via a pure domain core; **ash**: pure-subset, `create`/op/`toThrow` `@tag :skip`) | ✅ pytest `tests/test_*.py` | ✅ JUnit 5 `*Tests.java` |
| `expect(x).toBe/…` (5 value matchers) | ✅ | ✅ | ✅ (pure tests) | ✅ | ✅ |
| `expect(call).toThrow()` | ✅ | ✅ | ✅ vanilla (create→`{:error}`, op→`assert_raise`); ash skipped | ✅ | ✅ |
| `create({…})` → factory | ✅ | ✅ | ✅ vanilla (`apply_action`, money→Decimal); ash skipped | ✅ | ✅ |
| `currentUser`-gated op → synthetic admin actor threaded | ✅ | ✅ | n/a (no actor seam in the pure core yet) | ✅ | ✅ |
| `expect` with no matcher (bare boolean) | throws (gated) | throws (gated) | — | `assert <expr>` | `assertTrue(<expr>)` |
| Dedicated unit test for the emitter | ✅ | ✅ | ✅ | ❌ | ❌ |
| **E2E `api`** (HTTP, multi-backend replay) | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised | ✅ exercised |
| **E2E `ui`** (Playwright) | ✅ (react/vue/svelte hosts) | — frontend-hosted — | (ashPhoenix HEEx page objects) | — frontend-hosted — | — frontend-hosted — |

## Findings

### F1 — Phoenix/Elixir silently drops domain `test "…"` blocks (major) — *closed for vanilla; pure-subset for ash*

> **Update (shipped):** Phoenix now emits an ExUnit suite
> (`test/<ctx>/<agg>_test.exs` + `test/test_helper.exs`), wired into
> `index.ts` and `vanilla/index.ts`.  The two foundations diverge with
> their domain models — and the investigation corrected an early wrong
> claim that *both* needed a DB:
>
> * **vanilla — full port.**  We control the generated code, so the
>   aggregate carries a **pure domain core** (`vanilla/domain-core-emit.ts`):
>   `create/1 = base_changeset |> Ecto.Changeset.apply_action(:insert)` and
>   `<op>/2 = precondition + in-memory mutation`, both Repo-free.
>   `vanilla/tests-emit.ts` ports the whole idiom onto it — `create`
>   (`{:ok,_}` / `{:error,_}`), operations (state-threaded), precondition
>   `toThrow` (`assert_raise`), field reads (`assert ==`, money via
>   `Decimal`).  **Verified green under `mix test` with no database.**  The
>   only skip is a value-object construction invariant (`expect(Money{…})
>   .toThrow()`) — a vanilla VO is an unvalidated map (a real *runtime* gap,
>   see F5).
> * **ash — pure-subset.**  An Ash resource validates only through the data
>   layer (actions need a live DB) and has no in-memory object-with-methods,
>   so only an in-memory value-object field read runs; `create`/op/`toThrow`
>   stay `@tag :skip`.  (`Ash.Changeset.for_create/for_update` + `valid?`
>   could lower the *rejection* tests DB-free — a viable follow-up.)
>
> The "silent drop" is gone — assertions are now run or *visibly* skipped.

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

### F5 — vanilla value objects aren't validated at construction (runtime gap, surfaced while porting tests)

A `valueobject` with an `invariant` (e.g. `Money { amount: money …
invariant amount >= 0 }`) compiles, on `foundation: vanilla`, to a plain
`:map` (JSONB) column with **no validating constructor** — the VO
invariant is enforced nowhere.  So `expect(Money{ amount: -1 }).toThrow()`
cannot run (nothing rejects the negative amount), and — more importantly —
**a negative Money silently persists at runtime**.  This is why the
vanilla test emitter `@tag :skip`s VO-construction invariants (the one
remaining skip).  Closing it means generating a VO changeset/constructor
(`Money.new(attrs) :: {:ok, t} | {:error, changeset}`, an embedded-schema
changeset running the invariant) and routing aggregate VO fields through
it; the test emitter would then lower `expect(Money{bad}).toThrow()` to
`assert {:error, _} = Money.new(%{…})`.  Ash enforces VO invariants
through the embedded resource, so this gap is vanilla-specific.

### F6 — vanilla didn't apply Loom field defaults in the domain layer (runtime gap) — *fixed*

> **Update (shipped):** the vanilla schema now emits the declared default
> onto the Ecto field (`field :status, :string, default: "open"`) for
> primitive-literal defaults (`schema-emit.ts:renderEctoDefault`).  A fresh
> `%Agg{}` carries the default, so `base_changeset` satisfies
> `validate_required` even when the caller omits the field and `create/1`'s
> `apply_action` returns the defaulted value.  Verified under `mix test`.
> Non-literal defaults (e.g. `now()`) and enum defaults are still skipped
> (an Ecto `default:` must be a compile-time value; the enum atom-vs-string
> question is a separate vanilla concern).

The original gap: a field default (`status: string = "open"`) was **not**
applied by the vanilla schema or `base_changeset` — `status` landed in
`@required_fields` with no default, so `create(%{customer: "acme"})`
(relying on the default) failed `validate_required`.  The other backends
fill the default in their `create` factory; vanilla required the caller to
pass every required field.  Independent of test emission — it affected the
real create path — but it surfaced here because a DSL test that leans on a
default would fail only on vanilla.

> Both F5 and F6 are pre-existing **vanilla codegen** gaps the test-parity
> work uncovered, not regressions introduced by it.  **F6 is now fixed**
> (field defaults emitted); **F5 remains open** — its runtime fix is a
> broad VO-storage change (`:map` → embedded schema, touching wire shape +
> migrations + queries), and shipping only the test-enabling half would
> make the VO-invariant test green while bad values still persist, so it's
> deferred to a focused PR rather than half-done.

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

1. ~~**Emit ExUnit domain tests on Phoenix**~~ — **done**.  Vanilla is a
   full port via the pure domain core (`vanilla/domain-core-emit.ts` +
   `vanilla/tests-emit.ts`); ash is the pure-subset (`tests-emit.ts`).
   Wired into `index.ts` + `vanilla/index.ts`, Phoenix "Tests" row in
   `docs/generators.md`, generator test
   (`test/generator/elixir/exunit-tests-emit.test.ts`), and the emitted
   vanilla suite verified green under `mix test` (no DB).
2. ~~**Add a `mix test` CI gate for the vanilla suite**~~ — **done**.
   `generated-elixir-vanilla-build.test.ts` now runs `mix test` (DB-free —
   no sidecar) on any generated project that carries `test/test_helper.exs`,
   on top of the `MIX_ENV=prod` `mix compile --warnings-as-errors` gate
   (which never compiles `test/`).  Pinned by the `vanilla-domain-tests.ddd`
   fixture (4 tests, green).  This also gates the F6 default fix.
3. **Un-skip the ash rejection tests DB-free** via
   `Ash.Changeset.for_create/for_update` + `valid?` (validations run at
   changeset build, no data layer) — lowers invariant/precondition
   `toThrow` on ash without a DB.  Happy-path state assertions on ash
   still need a DataCase + `SQL.Sandbox` harness (deferred).
4. **Close F5/F6 (vanilla runtime gaps):** generate a validating VO
   constructor (un-skips the last vanilla test shape) and apply field
   defaults in the vanilla schema/changeset.  Both are real correctness
   fixes beyond tests.
5. **Add a conformance gate** that every domain-logic backend emits a
   test artefact for an aggregate declaring `test` blocks, and pin the
   per-foundation classification (closes F2's detection gap).
6. **Unify the no-matcher / unknown-matcher failure mode** across the
   emitters (F3): python and java should `throw`, matching node/dotnet.
   (Both new elixir emitters already `throw` / skip on an unknown shape.)
5. **Backfill emitter unit tests** for the python and java domain-test
   emitters (F4), mirroring `create-in-test-emission.test.ts`.
