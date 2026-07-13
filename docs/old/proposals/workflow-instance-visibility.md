# Workflow instance visibility — listing and inspecting running workflows in the UI

> Status: **proposed (not implemented).** Workflows already persist a
> per-instance correlation/saga-state row (see *Today* below), so the
> data exists — but there is no read API and no UI to observe it. This
> proposal adds a read-only "instance" surface that **reuses the aggregate
> read pipeline** (`wireShape` → auto-finds → `GET` routes → React Query
> hooks → scaffolded List/Detail pages) rather than inventing new
> machinery. Write paths (starting/advancing a workflow) are unchanged —
> they already exist as the POST trigger routes and `WorkflowForm` pages.

> **[2026-06-20 status audit]** SHIPPED (no longer 'proposed/not implemented') — `instanceWireShape` enrichment + instance tests on hono/dotnet/java/python/phoenix/vanilla + React/scaffold (#1035).

## Problem

A stateful workflow is, at runtime, *almost exactly an aggregate*:

- It has an **identity** — its `correlationField` (the single id-shaped
  state field the dispatcher routes inbound events to).
- It has **state** — its `stateFields` (the saga columns).
- It is **persisted** — `buildMigrations` derives a correlation-state
  table for every correlation-bearing workflow, and
  `workflowStateTableShape`
  (`src/system/migrations-builder.ts:189`) is documented as *"mirrors
  `tableForAggregate`"*: PK is the correlation field, the remaining state
  fields are columns mapped the same way an aggregate's fields are. This
  ships on all three backends (`docs/workflow.md` §Status — Hono
  workflow-state row, .NET `<Workflow>State` POCO + EF config, Phoenix
  saga-state `Ecto.Schema`).

Aggregates get a full read surface generated from that same shape:

| Layer | Aggregate mechanism | File |
|---|---|---|
| Wire schema | `wireShape` (id + properties + …) | `src/ir/enrich/enrichments.ts` |
| Implicit query | auto `find all()` | `ensureFindAll` (`enrichments.ts`) |
| REST | `GET /widgets`, `GET /widgets/{id}` | `src/platform/hono/v4/routes-builder.ts` |
| Client | `useAllWidgets()`, `useWidgetById(id)` | `src/generator/react/api-builder.ts` |
| Pages | `WidgetList`, `WidgetDetail` | `src/macros/stdlib/scaffold/_pages.ts` |

**Workflows get none of the read half.** The only generated HTTP surface
is the POST trigger (`POST /workflows/<snake>` — the command/starter
route), and the only generated UI is the *trigger form*: a
`<Name>Workflow` page at `/workflows/<snake>` rendering
`scaffoldWorkflowForm(runs:)`, plus a `WorkflowsIndex` page at
`/workflows` listing the forms you can submit (`_pages.ts:85`,
`:122`). That UI answers *"how do I start one?"* — never *"which ones are
running, and what state are they in?"*.

So an operator running a generated system can fire `placeOrder` or
`Fulfillment` but cannot see the in-flight `Fulfillment` sagas, their
correlation ids, or their current saga-state values — even though every
one of those is a queryable row in a table the toolchain itself derived.
Stateful workflows are invisible at the UI layer, which also means they
are **untraceable** there (cf. `docs/traceability.md`), unlike aggregates.

## Do we need new APIs?

**Yes — but only read endpoints, and only a thin mirror of the existing
aggregate route pattern.** No new persistence, no new IR backbone, no new
walker primitives. Concretely, per observable workflow:

- `GET /workflows/<snake>/instances` → list of instance state rows.
- `GET /workflows/<snake>/instances/{id}` → one instance by correlation id.

These are deliberately **read-only**. A workflow instance is never
created or mutated by a client PUT/POST against the instance resource —
it is born from a `create` starter and advances through `handle`/`on`
handlers, all of which already have their command/event routes. The
instance surface is a *projection of saga state*, the read side of the
existing write side. (404 on unknown id, same as `GetById`.)

The route prefix `/workflows/<snake>/instances` nests under the existing
`POST /workflows/<snake>` command route without colliding (the command is
a POST on the bare path; instances are GETs on a sub-path), so no existing
URL moves.

## Design — reuse the aggregate read pipeline

The whole proposal is "treat the workflow's `(correlationField,
stateFields)` as an aggregate-shaped read model and run it through the
machinery that already exists." Five small slices, each bolting onto an
existing seam.

### 1. Enrichment — a `wireShape` for workflows

In `src/ir/enrich/enrichments.ts`, alongside `wireFieldsForAggregate`,
derive a wire field list for every correlation-bearing workflow:

- `correlationField` → the `id`-shaped token field (the `access: "token"`,
  `source: "id"` entry, exactly like an aggregate's `id`).
- each remaining `stateField` → a `source: "property"` wire field, run
  through the same `forApiRead` projection (`src/ir/.../wire-projection.ts`)
  so `internal` / `secret` saga fields are excluded from the API read just
  as they are for aggregates.

Store it as `WorkflowIR.instanceWireShape` (new optional field on
`WorkflowIR`, `src/ir/types/loom-ir.ts:856`). Because the migration table
is already `tableForAggregate`-shaped, this is a structural restatement of
columns that already exist — no new truth.

This makes the workflow's read model a *branded, enriched* shape the same
way `EnrichedAggregateIR` carries `wireShape!`, so a backend that forgets
to read it fails to type-check rather than silently emitting nothing.

### 2. Read endpoints (per backend)

Each backend already emits the workflow's POST trigger
(`workflow-builder.ts` / `dotnet/workflow-emit.ts` /
`phoenix-live-view/workflow-emit.ts`). Add, gated on
`wf.correlationField`, two GET handlers that read the correlation-state
table the migration already created:

- **Hono** — a `list` and a `byId` query over the workflow-state Drizzle
  table (the same table `workflow-builder.ts` loads-or-allocates for
  correlation), serialised through the `instanceWireShape` DTO. Mirror
  `emitResponseDtoSchema` for the Zod response.
- **.NET** — `[HttpGet]` / `[HttpGet("{id}")]` actions on a
  `<Ctx>WorkflowsController` (or a dedicated `<Wf>InstancesController`),
  reading the EF-mapped `<Workflow>State` entity. The state POCO + EF
  config already exist (`dotnet/workflow-state-emit.ts`).
- **Phoenix** — a thin controller over the saga-state `Ecto.Schema`.
  _(The Ash-foundation alternative — an Ash `read :instances` / `read
  :instance` action — was removed in 2026: `platform: elixir` is plain
  Ecto/Phoenix only; `foundation: ash` is now a validation error.)_

This is the bulk of the work, but each is a direct analogue of the
aggregate `getById` / `findAll` route the same file already knows how to
emit. **Parity gate:** extend the cross-backend OpenAPI parity check
(`conformance-parity.yml`) so the three instance surfaces stay
byte-aligned, exactly as aggregate routes are.

### 3. React client hooks

In `src/generator/react/api-builder.ts`, emit per observable workflow:

- `useAll<Wf>Instances()` → `GET /workflows/<snake>/instances`
- `use<Wf>InstanceById(id)` → `GET /workflows/<snake>/instances/{id}`

Same React Query + Zod-parse shape as `useAllWidgets` / `useWidgetById`.
The api-hook-detector (`src/generator/_walker/api-hook-detector.ts`) gains
a pattern for `<Wf>.instances.all` / `<Wf>.instances.byId(id)` so page
bodies can bind to them the way they bind to `Order.all`.

### 4. Scaffold pages — `<Wf>InstancesList` + `<Wf>InstanceDetail`

In `src/macros/stdlib/scaffold/`, extend `scaffoldWorkflow` (and
`_pages.ts`) so an observable workflow scaffolds two read pages, mirroring
`scaffoldAggregate`'s List/Detail (`scaffoldNewForm` has **no** analogue —
instances aren't created from a generic form):

- **`<Wf>InstancesList`** — route `/workflows/<snake>/instances`, body
  `scaffoldInstanceList(of: <Wf>)`, which expands (in
  `walker-primitive-expander.ts`) to the same Breadcrumbs → Toolbar →
  `QueryView(of: <Wf>.instances.all)` → `Table` shape `scaffoldList`
  produces, with one `Column` per `instanceWireShape` field and an
  `IdLink` on the correlation id pointing at the detail page.
- **`<Wf>InstanceDetail`** — route `/workflows/<snake>/instances/:id`, body
  `scaffoldInstanceDetails(of: <Wf>)`, expanding to
  `QueryView(of: <Wf>.instances.byId(id), single: true)` → a `Card` of
  `KeyValueRow`s over the state fields — the `scaffoldDetails` shape minus
  the operations block (instances expose no ad-hoc operations).

Menu placement: under the existing "Workflows" section, so triggering and
observing sit together. The current `<Name>Workflow` trigger-form page is
unchanged; this is purely additive.

### 5. Status / phase rendering (lightweight, reuses `EnumBadge`)

Workflows have no explicit state-machine enum today — "state" is just the
saga columns. But the *common idiom* is a `status: SomeEnum` state field.
When a workflow's `stateFields` includes an `enum`-typed field, the List
column and Detail row for it render through the existing `EnumBadge`
primitive (no new walker work), giving an at-a-glance status the same way
aggregate enum fields already render. No new DSL surface required.

## Worked example

```ddd
command SettleOrder   { order: Order id, note: string }
event   PaymentReceived { order: Order id, amount: int }

