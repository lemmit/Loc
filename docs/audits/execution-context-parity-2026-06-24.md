# Execution-context backbone — cross-backend parity audit

> **Date:** 2026-06-24. **Method:** code-verified against fresh `origin/main`
> (the emitter `.ts` files, judging the source each emits) — one reader per
> backend, fixed axis template. **Scope:** the runtime execution-context /
> request-context mechanism only (the proposal
> [`../proposals/execution-context.md`](../old/proposals/execution-context.md);
> design pinned **D-CTX-SHAPE** in
> [`../architecture/request-context.md`](../architecture/request-context.md)).
> This audit **confirms** the architecture doc's per-backend realisation
> table — it does not contradict it; it adds the code citations, the
> consumer-wiring check, and a verdict per backend.

## TL;DR — gap #1 fully drained (was two-tier; now uniform)

The **carrier + root frame + id-triad + governance consumers** ship on **all
five backends** — and as of **2026-06-24** so does the **full execution-context
discipline**: per-dispatch **child frames**, real **`parentId` causal
chaining**, and **enter/exit push-restore**. When this audit was taken the
discipline ran on only **two of five** (.NET, node); the three "fields-only"
backends were then drained in three slices on the same day:

> **Python**¹ — a `child_context()` contextmanager + an `in_child_context`
> decorator wrap every dispatch boundary (reactor handlers + the workflow
> route); `parent_id` chains and the log formatter stamps it.
> **Java**² — `RequestContext.openChild()` returns an AutoCloseable `Frame`
> wrapping every boundary in a try-with-resources block (the workflow service
> method + both `@EventListener` reactor variants); `parent_id` chains into the
> audit/provenance rows.
> **Elixir**³ — `with_child_frame/1` (the BEAM has no try-with-resources /
> decorator, so an explicit `Logger.metadata` push + `after`-block restore)
> wraps the workflow `run/1` + both reactor `handle/1` variants.
>
> The **D / E / Verdict** rows of the matrix below read as the **pre-drain**
> snapshot for Java / Elixir / Python; the per-backend detail records each
> drain.

