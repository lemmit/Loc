# Event sourcing on the Elixir foundation (T2.b / D-VANILLA-ES-HOME)

> **Status:** LANDED / superseded (de-Ash effort, 2026). The slices below shipped
> (P4.0–P4.2 done), and the **Ash foundation has since been removed entirely**:
> `platform: elixir` now generates Phoenix LiveView on **plain Ecto/Phoenix**,
> `foundation: vanilla` is the default and only valid value, and `foundation: ash`
> is a validation error. The foundation-aware ES gate this plan introduced (accept
> `elixir+vanilla`, reject `elixir+ash`) collapses accordingly: there is no Ash
> elixir host to reject, so ES on elixir is simply ES on the only elixir foundation.
> Retained as the implementation record; the ash-vs-vanilla discrimination it
> describes was the pre-removal state.
>
> Code-verified against `origin/main` 2026-06-15. Expands the
> one-paragraph "(Later) P4" stub in
> [`vanilla-foundation-tdd-plan.md`](./vanilla-foundation-tdd-plan.md) into the
> concrete, ordered, CI-gated slices T2.b needed. Owning proposals:
> [`vanilla-phoenix-foundation`](../proposals/vanilla-phoenix-foundation.md)
> (D-VANILLA-ES-HOME) and [`workflow-and-applier`](../proposals/workflow-and-applier.md)
> (appliers A2). The global plan's near-term #2.

## Why this is bigger than the global plan implies

`global-implementation-plan.md` lists T2.b as "the blocker (no state-based
vanilla emitter) is gone; this is the headline elixir item." That is true but
incomplete. A code audit on 2026-06-15 surfaces three facts that shape the work:

1. **There is no existing Elixir ES reference to mirror.** Ash cannot host pure
   ES (the whole reason ES is gated on elixir — see `system-checks.ts:1020-1026`),
   so unlike every prior elixir feature this is *from scratch*, not a port of the
   Ash path. The cross-backend contract to mirror is the **Python** one
   (`src/generator/python/` — `repository-eventsourced-builder.ts`,
   `emit/aggregate.ts`, `emit/schema.ts`), which is the cleanest functional-leaning
   reference.

2. **The vanilla foundation does not yet emit per-operation HTTP endpoints.**
   `src/generator/elixir/vanilla/api-emit.ts` emits only
   `index/show/create/update/delete`. The Ash path emits
   `POST /<plural>/:id/<op>` per public operation (`elixir/api-emit.ts:312-322,
   810-816`), as do node/dotnet/python/java. An event-sourced aggregate's whole
   point is its operations (`deposit`/`withdraw` → distinct events); they **must**
   surface as endpoints or cross-backend OpenAPI parity fails. So a prerequisite
   slice (P4.0 below) closes the vanilla per-operation-endpoint gap *first* — it
   is independently useful for state aggregates too.

3. **Elixir compiles only in CI** (`elixir-vanilla-build.yml`,
   `mix compile --warnings-as-errors`); there is no local toolchain. The inner
   loop is vitest structure tests + the fast wire-parity test; CI is the
   acceptance gate. Per the parent plan's discipline: keep slices tiny, **push
   each slice so CI compiles it, do not batch.**

## The parity oracle for ES

