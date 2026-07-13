# Runtime conformance harness — execute the contract, don't just compile it

> **Status:** scoping / tracked follow-up. Motivated by an all-platforms
> generated-code review (June 2026) that surfaced runtime defects the existing
> harness could not have caught. The fast generated-source assertion layer
> (below, "Tier 0") is landing incrementally per finding; this doc scopes the
> heavier runtime tier.

## Why

The review found bugs that every build/compile gate is structurally blind to:

- **The Phoenix `ViewsController` raised `CaseClauseError` on every view
  request** (the elixir backend; at the time, both the ash and vanilla
  foundations — Ash foundation removed since, vanilla Ecto/Phoenix is the
  only foundation now): the controller pattern-matched
  `{:ok, records}` against a `run/1` that returns a bare list. It compiles
  cleanly — only a *request* reveals it. There was **no test** over the
  view/controller path at all. (Fixed; pinned by
  `test/generator/elixir/view-controller-shape.test.ts`.)
- **The generated .NET test project doesn't compile** (`p.Rename("")` — wrong
  arity + `void` bound to `var`). `generated-dotnet-build.test.ts` runs
  `dotnet build` on the `dotnet_api` project only; the sibling
  `Tests/DotnetApi.Tests.csproj` is **never built**.
- **React forms never surface server validation errors** (the client throws an
  `ApiError` shape `applyServerErrors` doesn't read), boolean columns render
  blank, an external nav link routes to a literal `__external:` path. All
  `tsc`-clean and `vite build`-clean — only a *running* page shows them.
- **The Vue frontend silently drops the `on Live.OrderConfirmed` realtime/toast
  feature** the DSL declares (Svelte emits it). Nothing asserts the files exist.

Common thread: **showcase.ddd's `test e2e … toThrow(422/404/409)` conformance
blocks are emitted into generated test suites but executed by nothing in CI.**
The contract is written and verified nowhere. The per-backend matrices
*compile* generated code; they do not *run* it (and don't run the generated
tests).

## The two tiers

### Tier 0 — fast generated-source assertions (primary; no toolchain)

Plain `vitest` tests in the default `npm test` that assert the *shape of the
emitted source*. This is how the repo's generator tests already work
(`render-expr-kinds.test.ts`, `walker-*.test.ts`). It is the first line of
defense and the TDD vehicle for each finding fix. Examples already landed:

- `test/generator/elixir/view-controller-shape.test.ts` — view `run/1` /
  controller return-shape agreement.
- `test/generator/hono/error-status-tiers.test.ts` — pins the shipped two-tier
  error→status contract so the emitter can't drift from `error-defaults.ts`.

Cheap, fast, runs everywhere. Catches *emitter* regressions. Cannot catch a bug
that only manifests from the interaction of compiled artifacts at runtime.

### Tier 1 — runtime conformance (heavier; gated, opt-in)

Boot each generated backend and **actually execute** showcase's negative-path
`toThrow(N)` blocks (+ the happy-path creates) against the live HTTP surface,
asserting the *same status per case across all backends*. `test/e2e/e2e.test.ts`
already boots the docker-compose stack and hits `/health` + runs DSL e2e — the
extension point exists.

Scope to close the specific gaps found:

| Gap | Tier-1 action |
|---|---|
| Phoenix view `CaseClauseError` | hit `GET /api/views/<v>` and assert 200 + body (vanilla Ecto/Phoenix — the only elixir foundation; Ash removed) |
| .NET generated tests don't compile/run | PARTIAL: the showcase dotnet case asserts the `Tests/` csproj is *emitted*, and the generated test code's compile-readiness (currentUser actor + no void→var) is guarded by a fast generator test. Actually `dotnet build`ing it in CI is blocked: the runner's NuGet feed lacks the test-only packages (AwesomeAssertions/xunit) and build-time restore of them isn't reliable. TODO: once the CI NuGet feed carries the test packages, `dotnet build` then `dotnet test` the Tests project. |
| Generated test suites never executed | run the emitted vitest/JUnit/pytest/ExUnit suites where the toolchain is present |
| React/Vue runtime behavior | extend the Playwright smoke (already emitted) to submit a form with a 422 and assert per-field error display; assert realtime files emitted |

## Sequencing

1. **Tier 0 per finding** (in flight) — red test → generator fix → green, in
   default `npm test`.
2. **Compile the generated `Tests/` project** in the showcase dotnet case —
   blocked on CI NuGet not carrying the test-only packages (AwesomeAssertions/
   xunit). Once the feed has them: `dotnet build` then `dotnet test` the Tests
   project. (Generated test-code shape is guarded by a fast generator test
   meanwhile.)
3. **Cross-backend status conformance runner** — lift showcase's `toThrow`
   blocks into an executable matrix over the booted backends.
4. **Frontend runtime assertions** — extend the emitted Playwright smoke.

## Non-goals

- Replacing the compile/build matrices — they stay; runtime conformance is
  additive.
- Standing up all five toolchains in the default `npm test` — Tier 1 is opt-in
  (`LOOM_*` gated), Tier 0 is the always-on net.
