# Workflow-centric DDD — appliers, workflows, and the workflow-as-aggregate model

> Status: partially implemented. **Phase A1 (aggregate appliers — surface + IR + discipline) has landed**: `apply(e: Event) { … }` is a real aggregate member (grammar → `ApplyIR` on `AggregateIR.appliers`), and the event-sourcing body contract below is enforced for `persistedAs(eventLog)` aggregates — command bodies are emit-only, every emitted event needs a matching applier, applier bodies are pure folds, and one applier per event type. The contract is checked in **two places**: `validateEventSourcedDiscipline` (IR phase ⑦, at `generate`/`parse` time and in the playground) and a `language/` AST-level mirror in `structural.ts` (live in the editor via the LSP, attached to the precise offending node).

**Phase A2.1 (Hono event-store emission — fold-from-zero MVP) has landed** for the Hono/Drizzle backend: a `persistedAs(eventLog)` aggregate persists to an append-only `<agg>_events` stream table (`stream_id, version, type, data, occurred_at`, PK `(stream_id, version)`) instead of a state table; appliers render as a `_apply(ev)` fold dispatch plus a `_fromEvents(id, events)` rehydrator; a command `emit` records **and** folds the event (`_apply`) so in-memory state is consistent for the response; the repository folds the stream on load (`findById`/`findAll`) and appends pending events with gap-free versions on `save`. Emission is gated to Hono by a capability validator (`validateEventSourcedStorage`) — an event-sourced aggregate on .NET / Phoenix is a hard error (they don't yet branch on `persistedAs`), not a silent state fallback.

**Phase A2.2a (Hono event-sourced creation) has landed**: an event-sourced aggregate is now constructed from a creation event. The single `create` action's emit-only body runs against a fresh empty shell (`_init`), where each `emit` records-and-folds — so `create(...)` returns an instance that already holds the folded state AND carries the creation event for `repo.save` to append. The auto state-writing factory is suppressed for event-sourced aggregates; the POST route's body is the create action's params (the command shape), not the field set. A validator flags more than one `create` (single canonical creator, v1); zero is allowed (constructed out-of-band, no create route). The whole `examples/event-sourcing.ddd` system now type-checks under the `tsc` build gate.

**Phase A2.2b (.NET / EF Core event sourcing) has landed** (#914): the .NET backend now branches on `persistedAs(eventLog)` and mirrors the Hono path — an `<agg>_events` table on the existing `DbContext` (`src/generator/dotnet/emit/event-store.ts`), C# `_Apply<Event>` applier methods + a `_FromEvents` rehydrator + `_Apply` dispatch switch (`src/generator/dotnet/emit/entity.ts`), all EF-only (**not** a dedicated Marten backend, per D-DOCUMENT-AXIS decisions.md §"No dedicated Marten backend"). The `validateEventSourcedStorage` capability gate is correspondingly relaxed for .NET; **Phoenix/Ash remains a hard error** (still doesn't branch on `persistedAs`). Also landed alongside: a **members-only workflow body** with a `create()` starter (Phase A2-S5f, #889) and resolution of `event`/`payload` names as workflow command parameter types (#932).

**Phase A2.2c (event sourcing on the second-persistence adapters) has landed** (#941): event sourcing now spans **both** persistence backends on each OO runtime — .NET's **Dapper** (raw Npgsql event store: read stream → fold, append on save; `src/generator/dotnet/emit/dapper.ts`) and Node's **MikroORM** (EntityManager event store + `<agg>_events` `EntitySchema`; `src/generator/typescript/emit/mikroorm.ts`). This proved the ES domain/CQRS layer is **persistence-agnostic** — each adapter needed only a repository + schema/entity + routing, reusing the aggregate fold, the record-and-apply `emit`, the create-from-event factory, the shared `MigrationsIR` `<agg>_events` table, and the discipline/storage validators unchanged. Both `dapper-persistence.ts` and `mikroorm-persistence.ts` now advertise `supportedStrategies: ["state", "eventLog"]`; `EVENT_SOURCING_BACKENDS` is `{ node, dotnet }` (it has since grown — see next paragraph).

**Event sourcing now also spans Python, Java, and Elixir.** `EVENT_SOURCING_BACKENDS` grew to `{ node, dotnet, python, java }`, and **Elixir's `foundation: vanilla`** hosts pure ES too (#1205, D-VANILLA-ES-HOME) — built from scratch (Ash cannot host pure ES) mirroring the same contract: a plain in-memory `<Agg>` struct, an `<Agg>EventLog` Ecto schema over the shared `<agg>_events` table, an `<Agg>Fold` (`apply_event/2` + `from_events/2`), an event-store repository (load+fold reads, gap-free append), and emit→append→fold command runners. `validateEventSourcedStorage` is now **foundation-aware** (`src/ir/validate/checks/system-checks.ts`): `elixir+vanilla` is accepted, **`elixir+ash` remains a hard error** (no pure-ES fit). See [`../plans/elixir-eventsourcing-vanilla-plan.md`](../plans/elixir-eventsourcing-vanilla-plan.md) for the slice breakdown and the P4.3/P4.4 tail.

**`eventSourced` *workflows* (A2-S5b) have followed the same arc.** The saga analogue of a `persistedAs(eventLog)` aggregate — a per-correlation `<wf>_events` stream folded through the workflow's `apply(...)` blocks instead of a mutable `<wf>_state` row — now ships on **node, dotnet, python, java, and elixir-vanilla**. `EVENT_SOURCING_WORKFLOW_BACKENDS` is `{ node, dotnet, python, java }`, and `validateEventSourcedWorkflowStorage` (`src/ir/validate/checks/system-checks.ts`) carries the same foundation-aware elixir branch: an `eventSourced` workflow on **`elixir+vanilla`** is accepted, **`elixir+ash` remains a hard error**. On elixir-vanilla (`src/generator/elixir/vanilla/workflow-eventsourced-emit.ts`, `emitVanillaEsWorkflowFiles`) this is a plain `<Wf>State` fold struct (no Ecto saga schema), a `<Wf>Fold` (`apply_event/2` + `from_events/2`), a `<Wf>Stream` (load + gap-free append + Jason codec) over the `<wf>_events` `<Wf>EventLog` Ecto schema, and create/`on` handlers that fold-on-load, run the emit-only body, append the workflow's own events gap-free, and re-dispatch each emit for choreography. The remaining unsupported host is **elixir-ash** (no pure-ES fit).

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The deferred-ES-under-Ash discussion below — including the AshEvents/AshCommanded/custom-`Ash.DataLayer` design landscape and the "un-gate when a backend exists" note — is now moot: pure event sourcing on elixir already ships under the (now sole) vanilla foundation, as the two paragraphs above describe. The text below is preserved as the design record that motivated that outcome.

**Event sourcing on Phoenix under `foundation: ash` — deferred (not implemented; design landscape below).** This is an **Ash-foundation limitation, not a Phoenix-platform limitation.** Phoenix itself (Plug + Endpoint + Router + LiveView) is agnostic to the domain layer — the cross-backend pure-ES contract (no state table, per-aggregate stream as sole source of truth, fold-on-load) runs on Phoenix unchanged. What does not yet fit is **`Ash.Resource`'s changeset-shaped action model + `Ash.DataLayer`'s queryable-store callback contract**: Loom's emit/apply discipline can be projected onto Ash only via a custom data layer that effectively re-implements AshCommanded, or via half-bridges that leak (Ash relationships, GraphQL/JSON-API extensions, and `AshPhoenix.Form` all assume the data layer answers queries about current state). The escape hatch is therefore the *foundation* axis, not the *platform*: under `foundation: vanilla` (see [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md)), plain Ecto + a fold module realises the pure-ES contract identically to the other backends — no upstream wait required.

What the ecosystem now offers (as of mid-2026):

- **[AshEvents](https://hexdocs.pm/ash_events)** (v0.7, March 2026) — a first-class Ash extension for event capture + replay. Two DSL pieces: `AshEvents.Events` on a business resource (intercepts and logs its create/update/destroy actions) and `AshEvents.EventLog` on a centralized event-store resource (configures replay). Events carry `resource, record_id, action, action_type, data, changed_attributes, metadata, version, occurred_at`, with actor attribution, schema-evolution **versioning**, and version-specific **replay routing** (`replay_override … route_to …`). **Caveat — it is explicitly *not pure* event sourcing:** the business resource *keeps its normal state table*; the event log is added *alongside* as an audit + replay trail, events live in **one centralized table** (not a per-aggregate `<agg>_events` stream), AshEvents **wraps the normal changeset actions**, and replay is a **manual whole-resource rebuild** (clear all records → replay chronologically). That shape is a *partial* fit for Loom's `persistedAs(eventLog)` contract, which is *pure* (no state table, per-aggregate stream is the sole source of truth, state folded on every load, command bodies emit-only with `apply` folds).
- **[AshCommanded](https://hexdocs.pm/ash_commanded)** — Ash + [Commanded](https://github.com/commanded/commanded), a full CQRS/ES framework (aggregates, command handlers, projections, EventStore/Postgres-backed streams). This is the **closest match to Loom's emit/apply command-and-fold discipline** and to a pure per-aggregate stream, at the cost of a heavier dependency set and a larger build.

Design options, re-weighted given the above (for whoever picks this up):

1. **AshCommanded (recommended for fidelity).** Map Loom's eventLog aggregate onto a Commanded aggregate: the create/operation command bodies → Commanded command handlers that return events; the `apply(e: …)` appliers → Commanded `apply/2` clauses; the per-aggregate stream is native. Highest fidelity to the cross-backend pure-ES contract; heaviest dependency footprint.
2. **AshEvents (recommended for ecosystem-idiomaticity, with caveats).** Use AshEvents for the event log + replay, but reconcile the hybrid model — either accept a state-table-backed read side (a *projection*, divergent from the other backends' fold-on-load) or use the event log purely as the store and fold from it (fighting the centralized-table + action-wrapping grain). Lower dependency cost; semantic divergence to manage.
3. **Plain Elixir fold module + Ecto events table + thin repository (fallback).** Sidestep Ash's data layer for eventLog aggregates: a plain `<Agg>Fold` module (`from_events/2` + per-event `apply/2`), an Ecto-managed `<agg>_events` table (matching the shared `MigrationsIR` shape), a hand-rolled read/append repository. Matches the other backends exactly and adds no dependency, but reimplements what AshCommanded gives for free and the read/query surface is custom (not an `Ash.Resource`).

Remaining blockers regardless of option:

- **The hybrid-vs-pure reconciliation** above (only the fold module and AshCommanded are truly pure; AshEvents needs a decision).
- **No local Elixir toolchain to validate.** Unlike .NET (an in-container SDK was installed to build `/warnaserror` before pushing), there is no local `mix`; Phoenix ES would be iterated blind against the `phoenix-build.yml` CI gate.

The validator un-gate is a one-liner once a backend exists: add `"phoenix"` to `EVENT_SOURCING_BACKENDS` in `src/ir/validate/checks/system-checks.ts` (today the `validateEventSourcedStorage` gate makes an event-sourced aggregate on Phoenix a hard error; `ash-postgres-persistence.ts` still advertises `["state"]` only). `test/ir/eventsourced-storage-support.test.ts` pins the current Phoenix-rejects behaviour. Note the gate is sensitive to *foundation*, not just platform — when `foundation: vanilla` lands, the gate stays in place for `foundation: ash` deployables and lifts only for `foundation: vanilla` ones; the diagnostic should name "the Ash foundation," not "Phoenix," as the constraint, and point the user at either a different foundation or a non-Phoenix backend.

**Still deferred** (beyond Phoenix ES above): snapshots, projections / read models (now specified in [`projection.md`](./projection.md) — a `projection` context member that reuses this proposal's saga-state + `apply()` fold machinery for the read side, folding **foreign** events rather than its own), and the workflow-as-aggregate / `on(...)` handler surface. Reframes today's `workflow Name(params) [transactional]` (see [`docs/workflow.md`](../workflow.md)). Companion to the events surface declared today (`event Name { ... }`) and complementary to the schemas-as-boundary commitment that the wire-spec artifact already approximates but currently sources from the wrong layer. Sagas (compensation contract) deferred to a v2 amendment.

## Problem statement

Today's `workflow Name(params) [transactional]` is the conflation of three different things:

1. A **single-transaction command handler** — `workflow X(params) transactional` is the "lucky case" the paper identifies.
2. A **multi-transaction command-triggered process** — without `transactional`, today's workflow saves multiple aggregates in declaration order with no state aggregate to remember position. The current doc admits *"Mid-workflow failure leaves earlier saves committed."* The paper's unnamed-position-blob antipattern, encoded in the language.
3. A **placeholder for event-triggered processes** — `docs/workflow.md:178` explicitly defers: *"wait for the event-triggered workflow slice."*

Beyond the workflow conflation, two further gaps:

- **Event-sourced aggregates have no surface.** The current model is operations-mutate-then-emit; there is no `(state, event) → state` applier form.
- **Commands are not first-class.** A workflow's `(params)` list synthesises the command's payload implicitly; there is no `command` declaration, no published command schema. `wire-spec.json` is published from aggregate `wireShape` — the wrong layer for a bounded-context boundary.

This proposal addresses all three gaps in one coordinated revision.

## What the source argument says

Follows the workflow-centric DDD framework (in-tree `2948ae13-workflowcentricddd.md`). Load-bearing claims:

1. The aggregate is the transaction boundary.
2. The applier/workflow split runs along the aggregate boundary.
3. Workflow state is an aggregate — identity, invariants, lifecycle, its own table.
4. Five message-handler forms collapse the old taxonomy along three orthogonal axes.
5. Schemas of commands + events are the boundary.

This proposal lands all five as Loom language features, with form 5 (saga) deferred.

## Prior art surveyed

Two hard problems: correlation (which instance does this message belong to?) and lifecycle (which messages create vs. continue?).

| System | Correlation | Lifecycle | What Loom takes |
|---|---|---|---|
| NServiceBus | Per-message `ConfigureHowToFindSaga` | `IAmStartedByMessages<T>` marker | Per-event correlation expression |
| MassTransit | Per-event `CorrelateById(...)` lambdas | `Initially.When(...)` | Per-handler correlation + starter-as-header |
| Axon | `@SagaEventHandler(associationProperty=…)` | `@StartSaga` annotation | Name-match default + explicit alias |
| Camunda BPMN | Business key + per-receive correlation | Message-start event | Single correlation key per workflow |
| Temporal | Caller resolves workflow ID | Workflow function = lifecycle | Not applicable (execution infrastructure) |
| Akka Cluster Sharding | `extractEntityId(message)` | First-message lazy create | Routing-by-id model |
| EventFlow | `ISubscribeAsynchronousTo<...>` + saga locator | Configurable starter | Per-event subscription declaration |
| Ash Framework | Resource changesets bound to id | `:create` / `:update` / `:destroy` kinds | The kind-tag pattern (already in [`lifecycle-operations.md`](./lifecycle-operations.md)) |

Three industry patterns crystallise:

1. **Per-handler correlation expression** is the dominant pattern.
2. **Starter-vs-continuation distinction is structural** in every framework.
3. **State is an aggregate** under every name (saga data, process variables, actor state).

What Loom takes: per-handler `by <expr>` with implicit name-match; starter-as-typed-action-on-the-entity; state-as-aggregate.
What Loom rejects: marker interfaces, generic saga stores, caller-supplied IDs.

### Prior art — the workflow-creation moment specifically

Beyond the broad correlation/lifecycle survey above, the more specific question — **how is the creation moment shaped, and how does state get populated?** — has more variation. Eight frameworks surveyed:

| Framework | Creation marker | Init mechanism | Multiple starters? |
|---|---|---|---|
| NServiceBus | `IAmStartedByMessages<T>` marker on handler class | Handler body mutates saga data (POCO with default-init properties) | Yes — multiple markers per saga |
| MassTransit | `Initially.When(E).Then(...)` in fluent state machine | Lambda after `.Then(...)` mutates instance | Yes — multiple `Initially.When(...)` clauses |
| Axon | `@StartSaga` annotation on `@SagaEventHandler` method | Method body mutates `@SagaEventHandler(associationProperty=…)`-correlated saga instance | Yes — multiple annotated methods |
| Camunda BPMN | Message Start Event in process XML | Declarative variable assignments + optional Execution Listeners (Java/Groovy) | Yes — multiple start events |
| Temporal | Workflow function arguments — caller invokes | First statements of the function body | No — one workflow function per type |
| EventFlow | `ISagaIsStartedBy<TEvent>` marker interface | Handler body mutates saga state | Yes |
| **Ash Framework** | **`create :name do ... end` action with `accept [list]` + `change` chain** | **Imperative `change` modules OR declarative `change set_attribute(...)`** | **Yes — multiple named creates** |
| Akka Persistence | First event in the stream materialises the persistent actor | `applyEvent(event)` reconstructs state from log | Implicit — any inbound message can be first |

Three patterns recur, with one constant across all of them:

1. **Marker + body** (NServiceBus, MassTransit, Axon, EventFlow). Some declaration tags a handler as a starter; the body mutates default-initialised state.
2. **Typed action with declared shape** (Ash, BPMN). The action's shape is declared (`accept` list, BPMN variables); a declarative or imperative chain populates fields.
3. **Function arguments** (Temporal). Initialization is just the first statements of the workflow function; framework supplies the args.

Common across all: **multiple starters are first-class.** Every state-based saga framework allows multiple entry points to one workflow type. Ash's `create :name` is the most explicit — each named create is a distinct entry point with its own accept list and change chain.

**Ash is the closest match.** Loom's aggregate-lifecycle proposal ([`lifecycle-operations.md`](./lifecycle-operations.md)) is already Ash-shaped — `create [name](params) { this.field := ... }` is a near-1:1 translation of Ash's `create :name do accept [...]; change ... end`. Lifting the same shape to workflows produces a unified mental model: an aggregate and a workflow are both stateful entities with typed lifecycle actions, differing only in which member forms are allowed.

What Loom v2 takes from Ash:
- **Typed-action `create` keyword.** Same as aggregate.
- **Multiple named creates as entry points.** Same as aggregate.
- **`by <expr>` per declaration** for correlation (Loom's spelling of association mapping; NServiceBus/Axon do the same with config objects/annotations).
- **Name-match auto-seeding** for the common case (Camunda BPMN parity; NServiceBus has this implicitly via reflection).

What Loom v2 rejects:
- **Fluent state-machine builders** (MassTransit). Doesn't fit Loom's declarative style.
- **Marker interfaces / annotations** (NServiceBus, Axon, EventFlow). Loom uses a keyword over a marker.
- **Default-initialised POCO state** (NServiceBus). Loom requires explicit assignment in the `create` body.

What composes later:
- **Explicit `accept` list** (Ash). `create(event: OrderPlaced) accept [orderId, ...] by event.order { ... }`. Composes with name-match auto-seeding (whitelist overrides match); deferred to v2 of this proposal.
- **Declarative field defaults** (Camunda, Ash's `change set_attribute`). Already proposed for aggregates in `lifecycle-operations.md` (`status: T = default`); workflows inherit when that lands.

## Design — the workflow is an aggregate

**Load-bearing claim:** a workflow is an aggregate whose declared scope of authority includes operations on other aggregates, subscriptions to external events, and a header-declared lifecycle trigger. Every other rule follows.

The three concrete differences between an `aggregate` and a `workflow`:

| Difference | Why |
|---|---|
| Command handlers may call other aggregates / repositories | The whole point of coordination |
| `on(e: E)` event subscription is allowed | Reacting to facts from outside own scope |
| `create` carries a `by <expr>` clause for event-triggered creation | Aggregates are invoked into existence directly (factory call); workflows can be triggered by either a command call or an inbound event correlated by `by` |

These differences are surfaced by *vocabulary*, not by body restrictions:

- Aggregates have `operation` (domain-pure command handler).
- Workflows have `handle` (orchestration-capable command handler) plus `on(...)` (event subscription).
- Both have `apply(...)` when `eventSourced` (own-event replay).

Same syntactic shape (`keyword[name](typed-binding) { body }`); different keyword carries the contract.

### Modifiers

| Modifier | Applies to | Contract |
|---|---|---|
| `eventSourced` | `aggregate`, `workflow` | Command handlers (`operation` / `handle` / `create`) may only `emit`; `on(...)` handlers may only `emit`; all mutation lives in `apply(...)` blocks |
| `transactional` | workflow declaration (single-`create`, no-continuations workflows only) | The starter body fits in one DB transaction. Optional isolation level via `transactional(serializable)` etc. |

`transactional` is per-workflow and only legal when the workflow has exactly one `create` declaration and no continuation handlers (no `handle`, no `on(...)`, no additional `create`) — multi-handler workflows are structurally multi-transaction.

### Member forms

| Form | Allowed in | Role | Body restrictions |
|---|---|---|---|
| `create [name](params) [by <expr>] { ... }` | workflow only | Lifecycle starter — fresh blank instance, body populates state and (optionally) orchestrates other aggregates. May call other aggregates / repos. | May not read `this.id` (assigned by persistence). In `eventSourced`: may only `emit`. |
| `create [name](params) { ... }` | aggregate only | Lifecycle factory (per [`lifecycle-operations.md`](./lifecycle-operations.md)) — fresh blank instance, body populates own fields | May not call other aggregates / repos. May not read `this.id`. In `eventSourced`: may only `emit`. |
| `operation name(params) { ... }` | aggregate only | Domain command handler — `this`-bound mutation, may `emit` | May not call other aggregates / repos. In `eventSourced`: may only `emit`. |
| `handle name(params) { ... }` | workflow only | Continuation command handler — own-state mutation, may call other aggregates / repos | In `eventSourced`: may only `emit`. |
| `on(e: Event) [by <expr>] { ... }` | workflow only | Extrinsic event subscription (continuation) | In `eventSourced`: may only `emit`. |
| `apply(e: Event) { ... }` | `eventSourced` aggregate or workflow | Pure intrinsic state transition from own event | Only `:=` and field-derivation expressions. No `emit`, no calls, no I/O. |
| `destroy [name](params) { ... }` | aggregate only (per `lifecycle-operations.md`) | Lifecycle terminator | (see lifecycle proposal) |

All declarations are typed-parameter-in-parens. Both `create` (workflow) and `handle` accept implicit-command sugar (positional typed params synthesise a `command` declaration named after the workflow + optional create-name, see §"Commands as first-class declarations") or explicit reference (`create(c: Cancel)`, `handle(c: Cancel)`). `create(event: E) by <expr>` is the event-triggered shape; `by` is omitted when the event has a field whose name matches the workflow's correlation field. `operation` keeps today's positional-params shape.

**Symmetry with aggregate lifecycle.** Both `aggregate` and `workflow` are stateful entities with a `create` factory shape. They differ in member surface:

| Member kind | Aggregate | Workflow |
|---|---|---|
| `create [name](...) [by ...] { ... }` | ✓ (no `by`) | ✓ (with `by` for events) |
| `operation name(...) { ... }` | ✓ | — |
| `handle name(...) { ... }` | — | ✓ |
| `on(e: E) by ... { ... }` | — | ✓ |
| `apply(e: E) { ... }` | ✓ (`eventSourced`) | ✓ (`eventSourced`) |
| `destroy [name](...) { ... }` | ✓ | — (workflow termination is an open question — see §"Open questions") |

The workflow header carries no trigger params — trigger shape lives in the `create` declaration that owns the starter body. Multiple `create` declarations per workflow are first-class (Ash parity); the canonical (unnamed) form is at most one per workflow.

### Identity and correlation

Workflows have an implicit `id` field, typed `<WorkflowName> id`, configurable via `ids` clause exactly like aggregates. The workflow's primary key is `id` (its own synthetic identity). Beyond `id`, a workflow declares one regular field whose value is used by the runtime to **route inbound events** to this workflow instance — the *correlation field*.

```ddd
workflow OrderFulfillment {
  // implicit id: OrderFulfillment id  (guid by default; configurable via 'ids' clause)
  orderId: Order id         // correlation field
  status: FulfillmentStatus

  create(event: OrderPlaced) by event.order {
    this.status := AwaitingPayment
  }
}
```

**Routing semantics.** The `by <expr>` clause on a `create` or `on(...)` declaration *is* the routing expression. When an event arrives, the runtime evaluates the `by` expression against the event payload (e.g., `event.order` yields the placed order's id) and uses the resulting value to identify which workflow instance the event belongs to. For `create`, the runtime looks up the workflow whose correlation field holds that value; if none exists, it allocates a new row and seeds the correlation field from the `by` value. For `on(...)`, the runtime looks up the existing workflow whose correlation field equals the `by` value.

How the backend implements this lookup (database index, in-memory map, sharded distribution) is per-backend and outside the DSL's scope.

**Correlation field identification.** Across a single workflow's declarations, the correlation field is the workflow's regular field of the same type as the values produced by every `by` clause. Concretely:

- For `create(event: E) by event.X` and `on(e: E) by e.X` etc., the `by` expressions yield a value of some id-shaped type (e.g., `Order id`). The workflow must have exactly one regular field of that type — that field is the correlation field.
- For `create(p: T) by p` (command-triggered via name-match), the matching workflow field is identified by name + type.

All `by` clauses across all of a workflow's `create` / `on(...)` declarations must yield a value compatible with the same single correlation field; mismatch is a validator error. If the workflow has multiple regular fields of the same id-shaped type (so the target can't be inferred), v1 rejects the workflow — the modeller must rename or restructure. (A future amendment may introduce an explicit `into <fieldName>` clause on `by` to disambiguate; deferred until observed in practice.)

```ddd
workflow PaymentReconciliation {
  paymentId: Payment id        // the correlation field — only Payment id field in this workflow
  invoiceId: Invoice id        // a regular id field, used by handlers for cross-aggregate lookup
  status: ReconStatus

  create(event: PaymentReceived) by event.paymentId {
    this.invoiceId := event.invoice    // explicit assignment for the non-correlation id field
    this.status := Pending
  }

  on(matched: PaymentMatched) by matched.paymentId {
    this.status := Matched
  }
}
```

### State is optional for `transactional` workflows

| Case | State fields? | Table? |
|---|---|---|
| `transactional` workflow with no state fields | none | **no** — pure handler |
| `transactional` workflow with state fields | declared | yes — one row per invocation (opt-in audit/idempotency) |
| Non-`transactional` workflow (multi-handler, has `on(...)`, has continuation `handle`s) | **required** | yes — validator enforces |

The "stateless single-tx" case is the paper's "lucky case" — the work is in the side effects on other aggregates; no row to track.

### `by` clauses and implicit name-match

Every event-triggered handler declares a correlation expression. The compiler type-checks the expression against the workflow's correlation field type.

```ddd
create(event: OrderPlaced) by event.order { ... }       // starter
on(paid: PaymentReceived) by paid.orderId { ... }       // continuation
on(arr:  ShipmentArrived) by arr.shipRef  { ... }       // continuation
```

When the event has a field whose name matches the workflow's correlation field, `by` may be omitted:

```ddd
on(paid: PaymentReceived) { ... }                    // inferred: by paid.orderId (correlation field is orderId)
on(arr:  ShipmentArrived) by arr.shipRef { ... }     // explicit alias when names differ
```

For starter `create` declarations the `by` clause seeds the correlation field of the new row (lookup must miss). For continuation `on(...)` declarations it locates the existing row (lookup must hit). Command-triggered `create` declarations (no `by` clause; trigger is an implicit or explicit command) seed correlation by name-match from a create-param of matching name.

## Workflow lifecycle — what happens when a workflow is created

When a `create` declaration's trigger arrives, the runtime executes a defined sequence:

1. **Allocate** a fresh row for the workflow with a new `id` (its own synthetic identity).
2. **Seed the correlation field**:
   - Event-triggered `create(event: E) by <expr>`: from the `by` expression (or the implicit name-match against `event`).
   - Command-triggered `create(params)`: from the create-param whose name matches the correlation field.
3. **Auto-seed any other fields** whose name matches a create-param of the same type (commands only; events don't auto-seed beyond the correlation, since the create body has explicit access to the bound event variable).
4. **Run the `create` body** — `this.field := X` mutations and (for non-`eventSourced`) any cross-aggregate calls. `this.id` is not readable in the body (assigned by persistence on commit).
5. **Commit** the row.

For continuations (`handle` invocation, `on` event), the runtime:
1. **Look up** the workflow row by the correlation field (using the `by` clause's value).
2. **Run the handler body** with the existing row's state in scope (`this.field` reads the loaded state).
3. **Commit** the changes (one transaction per handler invocation).

The `create` body runs exactly once per workflow instance — it IS the starter, not a separate block. In `eventSourced` workflows, `create` may only `emit` (no direct `:=`); the appliers consume the emitted events to populate state.

**Multiple `create` declarations** (Ash-style multiple entry points): a workflow may declare more than one `create`. Each is a distinct entry point — the runtime picks the matching one based on the inbound trigger's type (event class for `create(event: E)`, command class for command-triggered). At most one canonical (unnamed) `create` per workflow; named variants are distinguished by their `name`.

## The four forms

### 1. Applier

```ddd
aggregate Shipment eventSourced {
  status: ShipmentStatus
  dispatchedAt: datetime?

  operation dispatch() {
    precondition status == Pending
    emit ShipmentDispatched { at: now() }
  }
  apply(e: ShipmentDispatched) {
    status := Dispatched
    dispatchedAt := e.at
  }
}
```

### 2. Single-transaction command-triggered workflow

Stateless (the lucky case — no fields, no table):

```ddd
workflow PlaceOrder transactional {
  create(customerId: Customer id, placedAt: datetime) {
    let order = Order.create({ customerId: customerId, placedAt: placedAt })
  }
}
```

Or stateful (opt-in audit row). The create-param `customerId` seeds the workflow's correlation field by name-match:

```ddd
workflow PlaceOrder transactional {
  customerId: Customer id     // correlation field; seeded from create-param of same name
  placedAt: datetime                       // seeded from create-param of same name
  outcome: PlaceOrderOutcome

  create(customerId: Customer id, placedAt: datetime) {
    let order = Order.create({ customerId: customerId, placedAt: placedAt })
    this.outcome := Completed
  }
}
```

The synthesised command is named after the workflow (`command PlaceOrder { customerId: Customer id, placedAt: datetime }`).

### 3. Multi-transaction command-triggered workflow

```ddd
workflow OrderFulfillment {
  orderId: Order id           // correlation field (sole Order id field)
  status: FulfillmentStatus

  create(orderId: Order id) {
    this.status := Pending
  }

  handle markPaid() {
    precondition this.status == Pending
    this.status := Paid
  }
  handle ship() {
    precondition this.status == Paid
    let order = Orders.getById(this.orderId)
    order.ship()
    this.status := Shipped
  }
  handle cancel(reason: string) {
    precondition this.status != Shipped
    let order = Orders.getById(this.orderId)
    order.cancel()
    this.status := Cancelled
  }
}
```

The create-param `orderId` and the field `orderId` match by name (and by `Order id` type); the field is auto-seeded when the `create` runs. The body then handles any other initialization (here, setting the initial status). When create-param and field names differ, an explicit `by <param>` clause on the create makes the mapping visible (parallel to the event-triggered case):

```ddd
workflow OrderFulfillment {
  orderId: Order id           // correlation field (sole Order id field)

  create(targetOrder: Order id) by targetOrder {
    this.status := Pending
  }
  // ...
}
```

### 4. Event-triggered process manager (with explicit failure handler)

```ddd
workflow OrderFulfillment {
  orderId: Order id           // correlation field (sole Order id field)
  status: FulfillmentStatus

  create(event: OrderPlaced) by event.order {
    this.status := AwaitingPayment
  }

  on(paid: PaymentReceived) by paid.orderId {
    let order = Orders.getById(this.orderId)
    order.reserveStock()
    order.charge(paid.amount)
    this.status := Paid
  }

  on(arr: ShipmentArrived) by arr.shipRef {
    this.status := Shipped
  }

  // The saga case: author writes the inverse explicitly
  on(failed: PaymentFailed) by failed.orderId {
    let order = Orders.getById(this.orderId)
    if order.isReserved then order.unreserveStock()
    this.status := Cancelled
  }

  handle adminCancel(reason: string) {
    precondition this.status != Shipped
    let order = Orders.getById(this.orderId)
    order.cancel()
    this.status := Cancelled
  }
}
```

#### Multiple-starter variant

A workflow can declare multiple `create` declarations — one per entry point. Useful when the same workflow type can be kicked off by customer action, admin import, or system event:

```ddd
workflow OrderFulfillment {
  orderId: Order id           // correlation field (sole Order id field)
  status: FulfillmentStatus

  create(event: OrderPlaced) by event.order {
    this.status := AwaitingPayment
  }
  create import(event: OrderImported) by event.target {     // named alternate starter
    this.status := PaymentDeferred                          // imports bypass payment
  }

  // continuations as before
  on(paid: PaymentReceived) by paid.orderId { ... }
}
```

### Combined: event-sourced workflow

```ddd
workflow OrderFulfillment eventSourced {
  orderId: Order id           // correlation field (sole Order id field)
  status: FulfillmentStatus
  paidAt: datetime?

  create(event: OrderPlaced) by event.order {
    emit FulfillmentStarted { orderId: event.order }
  }
  apply(e: FulfillmentStarted) {
    orderId := e.orderId
    status := AwaitingPayment
  }

  on(paid: PaymentReceived) by paid.orderId {
    emit PaymentRegistered { at: paid.at }
  }
  apply(e: PaymentRegistered) {
    status := Paid
    paidAt := e.at
  }

  handle cancel(reason: string) {
    emit FulfillmentCancelled { reason: reason }
  }
  apply(e: FulfillmentCancelled) {
    status := Cancelled
  }
}
```

The workflow's event log contains only its own emitted events. External events (`OrderPlaced`, `PaymentReceived`) are triggers; the `create` and `on(...)` handlers translate each into a workflow-internal event that gets applied. Replay doesn't depend on external streams.

## Why sagas are deferred

Form 5 (saga = form 4 + compensation contract) is deferred to a v2 amendment. Three open problems prevent a clean v1 design:

1. **Failure trigger.** What kicks off compensation? An unhandled exception in a handler body? An explicit failure event like `on(failed: …)`? A terminal state transition? Each implies different runtime infrastructure.
2. **Compensation scope.** Does "compensate" mean undoing the last completed step, all steps in this handler, or all completed steps across the workflow's lifetime? The Garcia-Molina & Salem 1987 paper says "all completed, in reverse order" — but real systems need finer control (don't refund if the customer hasn't seen the charge yet; don't unreserve if the shipment is in flight).
3. **Mechanism.** Validator-only (`compensated` enforces inverses exist; author writes the dispatch) vs. fully automatic (Loom emits a forward-step log and reverse-dispatch infrastructure). The automatic path is meaningful work: forward-step logging table per workflow, atomic append on every operation call, compensator-failure policy, argument capture for compensators that need data.

In v1, sagas are still expressible — authors write form 4 with explicit failure handlers, calling inverse operations manually. The capability is present; the compile-time guard rails (validator-enforced compensator existence) and runtime automation (reverse dispatch) are not.

When saga design is settled, the addition is purely additive:
- New `compensated` modifier on workflows (opt-in).
- New `compensatedBy <op>` clause on operations (opt-in).
- New validator rules (only fire on `compensated` workflows).
- Optional runtime log + reverse-dispatch infrastructure.

No breaking change against v1.

## Schemas as the boundary

Today's `<outdir>/.loom/wire-spec.json` is generated from aggregate `wireShape`. This couples external consumers to internal aggregate structure — the paper's antipattern.

This proposal moves the boundary to **commands** and **events**. The published artifact (`.loom/contracts.json` — exact name TBD with the [`payload-transport-layer.md`](./payload-transport-layer.md) coordination) catalogs every declared `command` (including ones synthesised by implicit-command sugar) and every declared `event`.

Aggregate wire shapes continue to be emitted for intra-context use (API client, React forms). The published boundary catalog is commands + events only.

Versioning policy follows API versioning generally: never break old versions; publish new versions alongside; deprecate slowly.

## Commands as first-class declarations

```ddd
command PlaceOrder { customerId: Customer id, placedAt: datetime }
```

Used either by reference (`workflow X(command: PlaceOrder)`, `handle(c: PlaceOrder)`) or synthesised by sugar (`workflow PlaceOrder(customerId: Customer id, ...)` auto-creates the command). Synthesised commands carry a back-reference (`declaringWorkflow`) for the catalog.

## Grammar additions

```langium
// === Commands ===
CommandDecl:
    'command' name=ID '{'
        (fields+=Property (','? fields+=Property)* ','?)?
    '}';

// === Aggregate modifier — eventSourced ===
Aggregate:
    'aggregate' name=ID
        eventSourced?='eventSourced'?
        ('ids' idKind=IdKind)?
        withClause=WithClause? '{'
        members+=AggregateMember*
    '}';

AggregateMember:
    Containment | DerivedProp | Invariant | FunctionDecl
    | Operation | EntityPart | TestBlock | Property
    | ApplyDecl;  // NEW — only legal when eventSourced

ApplyDecl:
    'apply' '(' binding=ID ':' eventType=[EventDecl:ID] ')' '{'
        body+=Statement*
    '}';

// === Workflow ===
Workflow:
    'workflow' name=ID
        eventSourced?='eventSourced'?
        ('ids' idKind=IdKind)?
        (transactional?='transactional' ('(' isolation=IsolationLevel ')')?)?
    '{'
        members+=WorkflowMember*
    '}';

WorkflowMember:
    Property                  // state field; correlation field identified by type-match in enrichment
  | Invariant
  | DerivedProp
  | WorkflowCreateDecl        // starter — at least one required for stateful workflows
  | HandleDecl                // continuation command handler
  | OnDecl                    // continuation event subscription
  | ApplyDecl;                // when eventSourced

WorkflowCreateDecl:
    'create' (name=ID)?
        '(' (params+=Parameter (',' params+=Parameter)*)? ')'
        ('by' correlationExpr=Expression)?       // omitted = name-match (events) or N/A (commands)
    '{'
        body+=Statement*
    '}';

// Workflow create-param shapes (resolved during lowering, not at parse time):
//   create(event: E) by ...      → event-triggered (one positional `binding: EventRef` param)
//   create(command: C)           → explicit-command-triggered
//   create(p1: T1, p2: T2, ...)  → implicit-command-sugar; synthesises a command

HandleDecl:
    'handle' name=ID '(' (params+=Parameter (',' params+=Parameter)*)? ')' '{'
        body+=Statement*
    '}';

OnDecl:
    'on' '(' binding=ID ':' eventType=[EventDecl:ID] ')'
        ('by' correlationExpr=Expression)?
    '{'
        body+=Statement*
    '}';

// === Property — unchanged ===
// The correlation field is identified by type-match (the workflow's regular field whose type
// matches the value yielded by all `by` clauses). No new Property modifier required.
```

## Validation rules

1. `eventSourced` `operation` bodies may not contain `:=`. (`loom.event-sourced-operation-mutates`)
2. `eventSourced` `handle` bodies may not contain `:=`. (`loom.event-sourced-handle-mutates`)
3. `eventSourced` `on(...)` bodies may not contain `:=`. (`loom.event-sourced-on-mutates`)
4. In `eventSourced` workflows, `create` bodies may only `emit` (no `:=`). The applier consumes the emitted event. (`loom.event-sourced-create-mutates`)
5. `apply(...)` bodies may not contain `emit`, repository calls, or operation calls. (`loom.apply-impure`)
6. `apply(...)` is only legal in `eventSourced` declarations. (`loom.apply-without-event-sourced`)
7. `on(...)` is only legal in workflows. (`loom.on-outside-workflow`)
8. `operation` bodies may not call other aggregates or repositories. (`loom.aggregate-operation-crosses-boundary`)
9. `handle` is only legal in workflows. (`loom.handle-outside-workflow`)
10. Stateful workflows (any field declared, any `handle`, any `on(...)`) must have a correlation field — identified by type-match against the value type yielded by every `by` clause across the workflow's declarations. (`loom.workflow-correlation-required`)
11. Every workflow must declare at least one `create` declaration (stateless `transactional` workflows still need one to define the trigger). (`loom.workflow-no-create`)
12. `by <expr>` (anywhere it appears — `create`, `on(...)`) must yield a value type-compatible with the correlation field's type. (`loom.correlation-type-mismatch`)
13. **Correlation seeding rule.** When a `create` runs:
    - **Event-triggered `create(event: E)`:** the correlation field is seeded by the `by <expr>` clause, or by name-match (event field of the same name as the correlation field) when `by` is omitted.
    - **Command-triggered `create(p1: T1, ...)`** (implicit or explicit command): the correlation field is seeded by name-match from a create-param of the same name. If no matching param exists, the `create` must carry an explicit `by <paramName>` clause.
    Validator error if no seeding source can be identified. (`loom.correlation-not-seeded`)
14. **Create-param-to-field seeding.** When a create-param's name matches a declared state field of the same type, the field is auto-seeded from the param. Mismatched type is an error. (`loom.create-param-type-mismatch`)
15. **`this.id` inside a `create` body is invalid** — id is not assigned until persistence. (`loom.this-id-in-create`, shared with the aggregate `create` lifecycle rule.)
16. `transactional` is only legal on workflows with exactly one `create`, no `handle`, no `on(...)`, and no `apply` blocks. (`loom.transactional-multi-handler`)
17. Stateless `transactional` workflows have no state fields declared. (Permitted; no error.)
18. Non-`transactional` workflows with no continuation members but with state fields are legal — stateful single-starter with audit row. (Permitted; no error.)
19. All `by` clauses across a workflow's `create` / `on(...)` declarations must yield values of the same type, matching exactly one of the workflow's regular fields. Ambiguity (multiple matching fields) is a v1 error; the modeller must restructure. (`loom.correlation-field-ambiguous`)
20. (reserved — was `correlation-key-duplicate`; merged into rule 19.)
21. **At most one canonical (unnamed) `create` per workflow.** Named variants distinguish multiple entry points. (`loom.canonical-create-duplicate-workflow`)
22. **No two `create` declarations on one workflow may share a name.** (`loom.create-name-conflict-workflow`)
23. **No two `create` declarations on one workflow may subscribe to the same event type** with overlapping `by` clauses (validator detects identical or unrestricted overlap; complex predicates produce a warning). (`loom.create-event-overlap`)
24. **A `create(event: E)` and an `on(e: E)` for the same event type** are legal — the runtime prefers continuation on correlation hit, creation on miss. The validator only ensures the `by` clauses agree on which field of E carries the correlation key. (`loom.create-on-correlation-mismatch`)
25. Implicit-command sugar (`create(p1: T1, ...)`) and explicit `command: C` (`create(c: C)`) in the same create declaration are mutually exclusive. (Grammar enforces.)
26. `emit` of an event not declared in the same context — unchanged from today.

## IR — one shape, two facades

```typescript
export interface LoomEntityIR {                  // working name; replaces today's AggregateIR
  name: string;
  kind: 'aggregate' | 'workflow';
  eventSourced: boolean;
  idField: FieldIR;                              // always present, typed <Name> id
  correlationField: FieldIR | null;              // workflow only; null for stateless workflows
  fields: FieldIR[];
  invariants: InvariantIR[];

  creates: CreateIR[];                           // both aggregate and workflow (Ash-style typed action)
  operations: OperationIR[];                     // aggregate only
  destroys: DestroyIR[];                         // aggregate only (per lifecycle-operations.md)
  handles: HandleIR[];                           // workflow only
  subscriptions: OnIR[];                         // workflow only
  applies: ApplyIR[];                            // when eventSourced

  wireShape: WireShapeIR;                        // derived in enrichments
  hasTable: boolean;                             // derived: stateful workflows + all aggregates
  transactional: boolean;                        // workflow only; derived from declaration modifier
  isolation: IsolationLevel | null;              // workflow only
}

export interface CreateIR {                      // typed-action starter (workflow) or factory (aggregate)
  name: string | null;                           // null for canonical (unnamed) create
  triggerKind: 'event' | 'command-implicit' | 'command-explicit' | 'aggregate-factory';
  // event trigger (workflow):
  eventRef?: EventIR;                            // for triggerKind = 'event'
  eventBinding?: string;                         // parameter name bound to the event
  correlation?: ExprIR;                          // by-clause; typed against correlationField (workflow)
  // command trigger (workflow):
  commandRef?: CommandIR;                        // for triggerKind = 'command-explicit'
  synthesisedCommand?: CommandIR;                // for triggerKind = 'command-implicit'
  // aggregate factory:
  params: ParamIR[];                             // explicit param list for command-style triggers and aggregate factories
  // common:
  body: StmtIR[];                                // restricted in eventSourced (emit-only)
  paramSeedings: ParamSeedingIR[];               // resolved auto-assignments from create-params to state fields
  canonicalCreate: boolean;                      // derived: true when name == null
  routeSlug: string | null;                      // workflow: per `urlStyle` from lifecycle-operations.md; null for event-triggered
}

export interface ParamSeedingIR {                // resolved auto-assignment from create-param to field
  paramName: string;
  fieldName: string;
  isCorrelationKey: boolean;
}

export interface HandleIR {                      // workflow continuation command handler
  name: string;
  params: ParamIR[];
  synthesisedCommand?: CommandIR;                // when implicit-command sugar used
  body: StmtIR[];
}

export interface OnIR {                          // workflow event subscription (continuation)
  binding: string;
  eventRef: EventIR;
  correlation: ExprIR;                           // explicit, or inferred via name-match
  body: StmtIR[];
}

export interface ApplyIR {
  binding: string;
  eventRef: EventIR;
  body: StmtIR[];                                // restricted to mutations + derivations
}

export interface DestroyIR {                     // aggregate terminator (per lifecycle-operations.md)
  name: string | null;
  params: ParamIR[];
  body: StmtIR[];
  canonicalDestroy: boolean;
}

export interface CommandIR {
  name: string;
  fields: FieldIR[];
  synthesised: boolean;
  declaringWorkflow?: string;                    // back-reference when synthesised
  declaringCreateName?: string | null;           // back-reference when synthesised from a named create
}
```

The same `CreateIR` shape serves both aggregates and workflows; `triggerKind` discriminates. Aggregate creates are always `triggerKind: 'aggregate-factory'` (no event, no command synthesis — they're invoked directly via the lifecycle-operations.md routing). Workflow creates carry one of the three trigger-shape tags.

The IR commits to "don't invent twice" — one shape for both kinds. Behaviour-bearing members (`operations` vs `handles` + `subscriptions`) diverge; structure-bearing members (`fields`, `invariants`, `idField`, `wireShape`) are shared. Backend emitters that touch only the structural side need no per-kind branching.

### Lowering

| Phase | Change |
|---|---|
| ⑤a `lower.ts` | `lowerAggregate` handles `create`/`destroy`/`apply(...)` members (per lifecycle-operations.md); new `lowerWorkflow` produces a `LoomEntityIR` with `kind: 'workflow'` and lowers `create`/`handle`/`on`/`apply` members. Share field/invariant/create lowering helpers across both. |
| ⑤b `lower-expr.ts` | Add expression support for event-binding access (`event.field` where `event` is the parameter name of a `create(event:)` / `apply` / `on` declaration). New `refKind: 'event-binding'`. |
| ⑥ `enrichments.ts` | For workflow command-triggered creates with implicit-command sugar, synthesise a `CommandIR` linked back via `declaringWorkflow` + `declaringCreateName`. Wire-shape enrichment runs over the unified shape. Infer `correlationField` from type-match: the workflow's unique regular field whose type matches the value type produced by every `by` clause across `create` / `on(...)` declarations. Resolve `paramSeedings` per create. Compute `hasTable` (false for stateless `transactional` workflows). Compute `transactional` and `isolation` from declaration modifiers. |
| ⑦ `validate.ts` | New validators for rules 1–26 above. |
| ⑨ `system/wire-spec.ts` | Add new sibling artifact `contracts.json` cataloging `CommandIR` + `EventIR`. Aggregate-shape `wire-spec.json` continues for intra-context consumers (deprecation timing TBD with payload-transport-layer coordination). |

## Per-backend emit

| Backend | Aggregate today | Workflow additions |
|---|---|---|
| TS / Hono | Drizzle table, repository, route handlers per `operation` (+ `create`/`destroy` per lifecycle-operations.md) | Route per command-triggered `create` (POST /workflows/<name> or named variant). Event-subscription router per event-triggered `create` and per `on(...)` (in-process dispatch via existing `IDomainEventDispatcher`). Route per `handle`. `apply(...)` blocks lower to event-applier functions called from `repo.append(event)`. Command-synth lowers to wire DTO. |
| .NET / EF + Mediator | EF entity, repository, mediator handler per `operation` (+ `create`/`destroy`) | Mediator command handler per command-triggered `create`. Mediator notification handler per event-triggered `create` and per `on(...)`. Mediator handler per `handle`. `apply(...)` lowers to `Apply(Event e)` method. |
| Phoenix / Ecto | _(Superseded 2026 — originally described the removed Ash foundation: Resource with actions mapping Loom `create`/`operation`/`destroy`. On the now-sole vanilla foundation these are plain Ecto schema + context functions.)_ Ecto `Changeset` CRUD per `operation` (+ `create`/`destroy`) | Context function per command-triggered `create`; an `on(...)`/event-triggered handler per subscription; `apply(...)` lowers to a fold `apply_event/2` clause over the `<wf>_events` stream. |
| React | Forms / pages bound to `operation`s (+ create forms per loom-forms.md) | `CreateForm { of: WorkflowName }` for command-triggered `create`s (one form per `create` declaration). `OperationForm` for workflow `handle`s (per [`loom-forms.md`](./loom-forms.md)). Event-triggered `create`s have no user-facing form (system fires them). |

The execution model — how `on(...)` handlers are triggered when an event arrives — is deferred to per-backend implementation. v1 uses in-process dispatch through today's `IDomainEventDispatcher`. Future phases may introduce durable execution (Temporal, durable-functions, in-process saga libraries) without language changes.

## Backward compatibility

Breaking against today:

1. `workflow Name(params) transactional { body }` (today) → `workflow Name transactional { create(params) { body } }` (v2). Mechanical rewrite: header params + body become the workflow's single `create` declaration. The body uses `this.field := X` for any state mutation (in the stateless case, no `this` reads happen). Where the original body referenced `params` directly, v2 references them inside the `create` body identically.
2. `workflow Name(params) { body }` without `transactional` — **rejected** (multi-tx workflow with no state is the antipattern the paper identifies). Either add `transactional` (declare atomicity) or restructure into stateful workflow with declared correlation field, state, `create`, and `handle`s. No `bestEffort` opt-out.
3. Aggregate `operation` bodies that today call `Repo.getById(...)` or other aggregates — **rejected.** Refactor into a workflow `handle` that performs the orchestration.
4. `docs/workflow.md` rewritten to match the new model with migration recipe.

Mechanical migration recipe for v1 → v2 (the trigger-as-header → trigger-as-create change):

```ddd
// Before (v1)
workflow PlaceOrder(customerId: Customer id, placedAt: datetime) transactional {
  outcome: PlaceOrderOutcome
  start {
    let order = Order.create({ customerId, placedAt })
    outcome := Completed
  }
}

// After (v2)
workflow PlaceOrder transactional {
  customerId: Customer id      // correlation field (sole Customer id field)
  placedAt: datetime
  outcome: PlaceOrderOutcome

  create(customerId: Customer id, placedAt: datetime) {
    let order = Order.create({ customerId, placedAt })
    this.outcome := Completed
  }
}
```

Examples needing updates: `examples/acme.ddd`, `examples/sales.ddd`, every fixture under `test/fixtures/`. Re-baselining is required.

## Coordination with other proposals

- [`payload-transport-layer.md`](./payload-transport-layer.md) — recommendation: `CommandDecl` becomes sugar over `payload Name`, and the boundary artifact derives from the unified payload IR. This proposal should land *after* payload P1-P4.
- [`exception-less.md`](./exception-less.md) — workflow `handle` bodies return `or`-unions on failure. `?` propagation composes; no conflict.
- [`criterion.md`](./criterion.md) — `private workflow` modifier and workflow-calls-workflow extend trivially to this proposal's workflow shape.
- [`lifecycle-operations.md`](./lifecycle-operations.md) — aggregate's `create` typed-action shape is the model this proposal lifts to workflows. Both kinds of entity share the `create [name](params) { ... }` declaration form (workflows extend it with `by <expr>` and event-typed first params). Aggregate-only `destroy` and aggregate-only `operation` remain unchanged. Workflows do not gain `destroy` in v1 (terminal state transitions handle workflow termination); future amendments may add it.
- [`storage-and-platform-config.md`](./storage-and-platform-config.md) — its `persistenceStrategy: stateBased | eventSourced` overlaps with this proposal's `eventSourced` modifier. **Reconcile by choosing one surface** — recommend this one (declaration-site over binding-site). Storage adapter contract unchanged.
- [`authorization.md`](./authorization.md) — `policy` gates apply to `handle`s like to `operation`s. `on(...)` handlers bypass user-facing authorization (they react to system facts, not user requests).

## Open questions

1. **Multi-starter workflows.** v1 admits exactly one starter. v2 may extend the header to a union when the payload-transport-layer's anonymous-union work lands.
2. **Cross-system event subscription.** v1 expects all subscribed events to be declared in the same `system`. Cross-system routing follows after the contracts catalog stabilises.
3. **Event-store choice for `eventSourced`** — per-backend. The `PersistenceAdapter` contract gains a `kind: 'state' | 'event-log'` capability.
4. **Sagas** — the v2 amendment. See §"Why sagas are deferred."
5. **`contracts.json` artifact name and format.** Coordinate with payload-transport-layer's published schema work.
6. **Workflow termination.** When does a workflow's row get removed (or archived)? Three plausible models, none chosen for v1:
   - **Terminal state declaration** — the modeller marks specific values of a status enum as terminal (`status: FulfillmentStatus { Pending, Paid, Shipped terminal, Cancelled terminal }`); reaching one signals end-of-life. Composes with field-defaults from `lifecycle-operations.md`.
   - **Explicit workflow `destroy`** — lift the aggregate's `destroy` keyword to workflows. Author calls it from a `handle`/`on` body.
   - **Always-keep** — workflow rows are immortal; cleanup is operator-level (TTL, manual purge). Matches NServiceBus/Camunda defaults.

   v1 ships with always-keep semantics by default (no language feature). The terminal-state-declaration path is the most likely v2 addition since it composes with declarative defaults and reads naturally; we defer the decision until usage informs it.
7. **Disambiguating multiple same-type correlation candidates.** v1 rejects workflows where multiple regular fields share the type yielded by `by` clauses. A future `into <fieldName>` clause on `by` may relax this; deferred.

## Implementation phases

| Phase | Scope | Approx. |
|---|---|---|
| W1 | Grammar additions (commands, aggregate modifier, workflow reshape, `apply`, `on`, `handle`) | ~1 wk |
| W2 | IR unification (`LoomEntityIR`, new IR nodes, lowering helpers, correlation-field inference) | ~2 wk |
| W3 | Validators (rules 1–26 + negative tests) | ~1.5 wk |
| W4 | Backend emit — TS/Hono | ~2 wk |
| W5 | Backend emit — .NET | ~2 wk |
| W6 | Backend emit — Phoenix (state-based; event-sourced deferred until event-store adapter lands) | ~1.5 wk |
| W7 | Backend emit — React (workflow `handle` forms; starter-command forms) | ~1 wk |
| W8 | Schemas-as-boundary artifact (`contracts.json`) | ~1 wk |
| W9 | Migrate examples + fixtures + docs (`docs/workflow.md` rewrite) | ~1 wk |

Total ~13 weeks focused. W4-W7 parallelisable; W2 blocks downstream.

Sequencing: this proposal lands *after* payload-transport-layer P1–P4. Independent of criterion / exception-less, with mild integration work either way.

## Appendix — source-claim mapping

| Source claim | Loom landing in v1 |
|---|---|
| The aggregate is the transaction boundary | Validation rule 7 — aggregate `operation`s may not cross boundaries |
| Appliers and workflows split along the aggregate boundary | `apply(...)` (intrinsic, replay-safe) vs. `on(...)` (extrinsic) — validators 3–6 |
| Forms 1–4 (applier, single-tx workflow, multi-tx command workflow, process manager) | §"The four forms" |
| Form 5 (saga) | Deferred — §"Why sagas are deferred" |
| Workflow state is an aggregate | Unified IR; workflows have implicit `id`, optional state fields, table when stateful |
| Schemas of commands + events are the boundary | §"Schemas as the boundary" — new `contracts.json` |

Explicitly out of scope:
- User-configurable workflows (deferred per source).
- Temporal / Cadence / Restate as execution platforms (per-backend deferred).
- Camunda / Flowable / Zeebe as user-configurable layers (deferred).

---

