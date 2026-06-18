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
| saga-state row | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `on`/event-`create` dispatch | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| instance read endpoints | ✓ | ✓ | (Ash defer) | ✓ | ✓ | ✓ |
| view-over-workflow | ✓ | ✓ | (Ash defer) | ✓ | ✓ | **gap** |
| `eventSourced` workflows (`apply`) | — | — | — | — | — | — |

Corrections from earlier matrix drift (verified against code): **elixir-vanilla
dispatch already ships** (`index.ts` calls the foundation-agnostic
`emitDispatch(..., "vanilla")`), so it was never a gap. With the python /
elixir-vanilla workflow-view slices, **vanilla is now at full workflow parity
with node/dotnet**. The Java saga track has since landed its
saga-state row (#1288), in-process dispatcher (#1291), and instance read
endpoints (this slice) — so the **only remaining workflow gap is java
view-over-workflow**, plus the universal `eventSourced`-workflow track.

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

## Done in this slice — elixir-vanilla workflow-as-view-source

`view X = <Workflow> where <pred>` now emits on `foundation: vanilla` (closing
the last vanilla workflow gap; **vanilla now matches node/dotnet**).
`src/generator/elixir/vanilla/view-emit.ts` emits a view module that reads the
saga-state `<Wf>State` Ecto schema with the filter (reusing the vanilla
`render-expr` foundation flag — enum → lowercase string column) and projects
`instanceWireShape` (camelCase key ← snake struct field; Jason ISO-encodes
datetimes, so no manual conversion). The project-wide `ViewsController` already
emitted a `run/1` action per view, so before this it referenced a never-emitted
module — this also fixes that latent compile break. Tests:
`test/generator/elixir/vanilla-workflow-view.test.ts` + a `view` on the
`vanilla-channels.ddd` elixir-vanilla-build gate fixture.

## Done — Java saga track (slices 1–3)

The Java saga stack landed in three stacked slices:

1. **Saga-state row** (#1288) — `renderWorkflowStateEntity` / `renderWorkflowStateRepository`
   (`emit/workflow-state.ts`): a JPA `@Entity` (`@EmbeddedId` correlation key,
   `@Enumerated(STRING)` enums) bound to the Flyway-owned `plural(snake(wf.name))`
   table + a Spring Data `JpaRepository` over it.
2. **In-process dispatcher** (#1291) — `renderJavaDispatcher` (`emit/dispatch.ts`):
   a `<Ctx>Dispatcher` `@Component` whose `@EventListener` handlers load-or-allocate
   (event `create`) / route-or-drop (`on`) the saga row, run the body, and
   re-publish via `ApplicationEventPublisher` so choreography chains re-enter.
3. **Instance read endpoints** (this slice) — `renderJavaWorkflowInstanceReads`
   (`emit/workflow-instances.ts`): every observable saga gets a `<Wf>InstanceResponse`
   record + a `<Ctx>WorkflowInstancesController` exposing `GET /api/workflows/<wf>/instances[/{id}]`
   over the saga-state repository (`findAll` / `findById`, 404 via `Optional.orElse(notFound)`),
   projecting `instanceWireShape` (id → `.value()`, the camelCase wire keys the .NET
   `<Wf>InstanceResponse` uses). The `saga.ddd` java-build gate fixture exercises it on
   `gradle testClasses bootJar`. Tests: `test/generator/java/java-workflow-instances.test.ts`.

## Next slices (recommended order)

1. **Java view-over-workflow** — the last Java workflow gap: `view X = <Workflow> where <pred>`.
   `renderJavaViews` currently filters `source.kind === "aggregate"`; add a workflow-source
   path that reads the `<Wf>State` saga row with the filter lowered to a query and projects
   `instanceWireShape`. Reference: python's `views-builder.ts` + `lowerWorkflowFilterToSqlAlchemy`.
2. **elixir-vanilla dispatch** — port the ash-foundation dispatcher to the
   vanilla foundation (raw `Repo.transaction` + `Phoenix.PubSub`).
3. **`eventSourced` workflows (`apply(...)` folds)** — universal gap; design-first
   (`workflow-and-applier.md` A2-S5b). Pairs with the aggregate event-store path.
