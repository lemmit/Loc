# RequestContext — the single ambient context shape

> **Pins [D-CTX-SHAPE](../decisions.md#d-ctx-shape--the-ambient-requestcontext-field-set).**
> Status: design pinned; not yet emitted. The first consumer is
> `execution-context.md` (Phase 3.0); every governance feature after it
> reads the same shape.

## Why one shape

Multi-tenancy needs the tenant. Authorization needs the caller and its
data scope. Sensitivity declassification needs the caller's clearance.
i18n needs the locale. Audit needs "who, in which run, under whose
call". Observability needs correlation. Execution-context needs the
frame ids.

If each feature invents its own accessor (`ICurrentUserAccessor`,
`getLocale()`, `currentTenant`, a logging MDC, …) the backends grow N
parallel ambient channels that drift. **Loom emits exactly one ambient
value — `RequestContext` — and every feature reads its slice of it.**
This is the contract that lets execution-context, audit, authorization,
tenancy, sensitivity, i18n, and observability share `correlationId`,
agree on `currentUser`, and link a provenance trace's `parentId` to an
audit record's `parentId` by construction rather than convention.

## The shape

`RequestContext` has two tiers. **Request-stable** fields are set once
when the flow enters (HTTP handler, queue consumer, scheduled job) and
never change for that flow. **Frame-local** fields change every time
the compiler opens a new scope frame (per `execution-context.md`): a
workflow step, a nested aggregate operation, a fan-out branch.

```
RequestContext {
  // ── request-stable (set at the boundary, immutable for the flow) ──
  correlationId : Id            // the whole run; shared by every frame
  currentUser   : CurrentUser   // the authenticated principal (see below)
  locale        : Locale        // resolved request locale (i18n)
  startedAt     : Instant       // flow entry time (audit / observability)

  // ── frame-local (re-derived per scope frame) ──
  scopeId       : Id            // the business boundary this frame owns
  parentId      : Id?           // the frame that invoked this one (null at root)
}

CurrentUser {
  id          : Id
  tenantId    : TenantId        // the `user.tenantId` claim (multi-tenancy)
  permissions : Permission[]    // from the `user {}` claim record (authorization)
  dataKey     : DataKey         // hierarchical data scope (authorization)
  // clearance for sensitivity declassification is derived from
  // permissions; no separate field in v1
}
```

`CurrentUser` **is** the `currentUser` magic identifier from
`authorization.md` — the policy DSL's `currentUser.permissions`,
`currentUser.dataKey`, `currentUser.id` are member accesses on this
exact record, and multi-tenancy's `tenancy by user.tenantId` reads
`currentUser.tenantId`. There is one principal record, not one per
feature.

## Field ownership — who sets it, who reads it

| Field | Set by | Read by |
|---|---|---|
| `correlationId` | boundary middleware (generate if absent / propagate inbound header) | observability (log correlation), audit (record `correlationId`), provenance (trace root), execution-context (frame ids) |
| `scopeId` | execution-context, on each frame open | audit (`scopeId` on record), provenance (which whole a value belongs to) |
| `parentId` | execution-context, = parent frame's `scopeId` | audit + provenance (call-structure linkage) |
| `currentUser.id` | auth middleware (from token) | audit (actor), authorization (gates), provenance (who computed) |
| `currentUser.tenantId` | auth middleware (from `user.tenantId` claim) | multi-tenancy (query filter + write-stamp), authorization (DataKey leftmost) |
| `currentUser.permissions` | auth middleware (from `user {}` claim record) | authorization (operation/view/workflow gates), sensitivity (declassification clearance) |
| `currentUser.dataKey` | auth middleware (from claim) | authorization (`data { reachable when … }` row filter) |
| `locale` | i18n middleware (`Accept-Language` / explicit) | i18n (catalog lookup), error rendering (ProblemDetails `title`) |
| `startedAt` | boundary middleware | audit (timestamp), observability (duration) |

## Frame semantics (from execution-context.md)

One **current** frame per flow. `correlationId` is shared by every
frame; `scopeId`/`parentId` change as frames nest. Parallel branches
each open their **own child frame** sharing the parent's `scopeId` as
their `parentId` and the same `correlationId` — frames are never shared
across concurrent tasks, which is what keeps a fan-out/fan-in trace
well-formed. The request-stable tier is copied by reference into every
child frame.

**Ambient shape vs frame record.** `execution-context.md` lists richer
per-frame fields (`operationId`, `nodeId`, `kind`, `timestamp`) than the
shape above. That is deliberate: the pinned ambient `RequestContext`
(this doc, D-CTX-SHAPE) surfaces only the **governance-relevant** ids
every feature reads — `correlationId`, `scopeId`, `parentId` (plus the
request-stable `currentUser`/`locale`/`startedAt`). The extra fields are
recorded on the emitted **scope event** (the trace/provenance channel),
not carried in the ambient value. The ambient carrier stays small; the
scope event is where the genealogy detail lives.

## Per-backend realisation (target)

The shape is platform-neutral; each backend threads it natively. No
backend re-derives a field another backend computes differently — the
table above is the single source of truth. **The carrier is keyed by
`(platform × foundation)`, not by platform name** (D-REALIZATION-AXES): a
`node` deployable realises the context differently under the minimal
foundation than under `foundation: nest`, exactly as `elixir` does under
`ash` vs `vanilla`.

Two **realization classes** cover every target:

- **Ambient** — the context lives in a per-flow slot the runtime carries
  implicitly (async-local, scoped DI, process metadata). Frame open is
  "push a child frame onto the slot." This is the JS / .NET / BEAM /
  Python shape, and the one the rest of this doc assumes.
- **Explicit-threading** — there is no ambient slot; the context is an
  ordinary value threaded through call signatures. Frame open is "derive
  a child value and pass it down." **Go** is the canonical case
  (`context.Context` is idiomatic *because* it is explicit), and it is a
  different *lowering* shape: the compiler threads a context parameter
  into every generated call site (`render-stmt` / `render-expr` call
  emission), not just the boundary middleware. A backend in this class is
  the real test of the "ambient" framing — see
  [`../proposals/execution-context.md`](../proposals/execution-context.md)
  § Lowering & generation.

| Platform × foundation | Class | Carrier | Frame open |
|---|---|---|---|
| `node` (minimal / Hono) | ambient | `AsyncLocalStorage<RequestContext>` | `als.run(childFrame, …)` around a tagged boundary |
| `node` + `foundation: nest` | ambient | request-scoped DI provider (`nestjs-cls`, an `AsyncLocalStorage` wrapper) | interceptor/guard at the boundary; the `@nestjs/cqrs` bus is the frame-open seam for command/query handlers (the Mediator-behaviour analog) |
| `.NET` | ambient | **`AsyncLocal<RequestContext>`** — a dedicated slot the backbone owns (the direct `AsyncLocalStorage` twin), surfaced through a scoped `IRequestContext` accessor. **Not** `Activity.Current`: tracing is sampled, so a span is `null` on unsampled requests — governance state must never be sampleable | child frame set in a Mediator pipeline behaviour, popped on `using var` |
| `elixir` + `foundation: ash` | ambient | process dictionary / `Logger.metadata`, surfaced into the Ash action context | new frame per Ash action invocation |
| `elixir` + `foundation: vanilla` | ambient | process dictionary / `Logger.metadata` + explicit struct | new frame per `with`-scoped step |
| `Go` (proposed) | **explicit-threading** | `context.Context` (request-stable in `ctx.Value`; frame-local derived per call) | `ctx := context.WithValue(parent, …)` threaded into every call |
| Java / Spring (deferred) | ambient | MVC: `ThreadLocal` / MDC / Micrometer `Observation` (or JDK 21 `ScopedValue`). **WebFlux: Reactor `Context`** (`ThreadLocal` does not propagate across reactive operators) | per-request thread scope, or `contextWrite` on the reactive chain |

**Within the ambient class, the two tiers want two mechanisms — and a
scoped/thread-bound slot alone is not enough for the frame-local tier.**
A per-request *scoped DI service* (`AddScoped<IRequestContext>`) carries
the **request-stable** tier cleanly — set once at the boundary, injected
everywhere. But it is a *single instance per request*, so it cannot
isolate the **frame-local** tier (`scopeId`/`parentId`) across parallel
branches: two `Task.WhenAll` branches resolving the same scoped service
would clobber each other's current frame. The frame-local tier must live
in a **flow-local** slot whose copy-on-write-down-the-async-flow
semantics give each branch its own frame:

- **.NET → `AsyncLocal<T>`, not `ThreadLocal<T>`.** A request hops threads
  across every `await`, so a `ThreadLocal` frame would be lost (or leak
  onto a pooled thread). `AsyncLocal<T>` flows with `ExecutionContext`
  across `await` and `Task` — which is exactly why `Activity.Current` and
  `IHttpContextAccessor` are themselves `AsyncLocal`-backed. The scoped
  `IRequestContext` is a DI-ergonomic *accessor over* the `AsyncLocal`,
  not a substitute for it.
- **node → `AsyncLocalStorage.run`** already copies-on-write down the
  async flow, so parallel branches are isolated for free.
- **BEAM → spawn-time copy** (the `Task.async` caveat below); **Java →
  `ScopedValue`/Reactor `Context`** for the same reason `ThreadLocal`
  fails under `@Async`/WebFlux.

The rule generalises: request-stable may sit in a scoped/DI slot;
frame-local must be flow-local.

**Subsume the existing channel — do not add a second.** The Hono backend
already ships an `AsyncLocalStorage` for the observability request logger
(`requestLogStore`, `src/platform/hono/v4/observability-builder.ts`) plus
a `correlationId`/request id bound by the request-id middleware. The
backbone's whole premise — *one ambient value, every feature reads its
slice* — makes that the seam to **refactor into** the `RequestContext`
carrier: the existing obs ALS *becomes* the `RequestContext` ALS, not a
sibling of it.

On **.NET the groundwork is further along, and the refactor
correspondingly larger** — there are *two* channels to fold, not one. The
backend already emits:

- **`DomainLog.Current`** — a static `AsyncLocal<ILogger?>`
  (`src/generator/dotnet/emit/domain-log.ts`) pushed/popped by
  **`DomainLogBehavior`**, a Mediator pipeline behaviour that saves the
  previous value and restores it in `finally` (so reentrant `Send`s
  stack). That push/restore *shape* is exactly the enter/exit-scope
  mechanism this backbone needs — it just carries a logger today instead
  of the full frame (the convergence below widens it).
- **`ICurrentUserAccessor`** / `HttpContextCurrentUserAccessor`
  (`auth-emit.ts`) — a scoped accessor over `HttpContext.Items["currentUser"]`,
  i.e. a *second* ambient channel for the very principal this doc pins as
  `RequestContext.currentUser`.

The backbone converges these to **one slot and one behaviour**:
`DomainLog.Current` widens to a single `AsyncLocal<RequestContext>` (the
request logger demoted to a *slice* read via `RequestContext.Current`),
and `DomainLogBehavior` is **generalised and renamed** — *not* kept
alongside a new behaviour — to push that frame. Its structure already
fits exactly: set on entry, restore the previous value in `finally` so
reentrant `Send`s stack; only the payload widens from `ILogger` to the
frame, and the work it does widens from "bind logger" to "open scope
frame" (derive child `scopeId`, `parentId` = parent's `scopeId`). Give it
a frame-shaped name — `ExecutionContextBehavior` (or
`RequestContextBehavior`). Keeping *both* `DomainLogBehavior` and a
separate frame behaviour would itself be the two-channel drift this doc
rejects, so it is **one behaviour, renamed, not two**. `ICurrentUserAccessor`
then becomes a thin accessor over `RequestContext.Current.CurrentUser`,
not a parallel scoped service. The elixir `Logger.metadata` already in use
is the same convergence a third time. Growing a second ambient channel
here is the exact drift this doc exists to prevent.

**`Activity`/OpenTelemetry is an export, not the carrier** (see the `.NET`
row). When tracing is on, the frame-open behaviour *may also* start an
`Activity` and copy `correlationId`/`scopeId` onto it as **tags** for
log↔trace correlation and OTel export — but governance never reads back
from it. `ActivitySource.StartActivity` returns **`null`** on unsampled
requests, and the only part of an `Activity` that propagates to child
frames/processes is `Baggage`, which serialises to the W3C `baggage`
header — so a `currentUser`/`tenantId`/`dataKey` stored there would leak
the principal to every downstream service and telemetry sink. The
governance `correlationId` is **minted by the backbone** (and surfaced
onto the span/logs for correlation), not adopted from a sampled
`TraceId`. The `Activity.Current?.TraceId` already wired into log scopes
in `emit/program.ts` stays — as the obs-side correlation tag, not a
governance read.

**BEAM fan-out caveat.** On elixir the process dictionary and
`Logger.metadata` are **not** inherited by `Task.async`/spawned
processes — precisely the parallel-branch case § Frame semantics
describes. The child frame "sharing the parent's `scopeId`" must be
**copied explicitly into the spawned process**; the "copied by reference"
phrasing in § Frame semantics is a within-process heap share only.

**Frontends are out of scope of the carrier.** React/Angular hold no
`RequestContext`; their only tie to the backbone is propagating an
inbound `correlationId` header across the wire boundary (and reading
`locale`). No frame, no ambient slot.

The PlatformSurface lifecycle hooks listed in global-plan §0.3
(`emitAuthGate`, `emitAuditInit`, `emitTenancyFilter`, `emitI18nAdapter`)
each receive the resolved `RequestContext` accessor for their backend;
they do not open their own ambient channel.

## Open (deferred)

- **What `scopeId` denotes** at the outermost frame — HTTP request vs
  workflow vs business transaction. Tracked in `execution-context.md`;
  does not block the field set.
- **Sensitivity clearance as a first-class field** vs derived from
  `permissions`. v1 derives it; promote only if phase-4 sink
  classification needs a distinct axis.
- **Per-tenant locale override** — out of scope; one resolved `locale`
  per flow in v1 (`i18n.md`).
