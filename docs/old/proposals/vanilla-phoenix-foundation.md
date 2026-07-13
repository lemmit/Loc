# Vanilla Phoenix foundation — `foundation: vanilla` for `platform: phoenix`

> **(Superseded 2026: the Ash foundation was removed.)** This proposal landed and then went further than its original "second adapter" framing: `platform: elixir` now generates Phoenix LiveView on plain Ecto/Phoenix **only**. `foundation:` resolves to `vanilla` — the default and **only** valid value — and `foundation: ash` is now a **validation error**. Everything below that describes Ash as the default, an unchanged path, a non-deprecated co-equal adapter, or a per-deployable choice is historical design record: the Ash foundation no longer ships at all. Read the vanilla emitter description as the description of the sole elixir foundation.

> Status: **PARTIAL — state-based emitter SHIPPED** (slices 0–6,
> #1046–#1051 + #1053/#1054/#1059; TDD plan in
> [`../plans/vanilla-foundation-tdd-plan.md`](../plans/vanilla-foundation-tdd-plan.md)).
> `foundation: vanilla` emits a real second Elixir project from
> `src/generator/elixir/vanilla/` (11 emit modules): plain
> `Phoenix.Endpoint`/`Router` shell, `Ecto.Schema` + `Ecto.Changeset`
> CRUD (read #1047, write #1048; enums/VOs/relations #1049), RFC 7807
> ProblemDetails parity incl. `errors[]` on 422 (#1050),
> aggregate-sourced views (5a, #1053), workflow-instance read endpoints
> (5b, #1054), and workflow execution on plain Ecto (5c, #1059) — with a
> CI fixture (#1051) and slice tests under `test/generator/elixir-vanilla/`.
> **Remaining:** (a) workflow body lowering covers `factory-let` +
> `op-call` only (#1062) — `precondition`/`requires`/`emit`/`repo-let`/
> `expr-let`/`for-each`/`repo-run` still emit `# TODO` comments
> (`vanilla/workflow-execution-emit.ts`); (b) **event sourcing under
> vanilla** (D-VANILLA-ES-HOME) is not started —
> `EVENT_SOURCING_BACKENDS` still excludes `elixir`; (c) per-field
> `validate_*` constraints (blocked on IR constraint metadata); (d)
> vanilla is selected via a hardwired bypass in `elixir/index.ts`, not
> as a first-class adapter (see
> [`../plans/realization-axes-alignment.md`](../plans/realization-axes-alignment.md),
> slices #1061–#1064); (e) `or`-union operation returns + the D-VANILLA-DEFAULT
> warn-then-flip. The four pinned decisions
> (**D-VANILLA-PHOENIX-FOUNDATION**, **D-VANILLA-ES-HOME**,
> **D-NO-MIXED-FOUNDATION**, **D-VANILLA-DEFAULT**) stand. Builds on
> **D-REALIZATION-AXES**, supersedes the framing — not the substance —
> of [`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md)
> §4, and unblocks one half of
> [`workflow-and-applier.md`](./workflow-and-applier.md)'s deferred-ES gap.

> **[2026-06-20 status audit]** The "Remaining" list is stale — workflow body lowering (precondition/requires/repo-let/emit/repo-run, `vanilla/workflow-execution-emit.ts`), event sourcing under vanilla (D-VANILLA-ES-HOME, `eventsourced-emit.ts`), and the provenance runtime (#1400, `vanilla/provenance-emit.ts`) have all LANDED. ~20 emit modules now. Still PARTIAL; `shape(document)` + first-class adapter rewire remain.

## TL;DR

Add a second Phoenix foundation — `foundation: vanilla` — that emits
**plain `Phoenix.Endpoint` + `Phoenix.Router` + LiveView over plain
`Ecto.Schema` / `Ecto.Changeset` / `Ecto.Repo`**, with no `Ash.Resource`,
no `AshPostgres`, no `AshPhoenix.Form`. The existing `foundation: ash`
path is **unchanged and remains the Phoenix default** for state-based
domains.

The proposal is justified by **two independent benefits**, either of which
would carry it alone:

1. **Exception-less alignment.** Vanilla Ecto returns `{:ok, _} | {:error,
   changeset}` natively — a direct map onto
   [`exception-less.md`](./exception-less.md)'s typed `or`-unions. The
   route-edge ProblemDetails translator stops being a `Plug.ErrorHandler`
   rescue tower and becomes per-variant dispatch, byte-aligned with the
   TS/.NET A4 endpoint.
2. **Pure event sourcing on Phoenix.** Vanilla is the home for option 3
   in [`workflow-and-applier.md`](./workflow-and-applier.md)'s ES
   landscape (plain `<Agg>Fold` module + `<agg>_events` Ecto table + thin
   `Repository`). It is the only Phoenix path that matches Loom's
   per-aggregate-stream / fold-on-load contract without re-implementing
   AshCommanded.

`foundation: ash` stays in place. No deprecation; no breaking change to
existing Phoenix users.

## Why now, and why this shape

### 1. The architectural slot already exists

D-REALIZATION-AXES (decisions.md §"D-REALIZATION-AXES") pinned the
`foundation:` axis with `phoenix: ash · vanilla` as its menu and `vanilla`
as the cross-platform default. The grammar accepts it
(`Platform` rule); `platform-rules.ts:184` already lists it as the
intended-future value:

```ts
if (axis === "foundation") return [family === "phoenix" ? "ash" : "vanilla"];
```

The validator rejects `foundation: vanilla` on Phoenix today because the
single-element menu has not yet grown. Lifting that gate is one line; the
work is the second emitter behind it.

### 2. Two strain points on `foundation: ash` are real and independent

**Exception-less strain.** A4 of
[`exception-less.md`](./exception-less.md) deletes route-layer try/catch
towers on every backend in favour of variant dispatch on typed `or`-union
returns. The current Phoenix emitter has the tower as a design feature
(`problem-details-emit.ts` translates `Ash.Error.Invalid` → 422 +
`errors[]`; `api-emit.ts:351` catches it from controllers;
`liveview-emit.ts:466–467` rescues `Ash.Error.Query.NotFound` /
`Ash.Error.Invalid` in `assign`-or-`:error` arms). Vanilla Ecto's
`{:ok, _} | {:error, changeset}` is the natural typed-error carrier and
the tower collapses into per-variant `with` blocks (the same shape
TS/.NET adopt post-A4). `render-stmt.ts` already knows how to coalesce
typed-error chains into `with` blocks for Phoenix — the machinery is
reusable.

**Pure-ES strain.** The cross-backend pure-ES contract (no state table,
per-aggregate `<agg>_events` stream, fold-on-load, emit-and-apply command
bodies) is live on Hono/Drizzle, Hono/MikroORM, .NET/EF, and
.NET/Dapper. On `foundation: ash` there is no clean fit:
[`workflow-and-applier.md`](./workflow-and-applier.md):17 documents
AshEvents as a *partial fit* (state table, single centralized event log,
action-wrapping); AshCommanded is closer but ships heavy Commanded
infrastructure. Building a custom `Ash.DataLayer` over per-aggregate
streams is effectively re-implementing AshCommanded's internals.

Crucially: **neither strain is a Phoenix problem.** Both are
Ash-foundation problems. The same `.ddd` source that hits both today on
Phoenix runs cleanly on Hono and .NET; vanilla Phoenix joins them.

### 3. Decoupling the two motivations matters

Each shipped on its own would justify vanilla. Both shipping together is
strictly additive: the exception-less alignment is the reason vanilla
benefits *every* Phoenix project, ES or not. Don't gate vanilla on the
ES work; ship the foundation, exception-less alignment lands with it for
free, and ES-on-vanilla-Phoenix becomes a thin follow-up (the
`validateEventSourcedStorage` un-gate plus one set of emitters).

## What's emitted under `foundation: vanilla`

Per-aggregate, same shape as the existing ES backends' state path
(Hono/Drizzle, .NET/EF) — vanilla Phoenix mirrors them on a per-aggregate
module basis, no framework-level domain object.

| Module | Role | Replaces (today's Ash path) |
|---|---|---|
| `<App>.<Ctx>.<Agg>` | Struct + Ecto schema mapped to the state table | `Ash.Resource` with `attributes do … end` |
| `<App>.<Ctx>.<Agg>.Changeset` | `cast/3` + per-field `validate_*` + per-action `change_<op>/2` clauses | `actions do … end` + `validations do … end` |
| `<App>.<Ctx>.<Agg>.Repository` | `find_by_id/1`, `list/1`, `save/1`, named finds — returns `{:ok, _} \| {:error, _}` | Code interface on the domain module |
| `<App>.<Ctx>.<Agg>.Policy` | Per-operation guard functions: `can_<op>?(user, agg)` returning `boolean` | `policies do … end` + `Ash.Policy.SimpleCheck` modules |
| `<App>.<Ctx>` | Plain context module exposing `<agg>_<op>/N` functions over `Repository` + `Changeset` | `use Ash.Domain` |

Per the workflow-and-applier doc's option 3, ES aggregates additionally
emit `<Agg>.Events` (Ecto schema for `<agg>_events`) and `<Agg>.Fold`
(`from_events/2` + per-event `apply_event/2` clauses).

### Reused across both foundations (no duplication)

- **HEEx walker** (`heex-walker.ts`, `heex-target.ts`) — emits the `ui`
  DSL, not domain logic. Reused verbatim.
- **Migrations renderer** (`migrations-emit.ts`) — already consumes the
  platform-neutral `MigrationsIR` and emits Ecto DSL. The state-table
  shape is shared; the `<agg>_events` shape is added once (consumed by
  both ES-on-vanilla and `dotnet`/`hono` ES via the shared IR).
- **OpenAPI emitter** (`openapi-emit.ts`), **Jason camel renderer**
  (`jason-camel-emit.ts`), **telemetry emitter** (`telemetry-emit.ts`),
  **seeds emitter** (`seeds-emit.ts`), **theme + sidebar + shell
  emitters** — all foundation-agnostic.
- **Render-expr / render-stmt** — same expression and statement
  rendering; vanilla wires through the same `ELIXIR_TARGET` in
  `_expr/target.ts`. Statement-level differences (precondition lowering,
  emit→repository call) are concentrated in one or two new arms of
  `render-stmt.ts`.

### Replaced under `vanilla` (the actual work)

Concentrated in a sibling subtree, parallel to today's Ash-specific
files:

| Today (Ash) | New (vanilla) |
|---|---|
| `domain-emit.ts` (Ash resource shell) | `vanilla/schema-emit.ts` (Ecto schema) |
| `domain/actions.ts` (`actions do`) | `vanilla/changeset-emit.ts` (per-action changeset functions) |
| `domain/predicates.ts` + policy modules | `vanilla/policy-emit.ts` (plain guard functions) |
| `domain-module.ts` (`use Ash.Domain`) | `vanilla/context-emit.ts` (plain context module) |
| `repository-emit.ts` (code-interface delegates) | `vanilla/repository-emit.ts` (Ecto.Repo queries) |
| `api-emit.ts` controllers (call Ash bang) | `vanilla/api-emit.ts` (`with`-block variant dispatch) |
| `liveview-emit.ts` `AshPhoenix.Form.for_create/_update` | `vanilla/liveview-emit.ts` (embedded `Ecto.Schema` per command + `to_form(changeset)`) |
| `problem-details-emit.ts` (`Plug.ErrorHandler` rescue) | `vanilla/problem-details-emit.ts` (per-variant builder, no rescue) |
| `adapters/ash-postgres-persistence.ts` | `adapters/ecto-postgres-persistence.ts` (advertises `["state", "eventLog"]`) |

The Ash files stay intact. The vanilla subtree is selected by
foundation; the orchestrator (`index.ts`) branches once.

### Hardest seam: LiveView forms

The single biggest piece of work is the `AshPhoenix.Form` replacement
(see `liveview-emit.ts:396,456,548,554,560`). Recipe:

1. **Per command, emit an `Ecto.Schema` `embedded_schema`** mirroring the
   command's fields (no DB table — embedded schemas exist exactly for
   this).
2. `cast/3` + `validate_*` on the embedded schema gives a changeset whose
   `to_form(changeset)` satisfies `Phoenix.HTML.FormData`.
3. Submit dispatches to `<Ctx>.<agg>_<op>(<agg>, params)`; success →
   `{:ok, agg}`, failure → `{:error, changeset}` (own embedded changeset)
   or `{:error, business_error_variant}` (typed error). Both render
   cleanly in the LiveView assign-and-rerender cycle without rescue.

Per-command embedded schemas are ~30 LOC each; emission is per-operation
and lives in `vanilla/liveview-emit.ts`. The HEEx walker doesn't need to
change — its form bindings are already changeset-shaped.

### Authorization

`requires` clauses lower to plain functions: `def can_<op>?(user, agg)
:: boolean`. The controller calls `if Policy.can_<op>?(user, agg), do:
…, else: {:error, :forbidden}`; the route translator maps `:forbidden`
to 403 + ProblemDetails. Matches the Hono/.NET model. Once
exception-less A3 lands, the `:forbidden` atom becomes a typed
`Forbidden` variant uniformly.

### Mixed-mode within a context (ES under Ash)

Even before vanilla becomes a separate foundation, the `Repository` +
`Fold` + `<agg>_events` shape from this proposal is the path
[`workflow-and-applier.md`](./workflow-and-applier.md):24 calls out as
option 3. A bounded context under `foundation: ash` could in principle
opt individual ES aggregates into the vanilla emit path (Ash resources
for state-based, plain modules for ES, `Ash.transaction` wrapping
`Repo.transaction` for workflows that span both). This is the "wait +
guard" alternative from the conversation that produced this proposal.

**Recommendation: don't ship mixed-mode under `foundation: ash`.** The
plumbing seams (workflow body branching on per-aggregate strategy,
forms-without-`AshPhoenix.Form` for ES aggregates only, two parallel
authorization stories) compound at every call site. Mixed-mode is the
worst of both worlds: it carries vanilla's emission cost without
vanilla's exception-less benefit, and it muddles the user-facing mental
model ("which aggregates are Ash?"). The clean answer is **per-deployable
foundation** — pick `vanilla` for ES projects, pick `ash` for projects
that lean on Ash's resource model — and accept the platform-level
boundary.

The middle-ground that is worth shipping is the **structured validator
diagnostic** (see §"Phasing" P0) that explains the choice clearly when a
user hits the gate.

## Decisions pinned

All four are now in [`decisions.md`](../../decisions.md) (canonical text there;
summarised here):

| ID | Decision |
|---|---|
| [D-VANILLA-PHOENIX-FOUNDATION](../../decisions.md#d-vanilla-phoenix-foundation--foundation-vanilla-is-added-to-the-phoenix-menu) | `foundation: vanilla` is added to the `phoenix` foundation menu as a first-class second adapter. Both `ash` and `vanilla` are first-class; neither is deprecated. |
| [D-VANILLA-ES-HOME](../../decisions.md#d-vanilla-es-home--pure-event-sourcing-on-phoenix-lands-only-under-foundation-vanilla) | Pure event sourcing on Phoenix lands **only** under `foundation: vanilla`. AshEvents adoption, AshCommanded adoption, and custom `Ash.DataLayer` over event streams are explicitly **not pursued** (rationale: each carries multi-week-to-month cost for a partial fit; vanilla port costs ~2–4 days for the proven contract). `foundation: ash` + `persistedAs(eventLog)` stays a hard error, with the structured diagnostic from P0 naming the Ash foundation as the constraint. |
| [D-NO-MIXED-FOUNDATION](../../decisions.md#d-no-mixed-foundation--one-foundation-per-deployable-per-aggregate-override-not-added) | A single deployable carries one `foundation` value; per-aggregate foundation override is not added. **This is a structural consequence**, not an additional policy — `foundation:` is a per-deployable axis under D-REALIZATION-AXES, so mixed-foundation within one deployable is already inexpressible in the grammar. The decision merely confirms no per-aggregate escape hatch will be added; users with mixed needs split contexts across deployables or pick `vanilla` for the whole deployable. |
| [D-VANILLA-DEFAULT](../../decisions.md#d-vanilla-default--vanilla-becomes-phoenix-default-after-stabilisation-not-on-first-ship) | Vanilla becomes the Phoenix default **after stabilisation**, not on first ship. Sequencing: (1) vanilla ships opt-in only; (2) after one minor-release cycle with green `phoenix-vanilla-build.yml` + no obs-e2e regressions, emit `loom.foundation-default-flipping` warning for one cycle; (3) flip the default in the next release. Users who want `ash` after the flip set it explicitly (one-line escape hatch remains first-class). |

## Phasing

Estimates are calibrated against **two compounding leverages**: the
observed main-branch velocity (Phoenix TPH shipped proposal → ship →
docs cycle in ~24 hours; ~25 merged PRs/day at the project level), and
the **substantial existing reuse surface** in the Phoenix generator that
makes this a port, not a from-zero build. Earlier proposals were sized
against neither, so their "~4–6 weeks" was conservative even on its own
terms.

**Reuse inventory** (what `foundation: vanilla` inherits without change):

| Component | LOC | Status |
|---|---|---|
| `heex-walker.ts` + `heex-target.ts` (the `ui` DSL → HEEx + `handle_event` pipeline) | 2,255 | foundation-agnostic |
| `migrations-emit.ts` (Ecto DSL from `MigrationsIR`) | 320 | needs only the `<agg>_events` shape variant for P4 |
| `openapi-emit.ts` | 926 | foundation-agnostic |
| `jason-camel-emit.ts`, `telemetry-emit.ts`, `theme-emit.ts`, `sidebar-emit.ts`, `shell-emit.ts`, `seeds-emit.ts`, `dialyzer-ignore-emit.ts` | ~1500 | foundation-agnostic |
| `render-expr.ts` via the `ELIXIR_TARGET` table in `_expr/target.ts` | shared | already extracted (PR #843 series) |
| `render-stmt.ts` (with the `with`-block coalescer the proposal needs) | shared | machinery already exists |
| ES emit shape proven across Hono/Drizzle, Hono/MikroORM, .NET/EF, .NET/Dapper | shared IR | a 5th port, not a novel design |

**Form binding** is also smaller than initially scoped. The
`AshPhoenix.Form` replacement is not "build a new `Phoenix.HTML.FormData`
implementation" — it's swap two call sites per command:

```elixir
# Today (Ash):
form = AshPhoenix.Form.for_create(<Resource>, :action) |> to_form()
case AshPhoenix.Form.submit(form, params: params) do …

# Vanilla:
form = <Cmd>.changeset(%<Cmd>{}, params) |> to_form()
case <Ctx>.<agg>_<op>(params) do {:ok, _} -> …; {:error, %Ecto.Changeset{}} -> …; end
```

`to_form(changeset)` is stock `Phoenix.Component`; the HEEx walker emits
`<.form for={@form}>` already and is changeset-shape-agnostic. ~10–20
LOC per command in `vanilla/liveview-emit.ts`, not novel infrastructure.

| Phase | Scope | Approx. | Dependency |
|---|---|---|---|
| **P0** | Structured validator diagnostic on `persistedAs(eventLog)` + `foundation: ash` (today's bare reject → an Ash-foundation explanation pointing at vanilla / other backends). Banks DX improvement before any vanilla emitter exists. | <1 day | — |
| **P1** | Foundation axis plumbing: lift `platform-rules.ts:184` menu to `["ash", "vanilla"]`; `lower-platform.ts:46` keeps `ash` default; orchestrator (`phoenix-live-view/index.ts`) gains a foundation branch (no-op stub for `vanilla`). Grammar + scope + parsing test + negative validator test. | 1 day | — |
| **P2** | Vanilla state-based emit: `schema-emit`, `changeset-emit`, `policy-emit`, `context-emit`, `repository-emit`, `vanilla/api-emit`, `vanilla/problem-details-emit`, `ecto-postgres-persistence` adapter (~800–1500 net-new LOC). Strict conformance parity gate (`LOOM_E2E_STRICT_PARITY=1`, all 9 dimensions). | **3–7 days** | P1 |
| **P3** | Vanilla LiveView: stock `to_form(changeset)` swap (~10–20 LOC per command). HEEx walker reuse — no walker changes. | **2–4 days** | P2 |
| **P4** | Vanilla event sourcing: `<Agg>.Events`, `<Agg>.Fold`, `<Agg>.Repository` ES variant — porting the proven Hono/.NET shape. Migrations gain `<agg>_events` for Ecto. Un-gate `validateEventSourcedStorage` *only* for `foundation: vanilla`. | **2–4 days** | P2 + workflow-and-applier A2.1-shaped ES infra |
| **P5** | CI: `phoenix-vanilla-build.yml` (mirrors `phoenix-build.yml` — `mix compile --warnings-as-errors`); obs-e2e variant; strict-parity matrix entry. Examples: one `.ddd` under `examples/` exercising `foundation: vanilla` end-to-end. | 2–3 days | P2 |

P0 is detachable and ships immediately. P1–P5 are sequential. Strict
conformance parity (per §5 of
[`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md))
is the gate that makes P2 the largest phase — every wire-spec dimension
must match Ash's emission byte-for-byte.

**Median: ~1.5–3 weeks focused, P0 immediate. Upper bound: ~4–6 weeks**
if the no-local-`mix` CI multiplier compounds on a subtle ProblemDetails-
envelope or relationship-loading parity issue. The earlier
"~4–6 weeks for the Ecto layer alone" framing from
[`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md)
was sized before either the reuse surface above or current velocity were
factored in; treat it as the worst-case ceiling, not the planning median.

## Test plan (consolidated)

Every phase carries its own test surface. Listed together here so the
implementing agent can see the full expected coverage in one place; the
proposal's strict-parity gate (per §5 of
[`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md))
is the non-negotiable cross-cutting one.

### Unit / fast vitest suite (every PR)

| Phase | Test addition | Location |
|---|---|---|
| P0 | Diagnostic shape (Phoenix-specific Ash-foundation framing; links to proposal; cites all three escapes) | `test/ir/eventsourced-storage-support.test.ts` — extend existing matrix |
| P1 | Parsing test for `foundation: vanilla` on `platform: phoenix`; positive validator acceptance; negative for an unsupported foundation value | `test/language/platform-rules.test.ts` (or a new sibling) |
| P1 | `DeployableIR` lowering snapshot — `foundation` field carries `"vanilla"` through to enriched IR | `test/ir/lower-platform.test.ts` |
| P2 | Per-emitter golden tests: `schema-emit` / `changeset-emit` / `policy-emit` / `context-emit` / `repository-emit` / `vanilla/api-emit` / `vanilla/problem-details-emit` each emit byte-identical output for the canonical inputs | new `test/generator/phoenix-live-view/vanilla/*-emit.test.ts` (one per emitter, mirrors the existing Ash pattern) |
| P3 | LiveView form binding — `to_form(changeset)` swap renders the same HEEx as the Ash path for an identical aggregate (changeset-shape-agnostic walker assertion) | `test/generator/phoenix-live-view/vanilla/liveview-emit.test.ts` |
| P4 | `<Agg>.Events` schema shape, `<Agg>.Fold.from_events/2` + per-event `apply_event/2` clauses, `<Agg>.Repository.find_by_id/1` reads stream → folds, `save/2` appends with gap-free versions | `test/generator/phoenix-live-view/vanilla/event-store.test.ts` (mirrors `test/generator/typescript/emit/event-store.test.ts`) |
| P4 | Validator un-gate: `validateEventSourcedStorage` accepts `phoenix` deployable iff `foundation: vanilla`; still rejects under `foundation: ash` | extend `test/ir/eventsourced-storage-support.test.ts` matrix |

### Strict cross-backend wire-spec parity (`LOOM_E2E_STRICT_PARITY=1`, CI per-PR)

The 9-dimension contract (per `docs/conformance.md` and §5 of
`elixir-ecto-and-api-only-backends.md`) is the unforgiving gate. Vanilla
must match Ash byte-for-byte on:

| Dimension | What it asserts |
|---|---|
| Operation set | Same `operationId`s across vanilla and ash for the same `.ddd` |
| Response cardinality | Same `200` / `4xx` / `5xx` per route |
| Schema set | `<Agg>Response`, `<Agg>CreatePayload`, etc., emit identically named |
| Per-schema fields | `wireShape` is the source of truth; both render to the same JSON keys + types |
| Required flags | Field optionality matches |
| Path-param types | Same id-shape on every parameterised route |
| Request/response body refs | `$ref` chains identical |
| OperationIds | Same camelCase ids end-to-end |
| ProblemDetails envelope | `type` / `title` / `status` / `detail` / `instance` byte-identical; `errors[]` extension on 422 identical |

Test entry: extend `conformance-parity.yml`'s matrix to include
`{ash, vanilla} × every example .ddd × every relevant design pack`.

### Generated-project build gate (CI per-PR — slow opt-in `LOOM_PHOENIX_VANILLA_BUILD=1`)

A new `phoenix-vanilla-build.yml` workflow mirrors `phoenix-build.yml`:

| Step | What it runs |
|---|---|
| Generate | `node bin/cli.js generate system examples/<ddd> -o tmp/<ddd>-vanilla` for each example with a `foundation: vanilla` Phoenix deployable |
| Deps | `mix deps.get` inside the generated Phoenix project |
| Compile | `mix compile --warnings-as-errors` (zero warnings tolerated, matching the Ash gate) |
| Migrations | `mix ecto.create && mix ecto.migrate` against a Postgres sidecar |
| Smoke | One end-to-end command per aggregate via the generated controllers |

Sharded the same way `LOOM_PHOENIX_BUILD` is today; runs on PRs that
touch `src/generator/phoenix-live-view/**`.

### Observability e2e (CI per-PR — `LOOM_OBS_E2E_PHOENIX_VANILLA=1`)

Mirror `test:obs-phoenix`: boot the generated vanilla Phoenix backend,
exercise a representative command flow, assert the catalog envelope on
stdout matches the cross-backend shape (same event types, same
correlation/causation ids, same actor attribution). The telemetry
emitter is foundation-agnostic; this test pins that the emission *sites*
match between vanilla and Ash for the same aggregate.

### Examples (P5)

At least one `.ddd` under `examples/` with a `foundation: vanilla`
Phoenix deployable, exercising:

- A state-based aggregate with `operation` + `requires` + `precondition`
  (proves the `with`-block dispatch + plain policy guard pattern)
- An event-sourced aggregate with `create(event:)` + `apply` (proves the
  fold + repository pattern, validates the `validateEventSourcedStorage`
  un-gate)
- A LiveView page rendering both via the stock `to_form(changeset)`
  binding (proves the HEEx walker reuse)

This example is also the input for the strict-parity matrix entry: it
must compile, build, and emit byte-identical wire spec to its Ash
sibling.

### Test debt explicitly **not** taken on by this proposal

- Property-based parity (vs. example-based). Out of scope.
- Mutation testing of the vanilla emitters. Out of scope.
- End-to-end LiveView interaction tests (Playwright) under vanilla. The
  walker is reused; the e2e harness against vanilla can land later.

## Open questions

1. **Default flip timing.** D-VANILLA-DEFAULT recommends keeping `ash`
   as Phoenix default for now. After exception-less A4 ships, vanilla
   becomes objectively the lower-friction default (no
   `Plug.ErrorHandler` rescue tower). Revisit then.
2. **Embedded-schema-per-command vs per-context shared form module.**
   The proposal pins per-command embedded schemas (~30 LOC each) for
   alignment with the existing form binding model. If schema bloat
   becomes painful, a shared `<Ctx>.Forms` module is a v2 consolidation —
   not a v1 decision.
3. **AshEvents revisit cadence.** AshEvents v0.7 is hybrid; if a future
   release ships pure-ES primitives (per-aggregate stream, no state
   table, fold-on-load), a fourth option opens for `foundation: ash`
   users. Not a v1 dependency; track upstream releases yearly.
4. **`directoryLayout: byFeature` interaction.** Per D-REALIZATION-AXES,
   `directoryLayout:` is its own axis. Vanilla must emit cleanly under
   both `byLayer` and `byFeature`. Verify when P2 starts.

## Hard parts (honest list)

- **LiveView forms.** The `AshPhoenix.Form` replacement is the
  highest-LOC seam. Embedded schemas cover the basic case but nested
  forms and multi-step validation deserve a careful design pass before
  P3 starts.
- **No local `mix` toolchain.** Phoenix vanilla, like Phoenix today, is
  iterated blind against `phoenix-vanilla-build.yml`. Keep PRs small;
  expect 2–3x the friction of TS/.NET work for the same LOC.
- **Strict parity at P2.** Every conformance dimension (ops set,
  response cardinality, schema set, per-schema fields, required flags,
  path-param types, request/response body refs, operationIds) must
  match — including subtle envelope shapes the Ash emit gets via
  `Ash.Error.Invalid` formatting. The new vanilla `error_response/2`
  must produce byte-identical ProblemDetails bodies.
- **Authorization parity for guarded operations.** The Ash policy story
  forwards actor + context automatically. Vanilla's
  `can_<op>?(user, agg)` story is simpler but must agree on the actor
  threading convention. Document once; reuse across operations.
- **Telemetry hook surface.** Ash emits its own telemetry events; vanilla
  must emit the equivalent envelope so the catalog (#480) doesn't lose
  events when foundation flips. `telemetry-emit.ts` is already shared;
  the per-action emission sites change.

## Cross-references

- [`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md) —
  prior art for the Ecto domain emit work. Its §3 (Ecto domain layer
  shape), §5 (conformance parity), and §6 (phasing) translate
  directly; its §4 (modelling decision) is **superseded** by
  D-REALIZATION-AXES + this proposal — the Ash/Ecto axis is now
  `foundation:` (decided), not a sibling platform name or an
  adapter-style flag (the options that doc weighed). Treat §3 / §5 / §6
  as live, §4 as historical.
- [`exception-less.md`](./exception-less.md) — the alignment benefit
  half. The proposal's A4 deletes try/catch towers; vanilla Phoenix
  joins TS/.NET on that path. Ash Phoenix needs a translator either way.
- [`workflow-and-applier.md`](./workflow-and-applier.md) — the pure-ES
  half. Option 3 in its event-sourcing landscape is what
  `foundation: vanilla` realises on Phoenix. P4 here is the
  `EVENT_SOURCING_BACKENDS` un-gate that doc references.
- [`storage-and-platform-config.md`](./storage-and-platform-config.md) —
  the `persistence:` / `style:` / `layout:` / `foundation:`
  per-deployable surface. `foundation: vanilla` becomes a real
  member of the menu under D-REALIZATION-AXES.
- `docs/decisions.md` — **D-REALIZATION-AXES** pins the axis;
  **D-PHOENIX-SURFACE** pins one `phoenix` platform; this proposal adds
  D-VANILLA-PHOENIX-FOUNDATION / D-VANILLA-ES-HOME /
  D-NO-MIXED-FOUNDATION / D-VANILLA-DEFAULT.

## Appendix — what specifically does *not* change

- The grammar (`platform: phoenix` is unchanged; `foundation: vanilla` is
  already-parsed today and rejected only by the validator menu).
- `MigrationsIR` (consumes both state and `<agg>_events` shapes already).
- The `ui` DSL, `walker-stdlib`, the HEEx walker, the design packs.
- The React frontend consuming a Phoenix backend (API-only path is
  already resolved by D-API-ONLY; vanilla inherits).
- `foundation: ash` users on first ship — vanilla is opt-in only initially
  (per D-VANILLA-DEFAULT). Existing bare `platform: phoenix` deployables
  continue to emit Ash until the warn-then-flip sequence completes; the
  one-line escape hatch (`foundation: ash`) remains first-class
  indefinitely.
- The Phoenix obs-e2e contract (telemetry envelope is foundation-agnostic
  once the emission sites are matched).
