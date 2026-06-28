# Plan — DEBT-26 workflow backend-parity slices

**Created:** 2026-06-18 · **Status:** living (work through the gap table top-down)

> **Update (2026):** the Ash foundation has been **removed** — `platform: elixir`
> generates Phoenix LiveView on plain Ecto/Phoenix (vanilla is the only foundation;
> `foundation: ash` is now a validation error). The historical `elixir-ash` column
> below is therefore **gone**: every "ships on vanilla, gated/deferred on ash"
> entry now simply ships on the one elixir backend, and the
> `loom.event-sourced-workflow-unsupported` elixir branch no longer needs a
> foundation discriminator. The ash columns/notes are retained as the record of how
> the elixir workflow surface reached parity before Ash was deleted.

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

(elixir = plain Ecto/Phoenix; the historical `elixir-ash` column is removed with
the Ash foundation.)

| Feature | node | dotnet | elixir | python | java |
|---|:--:|:--:|:--:|:--:|:--:|
| command routes | ✓ | ✓ | ✓ | ✓ | ✓ |
| saga-state row | ✓ | ✓ | ✓ | ✓ | ✓ |
| `on`/event-`create` dispatch | ✓ | ✓ | ✓ | ✓ | ✓ |
| instance read endpoints | ✓ | ✓ | ✓ | ✓ | ✓ |
| view-over-workflow | ✓ | ✓ | ✓ | ✓ | ✓ |
| `eventSourced` workflows (`apply`) | ✓ | ✓ | ✓ | ✓ | ✓ |

