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
| view-over-workflow | ✓ | ✓ | (Ash defer) | ✓ | ✓ | ✓ |
| `eventSourced` workflows (`apply`) | — | — | — | — | — | — |

Corrections from earlier matrix drift (verified against code): **elixir-vanilla
dispatch already ships** (`index.ts` calls the foundation-agnostic
`emitDispatch(..., "vanilla")`), so it was never a gap. The Java saga track has
landed its saga-state row (#1288), in-process dispatcher (#1291), instance read
endpoints (#1293), and view-over-workflow (this slice) — so **java is now at full
workflow parity with node / dotnet / elixir-vanilla / python**. The **only
remaining workflow gap across all backends is the universal `eventSourced`-workflow
track**.

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

## Done — Java saga track (slices 1–4, full workflow parity)

The Java saga stack landed in four stacked slices:

1. **Saga-state row** (#1288) — `renderWorkflowStateEntity` / `renderWorkflowStateRepository`
   (`emit/workflow-state.ts`): a JPA `@Entity` (`@EmbeddedId` correlation key,
   `@Enumerated(STRING)` enums) bound to the Flyway-owned `plural(snake(wf.name))`
   table + a Spring Data `JpaRepository` over it.
2. **In-process dispatcher** (#1291) — `renderJavaDispatcher` (`emit/dispatch.ts`):
   a `<Ctx>Dispatcher` `@Component` whose `@EventListener` handlers load-or-allocate
   (event `create`) / route-or-drop (`on`) the saga row, run the body, and
   re-publish via `ApplicationEventPublisher` so choreography chains re-enter.
3. **Instance read endpoints** (#1293) — `renderJavaWorkflowInstanceReads`
   (`emit/workflow-instances.ts`): every observable saga gets a `<Wf>InstanceResponse`
   record + a `<Ctx>WorkflowInstancesController` exposing `GET /api/workflows/<wf>/instances[/{id}]`
   over the saga-state repository (`findAll` / `findById`, 404 via `Optional.orElse(notFound)`),
   projecting `instanceWireShape` (id → `.value()`, the camelCase wire keys the .NET
   `<Wf>InstanceResponse` uses).
4. **View-over-workflow** (this slice) — `renderJavaViews` (`emit/view.ts`) gains a
   workflow-source path: a `view X = <Workflow> where <pred>` emits a `<View>Row` record
   over the saga's `instanceWireShape` and a `<Ctx>Views` method that reads the saga-state
   repository, **filters in-memory** (the predicate renders to a Java boolean over the state
   accessors via `renderJavaExpr` with `accessorProps` — `x.status() == Enum.V`, string
   equality through `Objects.equals`), and projects each row, routed under `/api/views`
   alongside aggregate views. Tests: `test/generator/java/java-workflow-view.test.ts`; the
   `saga.ddd` java-build gate fixture carries a workflow view, so both slices 3 & 4 compile
   on `gradle testClasses bootJar`.

## Next slices (recommended order)

1. **elixir-vanilla dispatch** — port the ash-foundation dispatcher to the
   vanilla foundation (raw `Repo.transaction` + `Phoenix.PubSub`).
2. **`eventSourced` workflows (`apply(...)` folds)** — the only remaining workflow
   gap across all backends; design-first (`workflow-and-applier.md` A2-S5b). Pairs
   with the aggregate event-store path.
