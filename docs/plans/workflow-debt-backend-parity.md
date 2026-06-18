# Plan — DEBT-26 workflow backend-parity slices

**Created:** 2026-06-18 · **Status:** living (work through the gap table top-down)

Focused slice plan for **DEBT-26 (workflow execution & persistence)** from
[`debt-prioritized-backlog.md`](./debt-prioritized-backlog.md). That backlog
entry (and the IR doc-comments it cites) **predates most of the shipped
workflow surface** — it reads as if "a persisted workflow-state row is never
emitted." That is no longer true. This doc records the *actual* current state
and decomposes the remaining gaps into one-backend-at-a-time slices.

## What already ships (DEBT-26 is mostly done)

The workflow-as-aggregate model (`workflow-and-applier.md`) and the
instance-visibility read surface (`workflow-instance-visibility.md`) have
landed across most backends:

- **Persisted saga-state row** — `buildMigrations` derives a correlation-state
  table for every correlation-bearing workflow (`workflowStateTableShape`), and
  every DB backend emits its schema/entity (Drizzle / EF `<Wf>State` POCO /
  Ecto schema / SQLAlchemy `<Wf>Row`).
- **In-process dispatcher** — `on(...)` reactors + event-triggered
  `create(...) by` starters with persisted correlation (load-or-allocate /
  route-or-drop+`event_unrouted`) on **node, dotnet, elixir-ash, python**,
  plus the durable-channel outbox tier (`dispatch-delivery-semantics.md`).
- **Instance read surface** — `instanceWireShape` enrichment + `GET
  /workflows/<wf>/instances[/{id}]` on **node, dotnet, elixir-vanilla**, and
  now **python** (this slice).
- **Workflow-as-view-source** — `view = <Workflow> where …` on node, dotnet,
  React/scaffold (`workflow-instance-views.md`).
- **The shared workflow statement spine** — `renderWorkflowStmts`
  (`_workflow/stmt-target.ts`) at 4/5 backends (`workflow-choreographer-seam.md`).

## Per-feature × backend gap table (the remaining work)

| Feature | node | dotnet | elixir-ash | elixir-vanilla | python | java |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| command routes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| saga-state row | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `on`/event-`create` dispatch | ✓ | ✓ | ✓ | **gap** | ✓ | **gap** |
| instance read endpoints | ✓ | ✓ | (Ash defer) | ✓ | ✓ | **gap** |
| view-over-workflow | ✓ | ✓ | (Ash defer) | gap | ✓ | gap |
| `eventSourced` workflows (`apply`) | — | — | — | — | — | — |

(python instance reads + view-over-workflow landed as the first two slices off
this plan; see below.)

## Done in this slice — python instance read endpoints

`src/generator/python/workflows-builder.ts`: every observable workflow
(`instanceWireShape` set) now emits `GET /workflows/<snake>/instances` (list)
and `/instances/{id}` (one by correlation id, 404 via `ProblemDetails`) over the
persisted `<Wf>Row` the dispatcher already upserts, projecting
`instanceWireShape` (camelCase wire key ← snake column, datetimes ISO-coded like
the aggregate `to_wire`). The endpoints are driven off observability
independently of the command route, so an event-triggered-only saga is still
observable — `index.ts` now emits + mounts `workflows_routes.py` when a context
has either a command **or** an observable workflow. Operation-ids and response
component names reuse the shared `opWorkflowInstances` / `opWorkflowInstanceById`
helpers, so cross-backend OpenAPI parity holds by construction. Tests:
`test/generator/python/python-workflow-instances.test.ts`.

## Done in this slice — python workflow-as-view-source

`view X = <Workflow> where <pred>` now emits on Python (parity with node /
dotnet). `src/generator/python/views-builder.ts` reads the source saga's
`<Wf>Row` with the shorthand filter lowered to a SQLAlchemy `where` (a new
`lowerWorkflowFilterToSqlAlchemy` reusing `find-predicate.ts`'s leaf logic over
the saga row instead of an aggregate repository), projecting the same
`instanceWireShape` the instance endpoints expose (`<View>Row` / `<View>Response`).
`index.ts`'s `hasViews` gate now counts observable workflow sources. Tests:
`test/generator/python/python-workflow-view.test.ts` + a `view` on the
`saga.ddd` python-build gate fixture. (Stacked PR on the instance-reads slice.)

## Next slices (recommended order)

1. **Java instance read endpoints** — the direct sibling of this slice, but
   bigger: Java has no saga-state JPA entity yet (the migration table exists but
   no `@Entity`), so this slice carries the state-entity emission too. Reference:
   the .NET `<Wf>State` POCO + instances controller.
2. **Java `on`/event-`create` dispatch** — Java has no in-process dispatcher at
   all; the largest remaining workflow gap. Reference: the python dispatcher
   (`dispatch-builder.ts`) is the closest async-ish shape.
3. **elixir-vanilla dispatch** — port the ash-foundation dispatcher to the
   vanilla foundation (raw `Repo.transaction` + `Phoenix.PubSub`).
4. **`eventSourced` workflows (`apply(...)` folds)** — universal gap; design-first
   (`workflow-and-applier.md` A2-S5b). Pairs with the aggregate event-store path.
