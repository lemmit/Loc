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

## Per-backend realisation (target)

The shape is platform-neutral; each backend threads it natively. No
backend re-derives a field another backend computes differently — the
table above is the single source of truth.

| Backend | Carrier | Frame open |
|---|---|---|
| Hono / TS | `AsyncLocalStorage<RequestContext>` | `als.run(childFrame, …)` around a tagged boundary |
| .NET | `IRequestContext` scoped service + Mediator behaviour | new frame pushed in a pipeline behaviour |
| Phoenix | process dictionary / `Logger.metadata` + explicit struct | new frame per `with`-scoped step |

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
