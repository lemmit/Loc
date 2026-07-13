# RequestContext — the single ambient context shape

> **Pins [D-CTX-SHAPE](../decisions.md#d-ctx-shape--the-ambient-requestcontext-field-set).**
> Status: design pinned; the carrier is now **emitted on all five backends** —
> .NET, Hono, Phoenix, Java/Spring, and Python/FastAPI (the request-stable tier
> + the root frame's `scopeId`, plus the principal's `actor_id`). Per-dispatch
> frame nesting (`parentId` chaining) and the downstream consumers
> (audit/provenance) remain in progress — see the per-backend table and the
> § Emitted (Phoenix) / § Emitted (Java) / § Emitted (Python) notes below.
> Every governance feature reads the same shape.

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

**Consumer reads emitted today.** Observability reads `correlationId` on every
log line (all five backends), and now also stamps `scope_id` (+ `actor_id` once
auth has run) onto every line emitted inside a request frame — read at log time
from this carrier, so a log line joins to the audit / provenance rows of the
same frame by `scope_id` (see [observability.md](../observability.md)). On **Hono** and **.NET** (the backends with a
provenance/audit runtime): the **provenance** `provenance_records` history
stamps `correlation_id` + `scope_id` + `actor_id` (the design's "who computed" —
the principal's id, sourced from the carrier) on every provenanced write; the
**audit** record stamps `correlation_id` + `scope_id` + the full principal
(`actor`). Both commit in the aggregate's save transaction. The carrier exposes
the actor id as Hono `reqCtx.actorId` / .NET `RequestContext.Current?.ActorId`,
stamped by auth alongside the principal.

**Per-dispatch frames + `parentId` (.NET).** For `parentId` to carry
information, each dispatch must open its own child frame — otherwise every row
in a request reads the root frame (one `scopeId`, null `parentId`). On **.NET**
the `ExecutionContextBehavior` Mediator pipeline behaviour opens a child frame
per dispatch (`OpenChild`, chaining `parentId` to the caller's `scopeId`); this
was previously `--trace`-only and is now emitted/registered whenever
trace **or** audit **or** provenance is present (the logger binding stays
trace-gated *inside* the behaviour). Both `audit_records` and
`provenance_records` then stamp `parent_id = RequestContext.Current?.ParentId`,
so each row records its call-structure position within the request.

On **Hono** a direct operation route runs in the root frame (so its rows carry
a null `parentId`), but a **workflow** is a composite unit: it runs its body
inside a child frame (`runInChildContext`, chaining `parentId` to the request's
root scope) and captures both provenance and audit for the ops it invokes
there. Previously both were silently lost — the per-operation route flushed
`provenance_records` and staged `audit_records`, but a workflow calls operations
inline and never drained their lineage nor staged their audit rows. Now the
workflow flushes each saved aggregate's provenance, and an inline `audited`
op-call stages an `audit_records` row bracketed by before/after wire snapshots
(`repo.toWire`), exactly like the route. Both Hono tables carry the `parent_id`
column, and a workflow's rows chain to the workflow frame.

On **.NET** the picture is asymmetric by construction. The workflow handler is
itself a Mediator dispatch, so `ExecutionContextBehavior` already opens its
child frame (`parentId` set). **Provenance** needs nothing extra: its flush
lives inside `repo.SaveAsync` (drained before `SaveChangesAsync`), so a
workflow's saves capture it for free. **Audit** was the gap — it is staged in
the per-operation command handler (`_audit.Stage`), which a workflow's inline
op-calls bypass. The workflow handler now injects `IAuditWriter` and stages an
`AuditRecord` for each inline `audited` op-call (before/after via
`projectEntityExpr` → `new <Agg>Response(...)`), flushed by the same
`SaveAsync`. So both provenance backends now capture both trails through
workflows.

The same holds for **event-triggered reactors** (`on <Event>` / event-`create`
sagas), which also invoke ops inline. On .NET a reactor is an
`INotificationHandler` dispatched through the Mediator pipeline, so
`ExecutionContextBehavior` opens its frame too; it injects `IAuditWriter` and
stages audit for inline `audited` op-calls exactly like the command handler
(provenance again free via `SaveAsync`). The carrier is fully populated when the
event is dispatched inline (ephemeral channel, within the originating request);
under a durable channel the outbox relay redelivers from a background scope, so
the row records the change but with a fresh root-frame correlation rather than
the original request's. (Hono reactors remain the one uncovered path — their
inline functions don't yet flush provenance or stage audit; that's the next
follow-up.)

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
foundation than under `foundation: nest`.

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
  [`../proposals/execution-context.md`](../old/proposals/execution-context.md)
  § Lowering & generation.

| Platform × foundation | Class | Carrier | Frame open |
|---|---|---|---|
| `node` (minimal / Hono) | ambient | `AsyncLocalStorage<RequestContext>` | `als.run(childFrame, …)` around a tagged boundary |
| `node` + `foundation: nest` | ambient | request-scoped DI provider (`nestjs-cls`, an `AsyncLocalStorage` wrapper) | interceptor/guard at the boundary; the `@nestjs/cqrs` bus is the frame-open seam for command/query handlers (the Mediator-behaviour analog) |
| `.NET` | ambient | **`AsyncLocal<RequestContext>`** — a dedicated slot the backbone owns (the direct `AsyncLocalStorage` twin), surfaced through a scoped `IRequestContext` accessor. **Not** `Activity.Current`: tracing is sampled, so a span is `null` on unsampled requests — governance state must never be sampleable | root + request-stable via boundary middleware; per-boundary child frames via emitted inline `using` scopes — the Mediator behaviour covers only the `Send`-shaped subset (see § Two seams) |
| `elixir` (Phoenix LiveView) | ambient | **`Logger.metadata`** — stamped by a `RequestContext` Plug at the HTTP edge (pure Plug + Logger). *Emitted today* (§ below) | root frame only — opened at the HTTP edge. Per-`with`-step child frames (`parentId` chaining) are deferred |
| `Go` (proposed) | **explicit-threading** | `context.Context` (request-stable in `ctx.Value`; frame-local derived per call) | `ctx := context.WithValue(parent, …)` threaded into every call |
| `java` (Spring MVC) | ambient | **SLF4J `MDC`** (a `ThreadLocal`-backed map, always on the classpath via spring-boot-starter-logging) — stamped by an `ExecutionContextFilter` at the HTTP edge. *Emitted today* (§ Emitted (Java) below). A WebFlux variant would need Reactor `Context` (`ThreadLocal` does not propagate across reactive operators); MVC is what ships | root frame only — opened by the outermost (`HIGHEST_PRECEDENCE`) filter. Per-dispatch child frames (`parentId` chaining) deferred |
| `python` (FastAPI) | ambient | **`contextvars.ContextVar[RequestContext]`** — opened by the outermost `ObservabilityMiddleware`. *Emitted today* (§ Emitted (Python) below). **Subsumes** the pre-existing obs request-id contextvar (one ambient channel, not two): the log line's `request_id` is the carrier's `correlation_id` | root frame only — opened at the HTTP edge. Per-dispatch child frames (`parentId` chaining) deferred |

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

**`Activity`/OpenTelemetry is not part of the backbone.** The carrier is
the dedicated `AsyncLocal` above and the push/restore is the renamed
behaviour's `finally` — there is no role left for `Activity` in the
mechanism, and nothing in the backbone takes an OTel dependency. The
governance `correlationId` is **minted by the backbone**, not adopted
from a `TraceId` (`ActivitySource.StartActivity` returns `null` on
unsampled requests, so trace state is not a place governance can live).
*If* the observability layer later wants to project a frame onto a span
for log↔trace correlation, that is its concern (owned by
[`../proposals/observability.md`](../old/proposals/observability.md), which
already wires `Activity.Current?.TraceId` into log scopes in
`emit/program.ts`) — a one-way read of the frame, never a write governance
reads back, and never via `Baggage` (it serialises to the W3C `baggage`
header, leaking any `currentUser`/`tenantId`/`dataKey` to every downstream
service).

### Two seams — and why a Mediator behaviour is not sufficient alone

Setting the ambient context is **two seams**, not one; the table's *Frame
open* column is only the second. A Mediator pipeline behaviour is the
convenient hook for *part* of the second seam on .NET — not the whole
mechanism.

1. **Boundary establishment** — where the *request-stable* tier is born
   and the **root frame** opened. For HTTP this is **middleware** at the
   request edge (the .NET `UserMiddleware` and the Hono request-id
   middleware are already half of it): `correlationId` from the inbound
   header or freshly minted, `currentUser` from the token, `locale` from
   `Accept-Language`, `startedAt` now. It must be middleware, **not** a
   Mediator behaviour — code that runs *before* dispatch (authorization
   filters, model binding, other middleware) already needs the context,
   and there must be exactly one birthplace. **Non-HTTP entrypoints have
   no such middleware**: a `BackgroundService`/scheduled job, a
   queue/`channelSource` consumer, and the outbox relay each open their
   **own root frame** explicitly — and a consumer takes `correlationId`
   from the *message envelope*, not a fresh mint, so a producer's run and
   its consumer's join up.
2. **Frame open** — the per-boundary push as frames nest (operation →
   workflow → sub-workflow → helper / `domainService` / parallel branch).
   On .NET the **command/query frame** can ride the renamed
   `ExecutionContextBehavior` *because handlers are invoked through
   `Send`* — but that frames only `Send`-shaped boundaries. Boundaries the
   model wants framed that are **not** a `Send` — a `domainService` call,
   a plain helper, a parallel `foreach` branch — get a generator-**emitted
   inline scope** (`using var _ = ctx.EnterScope(...)`, the
   `enterScope`/`exitScope` of `execution-context.md` § Lowering), not the
   behaviour. node/Hono has no Mediator at all: every frame is an emitted
   inline scope inside the boundary `als.run`.

Consequences for the Mediator-behaviour hook specifically: it must be
registered **first** in the pipeline (so authz / validation / audit
behaviours observe the frame), and — because it restores the frame in
`finally` — **work that escapes the `Send` keeps nothing**. An event
emitted in a transaction and relayed later by the outbox must **capture
the frame ids into the persisted record** (`correlationId`/`causationId`),
not read `AsyncLocal` at relay time (see
[`../proposals/dispatch-delivery-semantics.md`](../old/proposals/dispatch-delivery-semantics.md)).
The behaviour is a convenience for one subset on one backend; the carrier,
boundary middleware, and emitted inline scopes are the actual mechanism.

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

## Emitted (Phoenix)

The Phoenix carrier ships today, emitted as a
`<App>.RequestContext` module (pure Plug + `Logger` —
`src/generator/elixir/shell/runtime.ts`).

- **Carrier = `Logger.metadata`.** The BEAM has no `AsyncLocal`; the per-process
  `Logger.metadata` is the idiomatic ambient slot, with the bonus that every
  stamped key rides every structured log line for free.
- **Boundary establishment** — a `RequestContext` Plug mounted at the HTTP edge
  (between `Plug.RequestId` and `Plug.Telemetry`, so the telemetry logs carry
  the ids) stamps the **request-stable tier** (`correlation_id`, `locale`,
  `started_at`) plus the **root frame's `scope_id`**, and echoes
  `X-Correlation-Id` on the response. `correlation_id` resolves from
  `X-Correlation-Id` → `X-Request-Id` → the id `Plug.RequestId` established →
  freshly minted (never a sampled trace id).
- **Principal — `actor_id` only (PII-safe).** After the auth verifier resolves
  the principal, the Auth plug stamps `actor_id` into `Logger.metadata` (the id
  key resolved from the user shape) — the **full principal stays on
  `conn.assigns.current_user`**, never in the log-bearing carrier. This is the
  log-safe realisation of the table's `currentUser.id` row; the richer
  `currentUser` slices (`tenantId`/`permissions`/`dataKey`) are not on the
  Elixir carrier yet.
- **Accessors** (`correlation_id/0`, `scope_id/0`, `parent_id/0`, `actor_id/0`,
  `locale/0`, `started_at/0`) let non-HTTP code read the carrier without a
  `conn`; each returns nil outside a request (and `actor_id` nil before auth /
  under no-auth — the .NET "CurrentUser null until auth" pattern).

**Deferred on Phoenix** (consistent with the table): per-dispatch child frames
(`parent_id` stays nil — the generated app has no Mediator-style pipeline to
chain through), and the audit/provenance consumers (no Elixir audit/provenance
runtime exists yet — once it does, `correlation_id`/`scope_id`/`actor_id` are
already sitting in the carrier for it to read). The `Task.async`/spawn caveat
above applies and is restated in the emitted module's `@moduledoc`.

## Emitted (Java)

The Spring MVC carrier ships today (`src/generator/java/emit/request-context.ts`).
MVC has no `AsyncLocal`; SLF4J **`MDC`** (a `ThreadLocal`-backed map) is the
idiomatic ambient slot, the direct twin of the BEAM's `Logger.metadata`.

- **Boundary establishment** — an `ExecutionContextFilter extends
  OncePerRequestFilter` (named to avoid colliding with Spring's auto-configured
  `requestContextFilter` bean), registered **outermost** (`@Order(Ordered.HIGHEST_PRECEDENCE)`)
  so the context is set before auth / the catalog filter run. It stamps the
  request-stable tier (`correlation_id`, `locale`, `started_at`) + the root
  frame's `scope_id` into MDC, echoes `X-Correlation-Id`, and — being
  outermost — `MDC.clear()`s on the way out so a pooled servlet thread never
  leaks context to the next request. `correlation_id` resolves
  `X-Correlation-Id` → `X-Request-Id` → freshly minted.
- **Principal — `actor_id` only.** After the verifier succeeds, `UserFilter`
  calls `RequestContext.putActorId(String.valueOf(user.<idField>()))` (the id
  key resolved from the user shape: `id`, else the first field). The full
  principal stays on the `CurrentUserAccessor` `ThreadLocal` — only the id
  rides MDC.
- **Accessors** — `RequestContext.correlationId()/scopeId()/parentId()/actorId()/locale()/startedAt()`
  read MDC for non-HTTP callers; null/`0` / `"en"` outside a request.

**Deferred on Java**: per-dispatch child frames (`parent_id`), and surfacing the
ids onto the catalog log lines (the bespoke `CatalogLog` writer bypasses SLF4J,
so MDC is the carrier/seam — not yet echoed onto the obs envelope; that touches
the cross-backend envelope contract and is its own change).

## Emitted (Python)

The FastAPI carrier ships today (`src/generator/python/emit/obs.ts`,
`auth-emit.ts`). This is the **subsume** case the design names: the obs layer
already had a `request_id` `ContextVar` set/reset at the boundary and echoed onto
every log line. Rather than add a second ambient channel, that channel was
**widened into the carrier** — one `contextvars.ContextVar[RequestContext]`, and
the log line's `request_id` is now the carrier's `correlation_id` (the obs
envelope contract is unchanged).

- **Boundary establishment** — `ObservabilityMiddleware` (added last in
  `app/main.py`, so Starlette runs it **outermost** — before auth). It resolves
  the correlation id (`x-correlation-id` → `x-request-id` → minted), opens a
  frozen `RequestContext` (correlation id, a fresh root `scope_id`, `locale` from
  `accept-language`, `started_at`), brackets the request with
  `request_start`/`request_end`, echoes the id on both `x-correlation-id` and
  `x-request-id`, and resets the `ContextVar` on the way out.
- **Principal — `actor_id` only.** After the verifier succeeds, `AuthMiddleware`
  calls `set_actor_id(str(user.<id>))` (id key resolved from the user shape: `id`,
  else the first field), which `replace()`s the frozen context with the actor id.
  The full principal stays on `request.state.current_user` — only the id rides the
  carrier. Auth runs inside the obs middleware, so the context is already open.
- **Accessors** — `correlation_id()`/`scope_id()`/`parent_id()`/`actor_id()`/`locale()`/`started_at()`
  (module functions in `app/obs/log.py`) read the `ContextVar` for non-HTTP
  callers; `None` / `"en"` / `0.0` outside a request.

**Deferred on Python**: per-dispatch child frames (`parent_id` stays `None`), and
surfacing `scope_id`/`actor_id` onto the log lines beyond `request_id` (additive
to the obs envelope — its own change). The `BaseHTTPMiddleware` contextvar-
propagation caveat applies: the carrier is set by the outermost middleware and
read within the request scope, which is the supported path.

## Open (deferred)

- **What `scopeId` denotes** at the outermost frame — HTTP request vs
  workflow vs business transaction. Tracked in `execution-context.md`;
  does not block the field set.
- **Sensitivity clearance as a first-class field** vs derived from
  `permissions`. v1 derives it; promote only if phase-4 sink
  classification needs a distinct axis.
- **Per-tenant locale override** — out of scope; one resolved `locale`
  per flow in v1 (`i18n.md`).
