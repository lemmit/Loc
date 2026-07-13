# Cross-stack lint, static analysis, and type-metadata emission

> **[2026-06-20 status audit]** C# nullable-reference annotations + the .NET analyzer gate have SHIPPED (`dotnet/emit/program.ts` `Nullable`/`AnalysisLevel`, gated by `dotnet build /warnaserror`). Only repo-content/markdown lint remains in 'Remaining'.

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only and `foundation: ash` is now a validation error. The `@spec` emission below still applies to the vanilla Ecto backend, but the "Ash-specific specing discipline", "Ash error mapping", and "Note on Ash v3" subsections describe Ash internals that no longer exist — the macro-noise problem they reason about goes away on plain Ecto, so the Dialyzer deferral against Ash is moot.)**

> Status: **PARTIAL.** The Phoenix arm has largely landed: the generator now
> emits Elixir `@spec`s on event/VO modules + polymorphic readers (#902), on
> `view` module `def run/1` (#906), on `workflow` `def run/2` (#911), plus a
> shared `<App>.Types` module threaded through every `@spec`/`@type` site
> (#904); Dialyzer is wired onto CI behind `LOOM_PHOENIX_DIALYZER=1` (Dialyxir
> dep + `.dialyzer_ignore.exs` template + `phoenix-dialyzer` workflow, #907/#918);
> and opt-in format gates `LOOM_DOTNET_FORMAT` / `LOOM_PHOENIX_FORMAT` exist
> (#903). **Remaining:** enabling C# nullable-reference annotations (the .NET
> type-metadata arm), an analyzer gate for .NET, and repo-content lint. Extends
> the existing `LOOM_BIOME=1` gate to the other emission targets (.NET, Phoenix,
> repo content) and frames the deeper move: the generator should *emit
> type metadata* — nullable annotations in C#, `@spec`s in Elixir — so
> that whichever analyzer runs downstream has more to chew on.

## Problem

The toolchain has exactly **one** static-analysis gate against generated
output today: `npm run test:biome-gen` (`LOOM_BIOME=1`) runs Biome
against emitted TS/TSX. The matching gates for the other three emission
targets are missing:

| Stack | Build gate | Format gate | Analyzer gate | Type-metadata emission |
|---|---|---|---|---|
| TypeScript (Hono, React) | `test:tsc`, `test:tsc-react` | `test:biome-gen` (format + lint) | (same — Biome) | already strong (TS) |
| .NET | `test:dotnet` (`/warnaserror`) | — | — | nullable-disabled |
| Phoenix | `test:phoenix` (`--warnings-as-errors`) | — | — | no `@spec`s |
| repo content (md/json/yml) | — | partial (Biome JSON) | — | n/a |

The compile-warning gates catch real errors but leave a wide band of
real bugs invisible — null derefs in C#, `with`-clause mistakes and
unused-pattern bugs in Elixir, prose drift in docs. Worse, the generator
is in a privileged position to feed *richer* type info to whichever
analyzer runs (it already holds a fully-resolved `LoomModel`), and it
isn't using it.

## The framing that matters

Separate two decisions that usually get bundled:

1. **Tool depth** — which static-analysis tool to run, and at what
   strictness.
2. **Emitted-metadata depth** — how much type information the generator
   writes into the emitted source for any analyzer (now or future) to
   consume.

Bundling them produces the wrong answer in both directions: you either
skip the cheap metadata work because you don't want the expensive tool
yet, or you skip a high-signal tool because it'd be noisy against
metadata-poor output. Decided separately, you can ship the metadata
unconditionally and bring the tool online when its cost curve is
favourable.

### Why metadata-first is the right asymmetry

The IR already carries every type the downstream analyzer needs:
`Property.optional`, `wireShape` field nullability, repository return
shapes, value-object constructors, method signatures lowered into
`render-expr.ts` are all *fully resolved*. Emitting nullable annotations
in C# or `@spec`s in Elixir is a few-line change in
`src/generator/dotnet/emit/*.ts` and `src/generator/phoenix-live-view/*-emit.ts`
respectively — it's serializing data we already have. The payoffs
compound across **four independent channels**, only one of which needs
the analyzer turned on:

1. **IDE hover docs** (OmniSharp / Rider for C#; ElixirLS / Lexical for
   Elixir).
2. **`mix docs` / generated XML doc output** — specs and nullable
   annotations become part of the user-facing documentation surface.
3. **Future-proofing** — Elixir 1.18+ ships a built-in gradual type
   system that consumes `@spec`s natively; nullable C# is the default
   posture going forward. Code already annotated gets checked for free
   the day you bump the toolchain.
4. **Analyzer input** when (and if) you turn one on.

Channels 1–3 happen even with the analyzer permanently off. So the
metadata decision dominates the tool decision; emit it now, decide on
tools separately.

## .NET — analyzers, not just format

`dotnet format` alone is whitespace + final-newline + a handful of
`.editorconfig`-driven style fixers. It catches almost nothing semantic.
The real signal lives in **Roslyn analyzers**, which ship *inside the
SDK* at zero dependency cost. Two csproj flips are enough:

```xml
<PropertyGroup>
  <AnalysisLevel>latest-recommended</AnalysisLevel>
  <AnalysisMode>AllEnabledByDefault</AnalysisMode>
  <Nullable>enable</Nullable>
  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
</PropertyGroup>
```

`latest-recommended` enables ~200 rules across Design, Performance,
Reliability, Security, and Usage categories. The high-signal members:

- **CA1062** — validate arguments of public methods (null-check).
- **CA2007** — `ConfigureAwait(false)` on library awaits.
- **CA1031** — don't catch general `Exception`.
- **CA1822** — mark members `static` when they don't use instance state.
- **CA1854** — prefer `TryGetValue` over `ContainsKey` + indexer.
- **CA2016** — forward `CancellationToken`.
- **CA1816** — call `GC.SuppressFinalize` correctly.

These are **bugs**, not bikeshedding. The generator currently emits
catch-all `try/catch` blocks and never forwards cancellation tokens
through repository calls — both are real defects that surface
immediately on a first run.

### Skip these (for now)

- **StyleCop.Analyzers** — pure style; overlaps with bundled rules.
- **Roslynator** — overlaps; adds a NuGet dep.
- **SonarAnalyzer.CSharp** — overlaps; commercial focus.

The case for `latest-all` over `latest-recommended` is weaker — `all`
includes opinion-heavy rules (CA1303 string-localisation, CA1707
underscores in names) that fight the generator without fixing bugs.
Start at `latest-recommended`, promote individual rules to error as
they earn it.

### Generator work

> **Correction (post-merge survey).** This section originally claimed
> the emitter renders `string Name { get; set; }` regardless of
> optionality. That's wrong — `src/generator/dotnet/render-expr.ts:425`
> already maps `TypeIR.kind === "optional"` to `T?`, and every emitter
> site that writes a property/parameter/return type goes through
> `renderCsType` (e.g. `emit/entity.ts:123`, `:159`, `:168`,
> `:181`, `:286`, `:320`, `:460`, `:464`). Combined with the
> already-present `<Nullable>enable</Nullable>` in `renderCsproj`
> (`emit/program.ts:535`, `:564`) and the existing CI `/warnaserror`
> gate, the IR→C# nullable thread is already in place. The find-shape →
> `Task<T?>` mapping for `FirstOrDefaultAsync` is also already wired
> (`find-emit.ts:121`).

`<Nullable>enable</Nullable>` is already the lever. The actual gap on
the .NET side is therefore **just the analyzer flip + CA-rule
cleanup** — adding `<AnalysisLevel>latest-recommended</AnalysisLevel>`
to bring ~200 Roslyn analyzer rules into the build (under the existing
`/warnaserror`) and then fixing whatever they surface. The nullable
sub-bullets above are **already shipped**; treat this as a one-line
csproj change followed by an empirical cleanup pass against CI output.

> **Shipped.** The `<AnalysisLevel>latest-recommended</AnalysisLevel>` flip
> landed alongside the cleanup pass.  First-run audit against
> `examples/sales.ddd` surfaced 97 errors across 6 CA rules
> (CA1725, CA1848, CA1707, CA1859, CA1822, CA1305); the cleanup +
> two `<NoWarn>` suppressions (CA1707 — intentional `_Create` DDD
> convention; CA1848 — LoggerMessage delegates are excessive
> boilerplate for app-tier logging) takes every example fixture +
> the dapper system fixture green under
> `dotnet build /warnaserror`.  Concrete fixes in the emitter:
> handler parameter names (`cmd` → `command`, `q` → `query`,
> `ct` → `cancellationToken`, `b` → `builder`, `__candidate` →
> `candidate`); `IFormatProvider` on numeric/datetime `ToString`
> (CA1305); concrete `ObjectResult` return type on the exception
> filter (CA1859); `_ = this;` discard on empty `AssertInvariants`
> (CA1822); drop redundant `= default` initializer on optional
> reference fields (CA1805).

### The "we'll discover bugs" argument

The first run of this gate against the existing emitters **will fail**,
and that failure surface is the point. Compiler `/warnaserror` only
catches a narrow band of issues; everything CA-prefixed is currently
invisible. Treat the first-PR-of-fixes as the deliverable, not a tax —
the same shape as introducing Biome to a JS codebase. After that the
generator stays clean by construction.

## Phoenix — format + Credo + `@spec`s now, Dialyzer next

Layer by cost/benefit:

| Tier | Tool / artifact | Cost | Verdict |
|---|---|---|---|
| 1 | `mix format --check-formatted` | trivial | ship |
| 2 | `mix credo` (default profile) | low; some churn first run | ship |
| 3 | Generator-emitted `@spec` on every public function | one-time emitter work in `*-emit.ts` | **ship now, independent of Dialyzer** |
| 4 | Dialyxir / Dialyzer + PLT cache | slow first PLT (5–15 min), ~30 s incremental (the Ash macro-noise that deferred this is gone — elixir is plain Ecto now) | **revisit on the vanilla Ecto backend** |
| 5 | Elixir 1.18+ built-in gradual type system | none extra once toolchain ships it | adopt automatically when stable |

### Why `@spec` is unconditional

See the four-channel payoff above. Concretely, every method on an
aggregate, every repository function, and every value-object
constructor has a known IR signature. The emitter writes:

```elixir
@spec deposit(t(), Money.t()) :: {:ok, t()} | {:error, :insufficient_funds}
def deposit(%__MODULE__{} = account, %Money{} = amount) do
  ...
end
```

The `Money.t()` / `t()` opaque-type pattern is the idiomatic Elixir
shape and maps directly to value-object IR. Find results lower to
`{:ok, [t()]}` / `{:ok, t()} | {:error, :not_found}` from the same
find-shape inspection the .NET nullable-return logic uses. Every
emitter site that writes a `def` gets a paired `@spec` line — small,
local, mechanical.

### Ash-specific specing discipline (the layered model)

Once the generator starts emitting `@spec`s into an Ash backend, the
trick is to spec **the right layer** — your application's own typed
boundary — and treat Ash internals as opaque. Concretely:

```
[ Loom-emitted service / wrapper layer  ]  ← spec everything here
            ↓
[ Ash domain code interface (auto)      ]  ← spec inputs/outputs only
            ↓
[ Ash actions / changesets / queries    ]  ← treat as opaque
            ↓
[ Ash internals                         ]  ← ignore entirely
```

The five disciplines that fall out of this — to be encoded in the
generator as it grows beyond the Phase-3 surface that **PR #902**
already covers (event modules, value-object modules, polymorphic TPC
readers, aggregate helpers, `def inspect`):

1. **Emit a shared `<App>.Types` module per app.** One module per
   generated Phoenix project carrying the domain type vocabulary:

   ```elixir
   defmodule MyApp.Types do
     @type id :: Ecto.UUID.t()
     @type money_cents :: pos_integer()
     @type timestamp :: DateTime.t()
     @type result(t) :: {:ok, t} | {:error, Ash.Error.t()}
     @type result_list(t) :: {:ok, [t]} | {:error, Ash.Error.t()}
   end
   ```

   `renderTypespec` then references `<App>.Types.id()` for ID fields
   (not bare `String.t()`) and the surrounding emitters use
   `Types.result(T.t())` / `Types.result_list(T.t())` for the
   action-returning wrappers below. One module, ~20 LOC, defined once;
   downstream emission gets the abbreviation for free.

2. **Use `ResourceName.t()` freely.** Ash 3.x emits a `@type t` for
   every `Ash.Resource` module that mirrors the declared
   `attributes do ... end` block. Reference `MyApp.Sales.Order.t()`
   everywhere you need the aggregate type; don't redefine it in our
   own emissions for aggregates (we still emit our own `@type t` on
   **non-resource** modules: events, value objects that aren't
   embedded resources, the `Types` module itself).

3. **Spec the code-interface wrappers, not Ash itself.** Ash generates
   the actual `MyApp.Accounts.get_user/1` function from a
   `code_interface do define :get_user end` block — its spec is
   auto-emitted. What's worth speccing is **our** wrappers around it,
   if/when we emit a service-layer module per context. Spec shape:

   ```elixir
   @spec fetch_user(Types.id()) :: Types.result(User.t())
   @spec fetch_user!(Types.id()) :: User.t()  # bang returns bare type
   ```

   Loom doesn't currently emit a service-layer wrapper for Ash code-
   interface calls; if and when it does (per the vanilla-Ecto pivot
   below, or as a deliberate service-boundary slice), the wrapper is
   the natural home for the typed contract — not the Ash action
   itself.

4. **Skip specs on changeset / query private functions.**
   `Ash.Changeset.t()` and `Ash.Query.t()` carry no parameterisation
   that Dialyzer can narrow — they're generic. A `@spec` on a `defp
   build_creation_changeset(params) :: Ash.Changeset.t()` adds zero
   signal. The current `renderHelperFunctions` in `domain-emit.ts`
   already only fires on declared `FunctionIR`s (derived
   calculations, validation helpers) — none of which build
   changesets — so the current emission is correctly aligned. Keep
   it that way as the surface grows; if a future emitter starts
   writing changeset-pipeline `defp`s, *don't* spec them.

5. **Calculations / aggregates / relationships are not in the base
   struct typespec.** Ash loads these dynamically and they're absent
   from `@type t` on the resource. Our emission must respect this:
   the `@type t` we write on event / VO modules already only
   includes declared attribute fields, not relationships — keep that
   discipline as the metamodel grows. If a future emitter needs a
   "user with posts loaded" shape, emit a *distinct* type alias
   (`@type user_with_posts :: %User{posts: [Post.t()]}`), not a
   modification of `User.t()`.

### Ash error mapping at service boundaries

A sibling discipline for the future service-layer wrapper work:
emitted wrappers should map `Ash.Error.t()` to a domain error type
the application-level callers can pattern-match on without depending
on Ash error-struct internals. Sketch:

```elixir
@type service_error :: :not_found | :unauthorized | :validation_failed | {:ash_error, Ash.Error.t()}

@spec fetch_for_current_user(Types.id(), User.t()) ::
  {:ok, Post.t()} | {:error, service_error()}
```

Deferred until the wrapper layer exists; tracked here so the design
direction is captured.

### `.dialyzer_ignore.exs` template (shipped as future-proofing)

The generator emits a `.dialyzer_ignore.exs` template at project root
that filters unfixable Ash-internal noise:

```elixir
[
  {~r/lib\/ash\/.*/, :_},
  {~r/lib\/ash_postgres\/.*/, :_},
  {~r/lib\/ash_phoenix\/.*/, :_},
  {"lib/my_app_web/router.ex", :_},  # Phoenix router is macro-heavy too
]
```

Paired with a `dialyzer: [ignore_warnings: ".dialyzer_ignore.exs",
plt_add_apps: [:mix, :ex_unit]]` config block in the generated
`mix.exs` `def project` list.

Without the ignore file, Dialyzer's first run is unreadable. With it,
the noise budget is bounded and our own emitted code stands out
cleanly.

**Originally framed as a Tier 4-only deliverable; shipped early as
future-proofing.** The file is inert when Dialyxir isn't a project
dep — `mix` ignores the unknown `dialyzer:` config key — so shipping
it standalone has zero runtime cost and zero behaviour change. The
moment Dialyxir is added (manually or as part of the future Tier 4
landing), the noise floor is already tuned. Re-evaluate the filter
set after each Ash major bump.

### What PR #902 already shipped vs. what's still ahead

- ✅ `@type t :: %__MODULE__{...}` on event modules (field-accurate, optionals → `| nil`).
- ✅ `@type t :: %__MODULE__{...}` on value-object modules.
- ✅ `@spec` on polymorphic TPC readers with union return types.
- ✅ `@spec` on aggregate `defp` helpers.
- ✅ `@spec inspect(t()) :: String.t()` on the derived `def inspect(record)`.
- ✅ **`<App>.Types` module + `result(t)` vocabulary** — shipped in PR #904.
- ✅ View `def run/1` `@spec` (shorthand list + full-form map projection) — shipped in PR #906.
- ✅ `.dialyzer_ignore.exs` template + `dialyzer:` mix.exs config — shipped early as future-proofing.
- ✅ Workflow `def run/N` `@spec` — landed with a **conservative** return spec
  (`:ok | {:ok, term()} | {:error, term()}`) since `WorkflowIR` carries no
  explicit return type; the param-map shape is precise from `wf.params`.
  Can tighten to `Types.result(T)` per workflow if the IR ever gains a
  `returnType` field, but the conservative version is already useful: it
  documents the contract surface (workflows can fail) and gives Dialyzer a
  typed input map to narrow against.
- ✅ **Dialyxir dev/test-only dep + CI gate** — generated mix.exs declares
  `{:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false}`; new
  `LOOM_PHOENIX_DIALYZER=1` vitest harness boots the same hexpm/elixir
  docker image as the build gate and runs `mix dialyzer` against a
  fixture project; new `.github/workflows/phoenix-dialyzer.yml` runs it
  on PR + main with deps/_build/PLT caching keyed on mix.exs hash +
  Elixir image tag.  Cold PLT build is 5–15 min; warm runs ~30–60s.
  **First-run audit happens in CI — the empirical Ash v3 question
  from #897 is answered the moment the workflow goes green or surfaces
  its first noise.**
- ⏳ Service-layer wrapper emission (and its spec'd surface) — deferred behind the architectural decision to emit such a layer.

### The vanilla-Ecto pivot changes the Dialyzer calculus

The deferral case against Dialyzer is almost entirely about Ash 3.x's
macro density: success-typing produces opaque errors against generated
resource macros, and the false-positive cost dominates the bug-finding
benefit. **Vanilla Phoenix/Ecto** (`elixir-ecto-and-api-only-backends.md`)
doesn't have that problem — Ecto schemas are plain modules with
ordinary functions, exactly the shape Dialyzer was designed for. Once
the Ecto backend lands, Dialyzer's signal/noise ratio flips, and
generator-emitted `@spec`s on every function give it a maximally rich
input. At that point Dialyzer is the right gate, not a deferral.

> **Note on Ash v3 specifically (worth re-checking empirically).** The
> commonly-cited "Dialyzer is useless against Ash" framing is mostly
> v2-era. Ash v3 added significantly better typespec annotations on
> generated code, so Dialyzer coverage on **action implementations** and
> **code-interface calls** is now reasonable. Deep introspection into
> Ash internals remains limited, but those are not what Loom-generated
> code touches — the generator writes the action bodies and the
> code-interface call sites, which is exactly the surface Ash v3 has
> improved. The practical implication: once `@spec` emission lands on
> the existing Ash backend, **run Dialyzer once locally** against the
> output and read the diagnostics before committing to the
> "Ecto-only" gate posture above. If the false-positive rate is in
> fact tractable on Ash v3, the gate can land on both backends from
> day one — that decision is empirical, not architectural.

Concrete sequencing:

- **Now** — tiers 1–3 on the elixir (plain Ecto) backend.
- **Tier 4 (Dialyzer)** gated on the Ecto output via
  `LOOM_PHOENIX_DIALYZER=1`. (The Ash-macro-noise that previously forced
  excluding Ash output is moot — the Ash foundation was removed.)
- **When 1.18 type system stabilizes** — tier 5 supersedes parts of
  tier 4; reassess.

### Skip these

- **`mix credo --strict`** — adds opinion-heavy refactoring suggestions
  that produce churn without bug-fixing.
- **`mix xref`** dependency checks — already covered by compile gates.
- **Sobelow** (Phoenix security scanner) — worth a separate proposal;
  out of scope for the lint pass.

## Repo content (docs, configs, examples)

The non-generated surface splits into four categories:

| Content | Tool | Verdict |
|---|---|---|
| Markdown (`docs/**`, `*.md`) | `markdownlint-cli2` with a project `.markdownlint.jsonc` | ship; cheap |
| JSON / JSONC | Biome 2.x (already on) | extend `biome.json` includes |
| YAML (`.github/**/*.yml`) | Biome 2.x YAML (beta) **or** `yamllint` | defer until Biome's YAML support is GA; `yamllint` adds a Python dep |
| Handlebars templates (`designs/`, `stacks/`, `api/`, `vite/`, `docker/`) | — | **skip**; no good formatter exists, and `generated-react-build.yml` already gates rendered output |
| `.ddd` examples (`examples/`, `web/src/examples/`) | `ddd fmt` (new CLI verb) backed by `src/language/print/` | **defer**; the printer exists, the verb is ~50 LOC, but a `.ddd` formatter is its own design decision (whitespace policy, comment preservation) |

The markdown case is the highest-value: docs drift is real, and
`docs/README.md` is the canonical index. A `.markdownlint.jsonc` with a
narrow ruleset (heading levels, link references, line length off) lands
green after one normalising pass.

## CI / harness shape — mirror `test:biome-gen` exactly

Every new gate follows the existing `LOOM_*` opt-in convention so it
stays out of the default `npm test` fast path and so the matching CI
workflow is the only place it runs:

| Script | Env var | Harness | CI workflow |
|---|---|---|---|
| `test:format-dotnet` | `LOOM_DOTNET_FORMAT=1` | `test/e2e/generated-dotnet-format.test.ts` | new step in `dotnet-build.yml` |
| `test:format-phoenix` | `LOOM_PHOENIX_FORMAT=1` | `test/e2e/generated-phoenix-format.test.ts` | new step in `phoenix-build.yml` |
| `test:dialyzer-phoenix` | `LOOM_PHOENIX_DIALYZER=1` | `test/e2e/generated-phoenix-dialyzer.test.ts` | new workflow `phoenix-dialyzer.yml` (PLT cached on `ecto-deps-hash`) |
| `test:lint-md` | `LOOM_LINT_MD=1` | direct `markdownlint-cli2` step (no vitest harness needed) | new step in `test.yml` |

Each `.test.ts` harness reuses the helpers that already emit per-backend
fixture projects (`generated-dotnet-build.test.ts`,
`generated-phoenix-build.test.ts`); the body is a `child_process.spawnSync`
call against the formatter with `--check`-style flags and a non-zero
exit-code assertion. No new architectural concept — fourth instance of
a pattern that already exists.

## Generator changes — concrete file map

### .NET (`src/generator/dotnet/`)

- `csproj.ts` — emit the four `<PropertyGroup>` flips above.
- `emit/aggregate.ts`, `emit/value-object.ts`, `emit/dto.ts`,
  `emit/event.ts` — render `?` on optional reference-type properties
  using `Property.optional`. Mark required properties with the
  `required` modifier where the C# version supports it; otherwise
  initialize with `= null!;` for EF-materialized DTOs.
- `emit/repo.ts` — return `Task<T?>` for single-result finds, `Task<T>`
  for collection results; thread `CancellationToken` parameter through
  every `async` method (CA2016).
- `render-stmt.ts` — replace `catch (Exception)` blocks with typed
  catches (CA1031).

### Phoenix (`src/generator/phoenix-live-view/`)

- `aggregate-emit.ts`, `repo-emit.ts`, `value-object-emit.ts`,
  `event-emit.ts` — write `@spec` line preceding every `def`. Reuse the
  same type-rendering pass that `render-expr.ts` already does for
  argument and return-type sites; add a `renderTypeSpec(ty)` helper in
  `phoenix-live-view/types.ts`.
- Add a `@type t :: %__MODULE__{...}` line per struct module.
- No `mix format` config changes needed — Elixir's formatter is
  opinion-fixed.

### Repo

- `biome.json` — extend `files.includes` to cover `*.json`, `*.jsonc`.
- New `.markdownlint.jsonc` at repo root with the narrow ruleset.
- `package.json` — add the new `test:format-*` and `test:lint-md`
  scripts.
- New `test/e2e/generated-{dotnet,phoenix}-format.test.ts` files.

## Open questions

1. **`<AnalysisLevel>` value pinning.** `latest-recommended` is a moving
   target across SDK versions; explicit `9.0-recommended` (or whatever
   matches the pinned SDK) avoids drift, at the cost of needing a bump
   when the SDK bumps. Suggest pinning and bumping deliberately —
   matches the rest of the toolchain posture (Langium version,
   Handlebars version, etc.).
2. **PLT cache strategy for Dialyzer.** Keying on a hash of
   `mix.lock` + Elixir version is the common pattern; CI cache size
   ~300 MB per Elixir version. Acceptable.
3. **`required` vs. `= null!;` for non-null reference properties.**
   `required` is cleaner but requires C# 11+; check the .NET version
   pin in the generator before picking. If 11+, prefer `required`
   uniformly.
4. **Where does `Sobelow` go?** Phoenix security scanner; out of scope
   here, but a natural sibling proposal once the format/spec/Dialyzer
   ladder is in place.
5. **Should `ddd fmt` ship alongside?** The structural printer exists
   and is round-trip-tested. The verb is small; the question is whether
   to scope it as part of this proposal or as its own. Recommend
   separate — it's a language-surface decision, not a static-analysis
   one.

## Sequencing (smallest first, value-dense)

1. **.NET: `<Nullable>enable</Nullable>` + `<AnalysisLevel>latest-recommended</AnalysisLevel>` + emitter fixes.** Highest signal-to-effort; the IR has the data, the first run is the value (the bugs it surfaces are the deliverable).
2. **Phoenix: `mix format --check-formatted` + Credo (default profile) + `@spec` emission.** Three-tier landing in one PR; metadata payoff starts immediately even without Dialyzer.
3. **Markdown: `markdownlint-cli2` + one normalising pass.** Independent of the generator; can land in parallel.
4. **(Future) Phoenix Dialyzer, gated on the Ecto backend.** Lands as a follow-up once `elixir-ecto-and-api-only-backends.md` ships.
5. **(Future) `.ddd` formatter.** Separate proposal.

## Tradeoff

Every analyzer flip surfaces existing generator sloppiness, and that
*is* the value — but the first PR of each ladder is a
generator-cleanup PR, not a CI-config PR. The cost is one-time and
front-loaded; the benefit compounds (every future emitter change stays
clean by construction). The Dialyzer caution that once applied to Ash is
moot — the Ash foundation was removed, so the macro-noise problem is gone
and the elixir backend is plain Ecto only.