So the honest line is now: **carrier + full child-frame discipline on all five
backends.** What remains of the *backbone proposal* is no longer per-backend
parity (gap #1 is closed) — it's the cross-cutting tail: the build-flag surface
as user options, the `nodeId`/`kind` genealogy, parallel-branch frame copying,
and the `scopeId`-semantics decision.

## The matrix

| Axis | .NET | node / Hono | Java | Elixir | Python |
|---|---|---|---|---|---|
| **A. Carrier** | `AsyncLocal<RequestContext>` | `AsyncLocalStorage<RequestContext>` | SLF4J `MDC` (ThreadLocal) | `Logger.metadata` | `contextvars.ContextVar` |
| **B. id-triad** (`correlationId`/`scopeId`/`parentId`) | ✅ | ✅ | ✅ declared | ✅ declared | ✅ declared |
| **C. Root-frame seam** | boundary middleware **+ non-HTTP fallback** (behaviour opens root when `Current` is null) | HTTP middleware (`als.run`) | `ExecutionContextFilter` (HTTP only) | `RequestContext` Plug (HTTP only) | `ObservabilityMiddleware` (HTTP only) |
| **D. Per-dispatch child frame + enter/exit** | ✅ `OpenChild` + `Enter`/restore per Mediator dispatch | ✅ `runInChildContext` = `als.run(child, …)` | ✅ `openChild()` try-with-resources `Frame` (drained) | ✅ `with_child_frame/1` push + `after`-restore (drained) | ✅ `child_context()` + `in_child_context` (drained) |
| **E. `parentId` chaining** | ✅ child `parentId` ← parent `scopeId` | ✅ child `parentId` ← caller `scopeId` | ✅ chains (drained; was always `null`) | ✅ chains (drained; was always `nil`) | ✅ chains (drained; was always `None`) |
| **F. Consumers wired** (read the ids) | audit + provenance + trace-log | audit + provenance + log mixin | audit + provenance + obs (read) | audit + provenance + log (`metadata: :all`) | audit + provenance + log formatter (incl. `parent_id`) |
| **G. Genealogy tail** (`operationId`/`nodeId`/`kind`/`timestamp`) | `operationId` + `At` on audit rows; no `nodeId`/`kind` | `operationId`/`action`/`at` on rows; no `nodeId`/`kind` | `operationId` on audit only | `operationId` on audit only | none beyond id-triad |
| **H. Parallel/fan-out branches** | siblings share parent (correct) | `for-each` shares scope (sequential — fine) | unhandled (ThreadLocal not copied) | unhandled (`Logger.metadata` not copied into `Task`) | unhandled (relay runs frame-less) |
| **Verdict** | **FULL** | **FULL** | **FULL** (drained) | **FULL** (drained) | **FULL** (drained) |

¹ Python's log formatter stamps `correlation_id`/`scope_id`/`actor_id` but
**not** `parent_id` — harmless today since `parent_id` is always `None`, but
the stamp should be added when child frames land.

## Per-backend detail (code anchors)

### .NET — FULL
- Carrier: `AsyncLocal<RequestContext?>` — `src/generator/dotnet/emit/request-context.ts:99`.
- Child frame: `OpenChild(parent)` sets `ScopeId = Guid.NewGuid()`, `ParentId = parent.ScopeId` (`request-context.ts:132`); pushed via `Enter(frame)` → `IDisposable` restore (`:146`). Driven per Mediator dispatch by `ExecutionContextBehavior`/`DomainLogBehavior` (`emit/domain-log.ts:92`), with an `OpenRoot` fallback when `Current` is null (covers background jobs / outbox relay).
- Consumers: audit (`cqrs/commands.ts`), provenance (`emit/provenance.ts`), trace-log all read `RequestContext.Current?.{ScopeId,ParentId,…}`.
- Only nit: request-log start/end lines surface `correlationId` but not `scopeId` (the logger *scope* carries it downstream).

### node / Hono — FULL
- Carrier: one `AsyncLocalStorage<RequestContext>` (`src/platform/hono/v4/observability-builder.ts:126`).
- Child frame: `runInChildContext` clones the parent with `scopeId: randomUUID()`, `parentId: parent.scopeId`, and re-enters via `requestContextStore.run(child, fn)` (`observability-builder.ts:140`). Called around workflow dispatch + reactor/provenance flush (`workflow-builder.ts:555`, `:1083`).
- Consumers: audit/provenance rows read `reqCtx?.{correlationId,scopeId,parentId}` (`routes-builder.ts`); pino mixin auto-stamps `scope_id`/`actor_id` on every line.

### Java — **FULL** (drained 2026-06-24; was fields-only)
- Carrier: SLF4J `MDC` (ThreadLocal-backed) — `src/generator/java/emit/request-context.ts`.
- Root: `ExecutionContextFilter extends OncePerRequestFilter`, `@Order(HIGHEST_PRECEDENCE)`, mints `scope_id`, `MDC.clear()` in finally.
- **Child frames (NEW):** `RequestContext.openChild()` opens a child MDC frame (fresh `scope_id`, `parent_id ← parentScope`) and returns an AutoCloseable `Frame` whose `close()` (no checked throw) restores the parent — so a `try (var __frame = RequestContext.openChild())` block pops cleanly; a no-op outside a request. Wrapped around the workflow service method (`emit/workflow.ts`) and both reactor variants — plain `@EventListener` (`handlerFn`) and event-sourced (`esHandlerFn`) in `emit/dispatch.ts`. `parent_id` now chains into the audit/provenance rows (which already read `RequestContext.parentId()`).
- Still open (smaller): the **log envelope** doesn't surface `scope_id`/`parent_id` (deferred — touches the cross-backend obs contract); parallel-branch frame copying across `@Async`/pool boundaries (ThreadLocal isn't inherited); MVC-only (WebFlux would need Reactor `Context`).