**`eventSourced` workflows now ship on every DB backend.** The
surface (grammar → `WorkflowIR.eventSourced` / `.appliers`) + emit-only/pure-fold
discipline (A1) landed long ago; the **Hono runtime** was the reference, and the
fan-out to .NET, Python, Java, and **elixir** (plain Ecto/Phoenix) has since landed
(see "Done — eventSourced workflow fan-out" below). An `eventSourced` workflow
persists as an append-only `<wf>_events` stream (reusing the aggregate event
store's table shape + `eventToData`/`rowToEvent`), folds it through its
`apply(...)` blocks on load, and the dispatch handlers append their own emitted
events to the stream (gap-free) and re-publish for choreography. (Historically the
Ash foundation was the lone unsupported host — it had no pure-ES fit, so the fix
was `foundation: vanilla`; with Ash removed that is now the only elixir path.)
Before the gate landed, an ES workflow silently misgenerated as a state-based saga
with the appliers dropped.

Corrections from earlier matrix drift (verified against code): **elixir-vanilla
dispatch already ships** (`index.ts` calls the foundation-agnostic
`emitDispatch(..., "vanilla")`), so it was never a gap. The Java saga track has
landed its saga-state row (#1288), in-process dispatcher (#1291), instance read
endpoints (#1293), and view-over-workflow (#1296) — so **java is now at full
state-based workflow parity with node / dotnet / elixir-vanilla / python**. The
`eventSourced`-workflow track — once the last remaining workflow gap — has now
**fanned out to every backend except elixir-ash** (see below).

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

## Done — eventSourced workflow gate (footgun closed)

`validateEventSourcedWorkflowStorage` (`src/ir/validate/checks/system-checks.ts`)
now hard-errors an `eventSourced` workflow hosted by any backend
(`loom.event-sourced-workflow-unsupported`). Before it, an `eventSourced`
workflow with a correlation field silently emitted a *state-based* saga (state
entity + dispatcher + instance reads + state table) and **dropped its appliers**
— the event-fold semantics vanished. The gate makes the unimplemented feature
fail fast, exactly like the ES-aggregate storage gate. Tests:
`test/ir/workflow-event-sourced-storage.test.ts`.

## Done — eventSourced workflow runtime on Hono (node)

The first backend off the gate. `src/platform/hono/v4/workflow-eventsourced-builder.ts`
(+ the `emitEventSourcedHandlerFn` seam in `workflow-builder.ts`) emits, for an
`eventSourced` workflow: a `<Wf>State` type + `fold<Wf>` / `apply<Wf>` (the
appliers fold against a plain `state` record via `renderTsExpr`'s `thisName`
seam) + `load<Wf>Events` / `append<Wf>Events` over the `<wf>_events` stream,
reusing the aggregate event store's `eventToData` / `rowToEvent`. The dispatch
handlers fold-on-load (create: from-zero; on: drop+`event_unrouted` if the
stream is empty), run the emit-only body, append the workflow's own (folded)
events gap-free, and re-publish every emit for choreography. The migration +
Drizzle schema emit `<wf>_events` (not a state row); `instanceWireShape` is
suppressed for ES workflows (no read-model row). Tests:
`test/generator/typescript/hono-workflow-event-sourced.test.ts`
+ a `generate system → tsc` case on the `build-generated-ts` gate
(`test/e2e/fixtures/ts-build/eventsourced-workflow.ddd`).

## Done — eventSourced workflow fan-out (dotnet / python / java / elixir-vanilla)

The Hono runtime fanned out to every DB backend;
`EVENT_SOURCING_WORKFLOW_BACKENDS` is now `{ node, dotnet, python, java }`, and
the elixir branch accepts `elixir` (plain Ecto/Phoenix — the only foundation now
that Ash is removed; historically this was the `foundation: vanilla` route, with
`ash` rejected for having no pure-ES fit — D-VANILLA-ES-HOME).  Each
backend adapts its aggregate event-store machinery (fold/append repository over
the `<wf>_events` table `MigrationsIR` already derives) + rebinds its dispatcher's
persistence seam (fold-on-load / append-own-events):

- **.NET** — `src/generator/dotnet/workflow-eventsourced-emit.ts`.
- **Python** — `src/generator/python/workflow-eventsourced-emit.ts`.
- **Java** — `src/generator/java/emit/workflow-eventsourced.ts`.
- **elixir-vanilla** — `src/generator/elixir/vanilla/workflow-eventsourced-emit.ts`
  (`emitVanillaEsWorkflowFiles`, dispatched from `vanilla/index.ts`): a plain
  `<Wf>State` fold struct (no Ecto saga schema), a `<Wf>Fold` (`apply_event/2`
  + `from_events/2`), a `<Wf>Stream` (load + gap-free append + Jason codec) over
  the `<wf>_events` `<Wf>EventLog` Ecto schema, and create/`on` handlers that
  fold-on-load (create from-zero; `on` drops + logs `event_unrouted` on an empty
  stream), run the emit-only body, append the workflow's own events gap-free, and
  re-dispatch each emit for choreography. Tests:
  `test/generator/elixir/vanilla-workflow-eventsourced.test.ts`; CI compile gate
  via `test/e2e/fixtures/elixir-vanilla-build/vanilla-eventsourced-workflow.ddd`
  (`elixir-vanilla-build.yml`). Foundation-aware gate coverage in
  `test/ir/workflow-event-sourced-storage.test.ts`.

## Done — eventSourced-workflow instance reads (fold-on-load)

`GET /workflows/<wf>/instances[/{id}]` now ships for `eventSourced` workflows on
all 5 ES backends (node / dotnet / python / java / elixir-vanilla) — the same
read surface state-based sagas already had, projecting the same
`instanceWireShape`. Design: **enrich the shape, branch the body.**
`enrichWorkflowInstanceShape` (`src/ir/enrich/enrichments.ts`) dropped its
`|| wf.eventSourced` short-circuit, so an ES workflow with a correlation field +
state fields now carries `instanceWireShape` from the same pure
`wireFieldsForWorkflow` (no new IR field — the read body branches on the existing
`wf.eventSourced`). Each backend's instance emitter branches the **read body**:
**LIST** loads all `<wf>_events` ordered by `(stream_id, version)`, groups by
`stream_id`, and folds each stream (mirroring that backend's own ES-aggregate
`findAll`); **byId** loads + folds a single stream (reusing the dispatch-handler
machinery), 404 on an empty stream. operationIds + route paths come unchanged
from `src/ir/util/openapi-ids.ts`, so cross-backend OpenAPI parity holds by
construction; no migration change (`<wf>_events` already emitted). Stateless
(non-correlated) workflows still get no instance read surface. Tests:
`test/ir/workflow-instance-shape.test.ts` (enrich) + the per-backend
`*-workflow-instances` / ES-workflow generator suites. (Historically `elixir+ash`
was out of scope — no pure-ES fit; with Ash removed, elixir = plain Ecto/Phoenix
is in scope.)

## Done — eventSourced-workflow instance _views_ (`view X = <Workflow> where …`)

Now ships on all 5 backends. Each per-backend view emitter branches on
`wf.eventSourced` and reads the fold-projected ES instance read-model (group-fold
the `<wf>_events` stream + apply the view's `where` predicate in-memory) instead
of the saga-state table that ES workflows don't have; the non-ES (state-based)
view path is byte-identical. Emitters: `src/platform/hono/v4/view-routes-builder.ts`
(`emitWorkflowViewRoute`), `src/generator/dotnet/view-emit.ts`
(`renderWorkflowViewHandler`), `src/generator/elixir/vanilla/view-emit.ts`
(`renderVanillaWorkflowView` → `<Wf>Stream.list_instances/0` + `Enum.filter`),
`src/generator/python/views-builder.ts` (`workflowViewRoute`),
`src/generator/java/emit/view.ts`. Tests: the ES-path assertions in each
`*-workflow-view.test.ts`; build-gate coverage via the two ES-workflow views in
`test/e2e/fixtures/elixir-vanilla-build/vanilla-eventsourced-workflow.ddd`.

## Next slices (recommended order)

1. **Scaffold instance _pages_ for ES workflows** — the opt-in scaffold instance
   list/detail pages (already available for state sagas) over the ES read API.