workflow Fulfillment {
  invoiceId: Invoice id              // correlation field (PK of the state table)
  status: FulfillmentStatus          // saga state → EnumBadge column
  amountDue: int

  create(c: SettleOrder)                 { ... }
  create(paid: PaymentReceived) by paid.order { ... }
  handle settle(c: SettleOrder)          { ... }
}
```

Generated today: `POST /workflows/fulfillment` + a `FulfillmentWorkflow`
trigger-form page.

Generated **additionally** under this proposal:

- `GET /workflows/fulfillment/instances` and
  `GET /workflows/fulfillment/instances/{invoiceId}`.
- `useAllFulfillmentInstances()` / `useFulfillmentInstanceById(id)`.
- A `FulfillmentInstancesList` page (table of `invoiceId`, a
  `FulfillmentStatus` `EnumBadge`, `amountDue`, with an `IdLink` per row)
  and a `FulfillmentInstanceDetail` page (key/value card of the saga
  fields).

Now an operator can see every in-flight `Fulfillment`, its correlation id,
and its current status — read-only, derived entirely from state Loom
already persists.

## Decisions to confirm (open questions)

1. **Opt-in or default?** Should *every* correlation-bearing workflow get
   instance pages, or should it be gated — e.g. a `scaffold workflows:`
   selector (today's `scaffold` already enumerates aggregates/views) or a
   per-workflow `observable` modifier? **Recommendation:** default-on for
   the *API* (cheap, read-only, no schema cost) but gate the *pages*
   behind the existing `scaffold` selector, so instance UI is opt-in the
   way aggregate pages are.
2. **eventSourced workflows.** ✅ SHIPPED (the v2 amendment below, all 5 ES
   backends). An `eventSourced` workflow (`wf.eventSourced`) folds state from an
   event stream rather than a state table; there is no correlation-state table to
   read. The chosen path is option (a) — read/fold the stream: the same
   `instanceWireShape` is enriched for ES workflows (the
   `enrichWorkflowInstanceShape` short-circuit dropped its `|| wf.eventSourced`
   clause), and each backend's instance read **body** branches on `wf.eventSourced`
   — LIST group-folds the whole `<wf>_events` table by `stream_id`, byId folds a
   single stream. The **event-timeline detail view** (raw stream rows) stays
   deferred (item 5 / Deferred below).
3. **Authorization.** Who may view instances? Reuse the page-level / route
   `requires` guard surface (cf. `frontend-acl.md`); instance lists may
   leak business state and should default to the same auth posture as the
   trigger.
4. **Pagination.** Instance tables can be large. v1 can lean on the
   existing `paged`/pagination design note
   (`docs/old/proposals/pagination-design-note.md`) rather than dumping all
   rows; align `GET .../instances` with however aggregate `findAll`
   ultimately paginates so they stay symmetric.
5. **Event timeline (future).** For both event-sourced and
   correlation-persisted workflows, a richer detail view could show the
   ordered events that drove the instance (the `on`/`handle`/`apply`
   transitions). This is the genuinely *workflow-specific* visualisation —
   out of scope here, noted as the natural next step once the
   aggregate-shaped read surface lands.

## Why this shape (and what it deliberately avoids)

- **No new persistence.** The table already exists; we read it.
- **No new walker primitives.** `QueryView`, `Table`, `Column`,
  `KeyValueRow`, `IdLink`, `EnumBadge` cover every rendering need —
  confirmed against `src/generator/_walker/registry.ts`.
- **No new IR backbone.** One additive `instanceWireShape` field on
  `WorkflowIR`, derived by the same enrichment pass that builds aggregate
  `wireShape`.
- **No write surface.** Instances are observed, not edited; the write side
  is the already-shipping command/event handlers.

The cost is concentrated where it's irreducible: three per-backend GET
handlers (slice 2), gated by the existing parity check. Everything else is
a restatement of the aggregate read path against a shape the compiler
already treats as aggregate-like.

## Alternative considered — workflows as `view` sources

A different surface would make a workflow addressable as a `view` source
(`view ActiveFulfillments = Fulfillment where this.status == Pending`),
the way aggregates are. Today the grammar/IR deliberately exclude
workflows from `view` declarations (sources are aggregates only). That
route would give filtering/projection for free via the existing view
machinery — but it conflates two reads: the *raw instance list* (this
proposal) and *curated projections over it* (views). They compose
cleanly: ship the aggregate-shaped instance read model first (this
proposal), then — as a smaller follow-up — allow a workflow's instance
read model to be a `view` source so authors can curate
`ActiveFulfillments` / `StalledSagas` projections on top. Doing views
first would invert the dependency (a view needs the underlying read model
to exist), so the instance surface is the right first slice either way.

> Now that this slice has shipped, that follow-up is specified in
> [workflow-instance-views.md](./workflow-instance-views.md).

## Deferred

- ~~Event-sourced workflow instance views (fold-from-stream)~~ — SHIPPED
  (decision 2): ES workflows now carry `instanceWireShape` and expose
  `GET /workflows/<wf>/instances[/{id}]` via group-fold (LIST) / single-stream
  fold (byId) on all 5 ES backends. The per-instance **event timeline** (raw
  stream rows, decision 5) remains deferred.
- Explicit workflow **state-machine** modelling / diagram (today state is
  implicit in saga columns; an explicit states+transitions surface would
  enable a mermaid state-chart view and a richer status column — a
  separate language proposal).
- Mutating an instance from the UI (out of scope by design).

## See also

- `docs/workflow.md` — the workflow surface, body vocabulary, and the
  correlation-state persistence Status section this builds on.
- `docs/old/proposals/workflow-and-applier.md` — workflow-as-aggregate model,
  correlation/saga state, and the deferred projections/read-models work
  the event-sourced follow-up pairs with.
- `docs/page-metamodel.md`, `docs/architecture.md` — the UI/page surface
  and the api/ui/deployable layering the instance pages plug into.
- `src/system/migrations-builder.ts` (`workflowStateTableShape`),
  `src/ir/enrich/enrichments.ts` (`wireFieldsForAggregate`,
  `ensureFindAll`), `src/macros/stdlib/scaffold/_pages.ts`
  (`pageForWorkflow`, `workflowsIndexPage`).