### Elixir (vanilla) — **FULL** (drained 2026-06-24; was fields-only)
- Carrier: `Logger.metadata` stamped by a `RequestContext` Plug (`src/generator/elixir/shell/runtime.ts`).
- Root: `scope_id = generate_id()` at the HTTP edge.
- **Child frames (NEW):** `with_child_frame/1` — the BEAM has no try-with-resources or decorator, so the child frame is an explicit `Logger.metadata` push (fresh `scope_id`, `parent_id ← caller scope`) + restore in an `after` block (no-op outside a request). Wraps the workflow `run/1` (`vanilla/workflow-execution-emit.ts`), the plain reactor `handle/1` (`dispatch-emit.ts`), and the event-sourced reactor `handle/1` (`vanilla/workflow-eventsourced-emit.ts`). `parent_id` now chains into the audit/provenance rows (which already read `RequestContext.parent_id()`).
- Consumers: audit + provenance read `RequestContext.{correlation_id,scope_id,actor_id,parent_id}`; every log line carries the metadata (`metadata: :all`).
- Still open (smaller): `Logger.metadata` is not inherited by `Task.async`/Oban — a fan-out branch loses the frame and must copy it explicitly (documented caveat, not handled).

### Python (FastAPI) — **FULL** (drained 2026-06-24; was fields-only)
- Carrier: one `RequestContext` `ContextVar` (`src/generator/python/emit/obs.ts`), subsuming the prior obs request-id var.
- Root: `ObservabilityMiddleware` opens the frame with `scope_id=new_id()`, token-reset in finally.
- **Child frames (NEW):** `child_context()` (a contextmanager — fresh `scope_id`, `parent_id ← parent.scope_id`, restored on exit, no-op outside a request) + an `in_child_context` decorator (ParamSpec-typed, `functools.wraps` so FastAPI DI still resolves route params) now wrap every dispatch boundary — both reactor handlers (`dispatch-builder.ts` `handlerFn`/`esHandlerFn`) and the route-invoked workflow (`workflows-builder.ts`). `parent_id` chains to the dispatching request's scope.
- Consumers: audit + provenance read the four ids (`repository-builder.ts`); the log formatter **now stamps `parent_id`** too.
- Still open (smaller): background outbox relay runs frame-less — relay work should re-open a root from the outbox row's captured `correlation_id` (a relay concern, distinct from the per-dispatch chaining just landed).

## The genuine remaining gaps

1. **Per-dispatch child frames + `parentId` chaining — DONE on all five
   backends (2026-06-24).** What was the headline gap at audit time is closed:
   `.NET` (`OpenChild`/`Enter`), node (`runInChildContext`), Python
   (`child_context`/`in_child_context`), Java (`openChild` try-with-resources
   `Frame`), Elixir (`with_child_frame/1`). Every dispatch boundary (workflow
   run + reactor handlers) opens a child frame whose `parentId` chains to the
   caller's `scopeId`, so audit/provenance rows now reconstruct the call tree.
   The items below are the cross-cutting tail, not per-backend parity.
2. **Parallel/fan-out frame propagation** on the three ambient-but-not-copied
   backends (Java `@Async`, Elixir `Task.async`/Oban, Python background relay):
   the frame is process/thread-local and is **not** copied into spawned work.
3. **Genealogy tail** (`nodeId` / `kind`; `operationId` on provenance rows) —
   only the id-triad + `operationId`-on-audit ships anywhere. Per the design
   these richer fields belong on a **scope event**, which no backend emits yet.
4. **Build-flag surface as user-facing options.** `emitProvenance` / `emitTrace`
   exist as *internal* gates derived from field presence (`hono/v4/emit.ts:297`);
   `emitContextBoundaries` / `emitTracing` are not exposed as CLI/build switches.
5. **`scopeId` semantics** (HTTP request vs workflow vs business transaction)
   — the proposal's single most consequential open question, unresolved.
6. **No `Go` / explicit-threading backend** to prove the IR boundary tags are
   realisation-neutral (the strongest test of the design; not built).

## Bottom line

The execution-context backbone was **not** unstarted (the prior tracker claim)
and, at audit time, **not** uniformly complete (a naive reading of "emitted on
all five backends" — the discipline ran on only two). As of 2026-06-24 it **is**
uniform: the carrier + root frame + governance consumers **and** the full
per-dispatch child-frame / `parentId`-chaining / enter-exit discipline ship on
**all five backends** (the three fields-only backends — Python, Java, Elixir —
were drained the same day). What remains of the proposal is no longer
per-backend parity but the cross-cutting tail: the build-flag surface as user
options, the `nodeId`/`kind` scope-event genealogy, parallel-branch frame
copying, and the `scopeId`-semantics decision.
