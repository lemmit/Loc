# Workflow instances as `view` sources — curated saga projections

> Status: **proposed (not implemented).** Follow-up to
> [workflow-instance-visibility.md](./workflow-instance-visibility.md)
> (shipped in #1035), which gave every correlation-bearing workflow an
> `instanceWireShape` and a raw read surface (`GET
> /workflows/<wf>/instances` + scaffolded List/Detail). This proposal lets
> a `view` take a **workflow** as its source — `view ActiveFulfillments =
> Fulfillment where status == Pending` — so authors can curate filtered
> projections over running sagas the way they already do over aggregates,
> reusing the entire `view` pipeline on top of the read model that now
> exists.

## Problem

The instance surface that shipped answers *"show me every running
`Fulfillment`."* It does not answer the questions operators actually ask:
*"which fulfillments are stalled?"*, *"which are awaiting payment?"*,
*"how many are past due?"*. Those are **filtered, named projections** —
exactly what a `view` is.

Today `view` sources are aggregates only (`ViewIR.aggregateName`; the scope
provider and validator reject anything else). The parent proposal flagged
this as the natural next slice and deliberately deferred it:

> ship the aggregate-shaped instance read model first (this proposal),
> then — as a smaller follow-up — allow a workflow's instance read model
> to be a `view` source so authors can curate `ActiveFulfillments` /
> `StalledSagas` projections on top. Doing views first would invert the
> dependency (a view needs the underlying read model to exist), so the
> instance surface is the right first slice either way.

The dependency is now satisfied: `instanceWireShape` is the saga's
queryable wire shape, and `workflowStateTableShape` is its physical table.
A view over a workflow is a filter + projection over that table — the same
shape a view over an aggregate already is.

## Why this is small

A view over an aggregate already does everything needed; the only new part
is *resolving the source to a workflow's state instead of an aggregate*.
Everything downstream — the read endpoint, the Zod/record/Ecto response,
the `scaffoldViewList` page, the React `Views.<name>` hook — consumes
`ViewIR.filter` + a wire shape and is **source-agnostic once the IR says
where to read from**.

| Layer | Aggregate view (today) | Workflow view (this proposal) |
|---|---|---|
| Source | aggregate table, `wireShape` | saga-state table, `instanceWireShape` |
| Filter | predicate over aggregate fields | predicate over saga state fields |
| Read endpoint | `GET /views/<name>` | identical |
| Scaffold page | `scaffoldViewList` → QueryView/Table | identical |
| React hook | `Views.<name>` (Pattern C) | identical |

## Surface

The shorthand form, unchanged in spelling — the source name just resolves
to a workflow:

```ddd
context Sales {
  workflow Fulfillment {
    orderId: Order id
    status: FulfillmentStatus
    amountDue: int
    create(c: SettleOrder) { ... }
    on(paid: PaymentReceived) by paid.order { ... }
  }

  // Filtered projections over running Fulfillment instances.
  view ActiveFulfillments = Fulfillment where status == Pending
  view StalledFulfillments = Fulfillment where status == AwaitingPayment
}
```

The predicate resolves against the workflow's **state fields** (the same
names `this.<field>` binds to inside handlers), and the result shape is the
workflow's `instanceWireShape` — the shorthand-view rule ("result shape ==
the source's wire shape") carried over verbatim.

Full-form views (`view X { … from <source> where … bind … }`) over a
workflow are a natural extension (bind-project from the saga row), but v1
scopes to the **shorthand** form — it covers the curated-list use case and
needs no new projection semantics.

## Design — resolve the source kind, reuse the rest

