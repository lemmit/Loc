# Cross-stack static analysis — remaining slices

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The Phoenix references below to the Ash code-interface, `Ash.Error.t()` mapping, and "Ash v3 audit" describe generated output that no longer exists; the service-layer slice now wraps the plain Ecto context functions.

> **[2026-06-20 status audit]** Slice 4 (workflow `returnType` enrichment) SHIPPED (`enrichments.ts`, consumed at `elixir/workflow-emit.ts`). Only three slices remain (format-CI, Credo, service-layer).

> Status: **proposal**.  Follow-up to
> `docs/old/proposals/cross-stack-static-analysis.md`, which framed and
> shipped the bulk of the Phoenix Tier 3 / Tier 4 surface (PRs #902,
> #904, #906, #907, #911, #918) plus the .NET Tier 3 analyzer flip
> (#942).  This doc captures the deliberately-deferred slices so they
> can be prioritised independently.

## What's already gated

Recap (full audit in the parent proposal):

| Tier | .NET | Phoenix |
|---|---|---|
| 1 (format) | ⏳ scaffold only (`LOOM_DOTNET_FORMAT`, no CI workflow) | ⏳ scaffold only (`LOOM_PHOENIX_FORMAT`, no CI workflow) |
| 2 (lint) | ✅ shipped (`<AnalysisLevel>latest-recommended</AnalysisLevel>` + 6-CA cleanup, #942) | ⏳ Credo not started |
| 3 (`@spec`s / metadata) | ✅ shipped (Nullable was already on; renderCsType handles optional→`T?`) | ✅ shipped (events/VOs/polymorphic readers/helpers/views/workflows + `<App>.Types`) |
| 4 (type-checker / Dialyzer) | n/a (Nullable is the .NET type-check) | ✅ shipped (`phoenix-dialyzer.yml` green on Ash 3.x) |

Four slices are unshipped.  All have clear cost/value/risk profiles
and none block each other.

## Slice 1 — Format gates → CI activation (both backends)

### Surface

Land `LOOM_DOTNET_FORMAT=1` / `LOOM_PHOENIX_FORMAT=1` (already
scaffolded in `test/e2e/generated-{dotnet,phoenix}-format.test.ts`)
as a real CI step in `dotnet-build.yml` / `phoenix-build.yml`,
gating every PR that touches the .NET / Phoenix generator on
`dotnet format --verify-no-changes` / `mix format
--check-formatted` clean output.

### Cost

Small.  One PR per backend, dominated by the "first local run +
cleanup" loop:

1. `LOOM_DOTNET_FORMAT=1 npm run test:format-dotnet` against each
   example fixture; observe whitespace/style drift.  Fix in the
   emitters (`lines(...)` joins, indentation, trailing whitespace,
   final newlines).
2. Same shape for Phoenix via the existing docker harness.
3. Add the workflow step alongside the build gate (`dotnet build
   /warnaserror` already runs in `dotnet-build.yml`; the format
   check is a second step in the same job — no separate PLT cache
   needed).

Expected surface: ~5–15 emitter sites per backend.  The cleanup is
mechanical (no semantic risk; format-only).

### Value

Catches generator drift that produces syntactically valid but
non-canonical output — wrong using ordering, trailing whitespace,
missing final newlines, inconsistent indentation.  The build /
analyzer gates can't see these because they compile and lint clean.
Completes Tier 1 across both backends.

### Risk

Low.  First CI run is the discovery surface (same "first run
surfaces drift" pattern the analyzer slice followed).  Format
violations are mechanical to fix; no design decisions.

### Recommendation

Take .NET first (the local SDK iteration loop is already proven
from #942).  Phoenix second — needs the docker `mix format` harness
which is slower per round but already wired.

## Slice 2 — Phoenix Credo (Tier 2)

### Surface

Land `mix credo` in `phoenix-build.yml` as a second step after `mix
compile`.  Generator emits `.credo.exs` config (default profile,
not `--strict`) at project root; CI runs `mix credo` against the
fixture project.

### Cost

Small — same shape as Slice 1 but against a static-analysis tool
instead of a formatter.  First run will surface refactoring
suggestions (e.g. `Credo.Check.Refactor.Nesting`, `Credo.Check.
Design.AliasUsage`); some are real, some are noise that the default
profile keeps narrow.

Generator changes: emit `.credo.exs` at project root.  Stable
across Loom versions (the file is a static template).  No mix.exs
dep change needed — Credo is invoked via the SDK without being a
project dep.

### Value

Catches refactoring opportunities Dialyzer doesn't see — e.g.
nested pipelines, dead aliases, long function bodies.  Useful but
strictly lower-signal than Dialyzer / the `@spec` work that's
already shipped.

### Risk

Low.  Some churn first run as the generator gets refactoring
suggestions; either fix the emitter or extend `.credo.exs` to
skip the rule.  The decision is documented per-rule in the config.

### Recommendation

Defer behind Slice 1.  Credo is real signal but marginal next to
what Dialyzer + `@spec`s + format already cover.

## Slice 3 — Phoenix service-layer wrapper emission

### Surface

Emit a `<App>.<Ctx>.Service` module per bounded context that
wraps the Ash code-interface calls (`<App>.Accounts.get_user/1`,
`<App>.Accounts.create_user/1`, etc.) with:

1. **Spec'd typed surface** — `@spec fetch_user(Types.id()) ::
   Types.result(User.t())` using the shared `<App>.Types`
   vocabulary from PR #904.
2. **Ash error mapping** — `Ash.Error.t()` → domain
   `service_error()` type, so callers pattern-match on a typed
   contract instead of Ash error-struct internals.

Captures the discipline from the Ash specing guide's
"highest-value place to add specs": the wrappers around the
code-interface, not Ash itself.

### Cost

**Large — design-heavy.**  Requires:

- A new emitter file (`src/generator/phoenix-live-view/service-emit.ts`).
- An IR-level decision: which functions get wrapped?  Every code-
  interface define (`get_user`, `list_users`, `create_user`, ...)
  multiplied by every aggregate's repository finds.
- A `service_error` type definition (in `<App>.Types`).
- Per-operation error mapping logic (how does `Ash.Error.Invalid`
  → `:validation_failed`?  `Ash.Error.Query.NotFound` →
  `:not_found`?).
- Caller-side rewiring: every LiveView / API controller currently
  calls Ash code-interface directly; either keep both surfaces
  (callers opt in to the service layer) or migrate every caller
  to the wrappers.

### Value

High when done.  Concretely:

- Dialyzer sees the **typed boundary** (not Ash internals) and can
  narrow against `Types.result(User.t())` end-to-end.
- Generated code documents the typed contract for human readers:
  `fetch_user/1` says exactly what it can return.
- Pairs naturally with the **vanilla Phoenix/Ecto pivot** (#855 /
  `elixir-ecto-and-api-only-backends.md`): Ecto needs an explicit
  service layer anyway since there's no Ash code-interface to wrap.

### Risk

Medium.  The service-layer architecture is a deliberate design
decision with caller-side rewiring; doing it half-way (emit but
don't migrate callers) leaves the typed contract unused.

### Recommendation

**Defer** until the vanilla Ecto backend is on the table.  When
Ecto lands, the service layer is mandatory anyway — emit it once,
share the Ash and Ecto consumers.  Pre-Ecto, the value is
marginal (Ash's auto-generated code-interface already has decent
typespecs per the Ash v3 audit).

## Slice 4 — Workflow `returnType` IR enrichment

### Surface

Today every workflow `def run/N` emits a conservative `@spec`:

```elixir
@spec run(%{...}, any()) :: :ok | {:ok, term()} | {:error, term()}
```

The `term()` in the success arm is the unknown — `WorkflowIR`
doesn't carry a return type.  This slice adds an IR enrichment
pass that computes the **tail-position type** of the workflow body
(success branch of the last `with` clause, or the final
expression) and threads it into `renderTypespec`.

Result:

```elixir
@spec run(%{customer_id: String.t()}, any()) ::
  :ok | {:ok, MyApp.Sales.Order.t()} | {:error, term()}
```

### Cost

Medium.  Pure IR enrichment work — no generator changes beyond the
spec emission site.  Steps:

1. New pass in `src/ir/enrich/enrichments.ts` (or a new sibling
   file) that walks `WorkflowIR.statements`, tracks the type of
   each `let` binding, and computes the type of the tail
   expression.
2. Store the computed type on a new `WorkflowIR.returnType?:
   TypeIR` field.
3. Update `workflow-emit.ts` to consume it: when set, emit
   `Types.result(<rendered>)` instead of `{:ok, term()}`.

Subtle cases: guarded workflows that throw `{:error, _}` need to
match the `| {:error, term()}` arm correctly (covered by the
existing conservative shape; the enrichment narrows only the
success arm).  Workflows that never return a value (pure side-
effect) stay at `:ok`.

### Value

Tightens Dialyzer narrowing on every call site of a workflow.
Callers (controllers / LiveView event handlers / other workflows)
get a concrete `{:ok, Order.t()}` to pattern-match instead of
`{:ok, term()}`.

### Risk

Low–medium.  The enrichment can be tested in isolation against
synthetic workflow IRs; the worst case if it can't compute a
precise type is to fall back to the conservative `term()`
(same as today).

### Recommendation

**Land standalone** after Slice 1 (format gates).  Self-contained,
ships independently of any other decision, real Dialyzer payoff.

## Out of scope (related but separate proposals)

- **`<AnalysisLevel>latest-all` for .NET** — bump from
  `latest-recommended` to the full ~500 rules.  Marginal value;
  the noise-to-signal ratio at `latest-all` is poor (opinion-heavy
  rules like CA1303 string-localisation, CA1849 thread blocking).
  Skip unless a concrete need surfaces.
- **`ddd fmt` CLI verb for `.ddd` source** — the `src/language/
  print/` printer exists and is round-trip-tested; the CLI verb is
  ~50 LOC.  Its own design decision (canonicalisation rules,
  whitespace policy, comment preservation) — not part of the
  cross-stack story.
- **Sobelow** (Phoenix security scanner) — security-scoped sibling
  of Credo; its own proposal.
- **Vanilla Phoenix/Ecto backend** — see #855 /
  `elixir-ecto-and-api-only-backends.md`.  Unlocks Slice 3's
  full value.

## Recommended sequencing

1. **Slice 1 — Format gates** (smallest, completes Tier 1 across
   both backends; .NET first to reuse the proven local-iteration
   loop from #942, Phoenix second on the existing docker harness).
2. **Slice 4 — Workflow `returnType` enrichment** (self-contained
   IR work, real Dialyzer payoff, doesn't depend on anything else).
3. **Slice 2 — Phoenix Credo** (small, low risk; defer because
   the signal is lower than what's already gated).
4. **Slice 3 — Service-layer wrapper emission** (defer until
   Ecto backend lands; do them together).

Total remaining cost: 1–2 small PRs (Slices 1, 2) + 1 medium PR
(Slice 4) + 1 large architectural PR paired with Ecto (Slice 3).

## Tradeoff

The static-analysis story is already substantially complete on
both backends.  The remaining slices are real wins but the
incremental signal is diminishing — Slice 1 catches whitespace
drift, Slice 2 catches refactoring opportunities, Slice 4 narrows
already-typed return contracts.  Slice 3 is the only one with a
fundamentally new capability (typed boundary surface), and it's
gated on an unrelated decision.  Recommend taking the small ones
opportunistically when touching the relevant emitter; don't
schedule them as a campaign.
