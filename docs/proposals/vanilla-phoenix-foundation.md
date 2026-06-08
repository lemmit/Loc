# Vanilla Phoenix foundation — `foundation: vanilla` for `platform: phoenix`

> Status: **proposal**. Nothing here is implemented; the menu slot exists
> (`platform-rules.ts:184` lists `vanilla` as a future Phoenix
> `foundation:` value) but `lower-platform.ts:46` defaults to `ash` and
> there is no second emitter today. Builds on **D-REALIZATION-AXES**
> (which already names this axis), supersedes the framing —
> not the substance — of [`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md)
> §4, and unblocks one half of
> [`workflow-and-applier.md`](./workflow-and-applier.md)'s deferred-ES gap.

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

## Decisions to pin

| ID | Decision |
|---|---|
| D-VANILLA-PHOENIX-FOUNDATION | `foundation: vanilla` is added to the `phoenix` foundation menu. `foundation: ash` remains the Phoenix default. Both are first-class; neither is deprecated. |
| D-VANILLA-ES-HOME | Pure event sourcing on Phoenix lands **only** under `foundation: vanilla`. `foundation: ash` + `persistedAs(eventLog)` stays a hard error, with the structured diagnostic from P0 below. AshEvents / AshCommanded paths are explicitly **not pursued**. |
| D-NO-MIXED-FOUNDATION | A single deployable carries one `foundation` value; per-aggregate foundation override is not added. Users who need both Ash-resource and pure-ES aggregates split contexts across deployables or pick `vanilla` for the whole deployable. |
| D-VANILLA-DEFAULT | The Phoenix default stays `foundation: ash` for backwards compatibility. *Open question*: should the default flip to `vanilla` once exception-less A4 ships? Recommend revisiting then, not now. |

## Phasing

Estimates are calibrated against **observed main-branch velocity** (Phoenix
TPH proposal → ship → docs cycle in ~24 hours; ~25 merged PRs/day across
the project; substantial Phoenix-backend features routinely shipping
same-day) — not a from-zero solo-dev baseline. The earlier
[`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md)
proposal's "~4–6 weeks" for the Ecto domain layer was written before this
velocity was visible; it is the safe upper bound, not the median.

| Phase | Scope | Approx. | Dependency |
|---|---|---|---|
| **P0** | Structured validator diagnostic on `persistedAs(eventLog)` + `foundation: ash` (today's bare reject → an Ash-foundation explanation pointing at vanilla / other backends). Banks DX improvement before any vanilla emitter exists. | <1 day | — |
| **P1** | Foundation axis plumbing: lift `platform-rules.ts:184` menu to `["ash", "vanilla"]`; `lower-platform.ts:46` keeps `ash` default; orchestrator (`phoenix-live-view/index.ts`) gains a foundation branch (no-op stub for `vanilla`). Grammar + scope + parsing test + negative validator test. | 1–2 days | — |
| **P2** | Vanilla state-based emit: `schema-emit`, `changeset-emit`, `policy-emit`, `context-emit`, `repository-emit`, `vanilla/api-emit`, `vanilla/problem-details-emit`, `ecto-postgres-persistence` adapter. Conformance parity gate must pass at strict mode (`LOOM_E2E_STRICT_PARITY=1`, all 9 dimensions). | 1–2 wk | P1 |
| **P3** | Vanilla LiveView: per-command embedded `Ecto.Schema` + `to_form(changeset)` replacement for `AshPhoenix.Form`. Walker reuse — no `heex-walker` changes. | 3–7 days (high tail-risk — see below) | P2 |
| **P4** | Vanilla event sourcing: `<Agg>.Events`, `<Agg>.Fold`, `<Agg>.Repository` ES variant. Migrations gain `<agg>_events` for Ecto. Un-gate `validateEventSourcedStorage` *only* for `foundation: vanilla`. | 3–5 days | P2 + workflow-and-applier A2.1-shaped ES infra |
| **P5** | CI: `phoenix-vanilla-build.yml` (mirrors `phoenix-build.yml` — `mix compile --warnings-as-errors`); obs-e2e variant; strict-parity matrix entry. Examples: one `.ddd` under `examples/` exercising `foundation: vanilla` end-to-end. | 2–3 days | P2 |

P0 is detachable and ships immediately. P1–P5 are sequential. Strict
conformance parity (per §5 of
[`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md))
is the gate that makes P2 the largest phase — every wire-spec dimension
must match Ash's emission byte-for-byte.

**Median:** ~3–4 weeks focused, P0 immediate. **Upper bound:** ~6–8 weeks
if the tail risks below hit. Two specifically that can't be compressed
regardless of velocity:

1. **`AshPhoenix.Form` replacement complexity.** Embedded-schema-per-command
   is clean for flat forms; nested forms and association forms (the
   `inputs_for` / `cast_assoc` shape) are where it can blow up. Worst
   case adds ~1–2 weeks to P3.
2. **No local `mix` toolchain.** Every subtle Phoenix-emit change costs a
   CI round-trip — documented at 2–3x slower per LOC than TS/.NET work
   in `experience_gathered.md`. Multiplies P2/P3 tail risk.

The upper-bound estimate from `elixir-ecto-and-api-only-backends.md`
(~4–6 weeks for the Ecto layer alone) is what materialises if both tails
hit. The median estimate assumes neither does, which matches the velocity
visible on main today.

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
- `foundation: ash` users (zero migration burden — the proposal is
  strictly additive).
- The Phoenix obs-e2e contract (telemetry envelope is foundation-agnostic
  once the emission sites are matched).