The whole change is teaching one field (`ViewIR`'s source) to name a
workflow, then letting each existing view consumer read the saga table when
it does.

1. **Grammar / scope.** The view source ref (`= <Name>`) already parses as
   a name reference. Extend the custom scope provider (`ddd-scope.ts`) so a
   view's source resolves to a workflow in the same context as well as an
   aggregate; the validator's queryable-source check learns the
   workflow-state-field vocabulary for the filter (the same predicate
   restrictions as a repository find / aggregate view).

2. **IR.** Make `ViewIR` carry the source *kind*. Minimal additive shape:
   keep `aggregateName` for the aggregate case and add an optional
   `workflowName?: string` (mutually exclusive), or generalise to
   `source: { kind: "aggregate" | "workflow"; name: string }`. Lowering
   resolves the filter against `instanceWireShape` field types when the
   source is a workflow.

3. **Enrichment.** A workflow view's output shape is the workflow's
   `instanceWireShape` (already derived). No new derivation — the view's
   wire shape is read through the source, exactly as an aggregate view
   reads `wireShape`.

4. **Per-backend view emission.** Each backend's view emitter
   (`view-emit.ts` on .NET/Phoenix, the Hono view route, the React
   `Views.<name>` hook) gains one branch: when the source is a workflow,
   read the saga-state table/DbSet/`Ecto.Schema` (the same handles the
   instance endpoints from #1035 already read) with the view's filter
   lowered to the backend's predicate, instead of the aggregate
   repository. The Postgres/Drizzle/EF/Ash filter lowering is unchanged —
   it already turns `ViewIR.filter` into a `where` clause.

5. **Scaffold + React.** No change. `scaffoldViewList` and the `Views.`
   detector/hook are source-agnostic — they consume the view's wire shape
   and name. A workflow view scaffolds and routes exactly like an aggregate
   view.

## Worked example

```ddd
view ActiveFulfillments = Fulfillment where status == Pending
```

generates (reusing the existing view pipeline, now sourced from the saga
table):

- **Hono** `GET /views/active_fulfillments` → `select … from
  order_fulfillments where status = 'Pending'`, response = the Fulfillment
  instance wire shape.
- **.NET** a `ViewsController` action over `_db.OrderFulfillments` with the
  filter, returning `ActiveFulfillmentsResponse`.
- **Phoenix** a `views_controller` action over the
  `OrderFulfillmentState` schema via `Repo`.
- **React** `Views.ActiveFulfillments` → `useActiveFulfillmentsView()` +
  a scaffolded `ActiveFulfillmentsView` page (table of matching sagas).

## Decisions to confirm

1. **IR source shape.** Add `workflowName?` alongside `aggregateName`
   (smaller diff, mirrors how optional fields are added elsewhere) vs a
   `source: {kind,name}` discriminated field (cleaner, but touches every
   `ViewIR` reader). **Recommendation:** the discriminated `source` field —
   views are read in a bounded number of places, and a discriminator makes
   the source-kind switch explicit at each (no "is this name an aggregate
   or a workflow?" lookups).
2. **Shorthand only (v1)?** Defer full-form (`bind`-projected) workflow
   views, or land both? **Recommendation:** shorthand only — it's the
   curated-list use case; full-form is additive later.
3. **Event-sourced workflows.** Same exclusion as the parent: an
   `eventSourced` workflow has no state table, so it can't be a view source
   in v1 (its `instanceWireShape` is absent). The validator rejects it with
   a clear message.
4. **Parity.** The view endpoint joins the existing cross-backend OpenAPI
   parity surface; a workflow-sourced view must diff byte-identically
   across Hono/.NET/Phoenix, same gate as aggregate views.

## Deferred

- Full-form (`bind`-projected) workflow views (decision 2).
- Event-sourced workflow view sources (needs the fold-from-stream read
  model the parent also deferred).
- Cross-context workflow sources (views resolve within their own context,
  same as aggregate views today).

## See also

- [workflow-instance-visibility.md](./workflow-instance-visibility.md) —
  the parent; `instanceWireShape` + the raw instance read surface this
  builds on.
- [`docs/views.md`](../views.md) — the view surface (shorthand / full form)
  this extends.
- `src/ir/types/loom-ir.ts` (`ViewIR`), `src/language/ddd-scope.ts`,
  `src/generator/*/view-emit.ts`, `src/ir/lower/lower-view.ts`.