The state-based vanilla plan used "vanilla wire-spec == ash wire-spec for the same
`.ddd`" as its oracle. **That oracle does not exist for ES** — an ES `.ddd` cannot
generate on `foundation: ash` (it's gated). The decisive gate is therefore
**cross-backend conformance parity** (`conformance-parity.yml`): the vanilla ES
OpenAPI/wire-spec must equal the node/dotnet/python/java ES output for the same
`.ddd`. Add `eventlog.ddd` (or a sibling) to a vanilla conformance case so the
gate has the vanilla column to diff. This matches the global plan's T2.b
verification note ("the conformance parity gate is the decisive check").

## The IR contract (already present — do not rebuild)

- `agg.persistedAs === "eventLog"` — the truth-kind axis (`loom-ir.ts:499`).
- `agg.appliers: ApplyIR[]` — one per `apply(e: Event) { … }`; pure folds
  (assignments/lets only), enforced by `validateEventSourcedDiscipline`
  (`structural-checks.ts`). `ApplyIR = { event, param, statements }`
  (`loom-ir.ts:336-356`).
- `agg.creates` / the single `agg.creates[0]` is the ES create (emit-only body);
  `agg.operations` are emit-only command bodies. The Python/Java backends key off
  `agg.creates?.[0]` for the ES constructor (`java/index.ts:622`,
  `hono/v4/routes-builder.ts:210`).
- **Migrations already emit `<agg>_events`** — `migrations-builder.ts:359-381`
  (`eventLogTableForAggregate`: `stream_id`/`version`/`type`/`data`/`occurred_at`,
  composite PK). Foundation-agnostic; reused as-is. **No migrations work needed.**

## Gate change (foundation-aware)

`validateEventSourcedStorage` (`system-checks.ts:1027-1078`) keys on a
`Set<string>` of platform names per context (`backendPlatformsHostingEachContext`,
`system-checks.ts:950`). That set loses the foundation, so it cannot today tell
`elixir+ash` (still unsupported) from `elixir+vanilla` (the new supported case).

Design:
- Add a sibling helper `elixirFoundationsHostingEachContext(loom):
  Map<string, Set<"ash"|"vanilla">>` (walk `sys.deployables`, for
  `platform === "elixir"` add `d.foundation ?? "ash"`). Keep it next to
  `backendPlatformsHostingEachContext`.
- Thread its per-context result into `validateEventSourcedStorage` (extra arg),
  wired in `validate.ts:155`.
- Logic: `EVENT_SOURCING_BACKENDS` stays `{node, dotnet, python, java}`. elixir
  becomes **conditionally** capable: an `eventLog` aggregate fails only if a
  hosting elixir deployable uses `foundation: ash` (or any non-vanilla). If the
  only elixir host is `vanilla`, ES is allowed.
- **Negative test moves, it does not disappear** (global-plan verification rule):
  assert `elixir+ash` still fails `loom.event-sourcing-backend-unsupported`, and
  `elixir+vanilla` now passes. Keep the rich Ash-foundation diagnostic for the
  ash case.

## Emit (new `vanilla/eventsourced-emit.ts`, dispatched from `vanilla/index.ts`)

For each `agg.persistedAs === "eventLog"`, the vanilla orchestrator must **skip**
the state-path emitters (`changeset-emit`, the state `repository-emit`, the state
context CRUD defdelegates) and route to the ES emitters instead. The `<Agg>`
struct schema (`schema-emit.ts`) stays — it defines the in-memory state struct;
it simply gets no migration table (already handled). Pieces, mirroring Python:

1. **Event-store Ecto schema** — `lib/<app>/<ctx>/<agg>_event_log.ex`. A read-only
   `Ecto.Schema` over `"<agg>_events"`:
   `@primary_key false`, fields `stream_id :binary_id`, `version :integer`,
   `type :string`, `data :map` (JSONB), `occurred_at :utc_datetime_usec`. Used by
   the repository's `from`/`Repo.all`/`Repo.insert_all`.

2. **Fold module** — `lib/<app>/<ctx>/<agg>_fold.ex`:
   - `apply_event(state, %Events.<E>{} = ev)` clause per applier, body rendered
     from `ApplyIR.statements`. **render-stmt.ts cannot be reused** — its `assign`
     arm emits `Ash.Changeset.change_attribute` and its `emit` arm broadcasts via
     PubSub. Write a small `renderFoldStmt`: `assign` → `%{state | field: <rhs>}`
     (threaded), `let` → `name = <rhs>`, `expression` passthrough. The RHS reuses
     `renderExpr` with `RenderCtx { thisName: "state", foundation: "vanilla",
     contextModule }` so bare `balance` → `state.balance` and `e.owner` →
     `e.owner` (param). Enum RHS already renders as strings under
     `foundation: "vanilla"` (`render-expr.ts:212`).
   - `from_events(id, events)` — seed an empty `%<Agg>{id: id}` (or field-zero
     shell matching Python's `shellSeed`), `Enum.reduce(events, seed,
     &apply_event(&2, &1))`.

3. **Command runners** (where the emit-only bodies execute). A new `renderCmdStmt`:
   `precondition` → `if not (<cond>), do: throw({:error, :precondition, "…"})`
   (or accumulate into a `with`-friendly result); `emit X{…}` → build
   `%Events.X{…}` and append to an events accumulator (NOT broadcast — the
   repository appends + the dispatcher fans out). Each create/operation lowers to
   a function returning `{:ok, [event]} | {:error, reason}`.

4. **Event-store repository** — `lib/<app>/<ctx>/<agg>_repository.ex` (ES variant):
   - `find_by_id(id)` → load `<agg>_events` where `stream_id == ^id` order by
     `version`, map rows→event structs, `Fold.from_events(id, events)`; `[]` →
     `{:error, :not_found}`.
   - `list()` → load all, group by `stream_id`, fold each.
   - `append(id, events)` → `SELECT max(version)`, insert gap-free rows
     (`stream_id`/`version`/`type: ev.__struct__ |> type_name`/`data: encode(ev)`/
     `occurred_at: DateTime.utc_now()`), dispatch each via the existing
     `Dispatch` seam (`dispatch-emit.ts`), inside `Repo.transaction`.
   - `_row_to_event` / `_event_to_data` — the JSONB round-trip, one clause per
     `ctx.events` referenced by the aggregate (mirror Python's
     `repository-eventsourced-builder.ts:186-248`).
   - `find` declarations on an ES repo → load-all + in-memory filter (Python
     `repository-eventsourced-builder.ts:149-164`; no queryable state columns).

5. **Context facade** (ES variant of `context-emit.ts`):
   `create_<agg>(attrs)` → run the create runner → `Fold.from_events` → `append`
   → `{:ok, struct}`; `get_<agg>`/`list_<agg>s` delegate to the repo;
   `<op>_<agg>(record, params)` → load (or take record) → run op runner → fold →
   append → `{:ok, struct}`.

6. **Controllers + routes** (depends on P4.0): per-operation
   `POST /<plural>/:id/<op>` actions calling `<op>_<agg>`; `create`/`show`/`index`
   as today. Precondition failures → 422 ProblemDetails (parity with the other
   backends' `or`-union / RFC-7807 mapping — coordinate with T2.c if landing
   `or`-union returns concurrently).

## Slices (each: tests red → emit green → push → CI `mix compile`)

- **P4.0 — per-operation endpoints on vanilla (prerequisite, state-path too).**
  ✅ SHIPPED (#1203). `POST /<plural>/:id/<op>` + the `<op>_<agg>` controller
  action for every public operation. Closed the standing vanilla↔cross-backend gap.
- **P4.1 — gate + read path.** ✅ DONE (this PR). Foundation-aware gate
  (`elixirFoundationsHostingEachContext` + `validateEventSourcedStorage`:
  `elixir+vanilla` accepted, `elixir+ash` still rejected); `<agg>_event_log.ex`,
  `<agg>_fold.ex` (`apply_event/2` + `from_events/2`), event-store repository
  `find_by_id`/`list` + `row_to_event`, context `get`/`list`.
- **P4.2 — write path.** ✅ DONE (this PR). Command runners (create + operations)
  emit→append→fold via the `with`/`ensure` chain; gap-free `append/2` in a
  `Repo.transaction`; ES controller (create + per-op via P4.0, atom-error → 422/403).
  Landed together with P4.1 because the gate can only lift once the whole path
  compiles. **Remaining for this slice:** add the vanilla ES column to a
  cross-backend conformance-parity case (the decisive runtime gate).
- **P4.3 — finds + VO/enum/relationship folds + ProblemDetails parity.** In-memory
  finds SHIPPED (load-all + filter); still owed: applier folds over VO/enum/
  containment fields, multi-word camelCase wire keys, dispatch/PubSub fan-out on
  append, 422 envelope byte-parity with the other backends.
- **P4.4 — CI + example.** Add an ES case to `elixir-vanilla-build.yml` and to the
  conformance matrix; one `examples/*-vanilla` ES `.ddd`.

## Risks

1. **Fold/command rendering is new** (render-stmt is Ash/PubSub-shaped). Keep
   `renderFoldStmt`/`renderCmdStmt` tiny and structure-tested; they only see the
   restricted statement set the ES discipline validator already guarantees
   (assign/let/expression in folds; precondition/emit in commands).
2. **CI-only compile** — push every slice; `warnings-as-errors` is unforgiving
   (e.g. `== nil` → must be `is_nil/1`, already handled in `render-expr.ts:456`).
3. **Parity oracle is cross-backend, not same-foundation** — the vanilla ES
   column must be added to a conformance case or the gate can't diff it.
4. **`occurred_at` precision / Jason encoding** must match the other backends'
   wire shape for events that surface (most don't surface directly, but the
   create/op response struct does — parity will catch drift).

## Definition of done

`foundation: vanilla` on an `eventLog` `.ddd`: gate lifted only for vanilla
(ash still fails fast); full ES tree emits; `mix compile --warnings-as-errors`
green in CI; cross-backend conformance parity with node/dotnet/python/java; one
example in the matrix. Un-gates `validateEventSourcedStorage` for
`foundation: vanilla` per D-VANILLA-ES-HOME — update the global plan (delete
T2.b), the proposal status headers, and `platform-parity-debt.md` in the same PR
(maintenance rule).
