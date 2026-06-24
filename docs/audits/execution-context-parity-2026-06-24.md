# Execution-context backbone — cross-backend parity audit

> **Date:** 2026-06-24. **Method:** code-verified against fresh `origin/main`
> (the emitter `.ts` files, judging the source each emits) — one reader per
> backend, fixed axis template. **Scope:** the runtime execution-context /
> request-context mechanism only (the proposal
> [`../proposals/execution-context.md`](../proposals/execution-context.md);
> design pinned **D-CTX-SHAPE** in
> [`../architecture/request-context.md`](../architecture/request-context.md)).
> This audit **confirms** the architecture doc's per-backend realisation
> table — it does not contradict it; it adds the code citations, the
> consumer-wiring check, and a verdict per backend.

## TL;DR — a two-tier reality

The **carrier + root frame + id-triad + governance consumers** ship on **all
five backends**. The **full execution-context discipline** — per-dispatch
**child frames**, real **`parentId` causal chaining**, and **enter/exit
push-restore** — ships on **two of five** (.NET, node/Hono). On Java, Elixir,
and Python the per-dispatch child frame is **explicitly deferred**: a single
root `scopeId` per request, `parentId` always null/nil, the id-triad carried
and stamped onto audit/provenance rows but never nested.

So "execution-context is emitted on all five backends" is true of the
**carrier**, and overstated if read as "the full frame discipline runs
everywhere." The honest line is: **carrier everywhere; full child-frame
discipline on .NET + node; request-stable + root-frame-only on Java / Elixir /
Python.**

## The matrix

| Axis | .NET | node / Hono | Java | Elixir | Python |
|---|---|---|---|---|---|
| **A. Carrier** | `AsyncLocal<RequestContext>` | `AsyncLocalStorage<RequestContext>` | SLF4J `MDC` (ThreadLocal) | `Logger.metadata` | `contextvars.ContextVar` |
| **B. id-triad** (`correlationId`/`scopeId`/`parentId`) | ✅ | ✅ | ✅ declared | ✅ declared | ✅ declared |
| **C. Root-frame seam** | boundary middleware **+ non-HTTP fallback** (behaviour opens root when `Current` is null) | HTTP middleware (`als.run`) | `ExecutionContextFilter` (HTTP only) | `RequestContext` Plug (HTTP only) | `ObservabilityMiddleware` (HTTP only) |
| **D. Per-dispatch child frame + enter/exit** | ✅ `OpenChild` + `Enter`/restore per Mediator dispatch | ✅ `runInChildContext` = `als.run(child, …)` | ❌ deferred (no `parentId` write) | ❌ deferred (no child frames) | ❌ deferred (no `open_context` in handlers) |
| **E. `parentId` chaining** | ✅ child `parentId` ← parent `scopeId` | ✅ child `parentId` ← caller `scopeId` | ❌ always `null` | ❌ always `nil` | ❌ always `None` |
| **F. Consumers wired** (read the ids) | audit + provenance + trace-log | audit + provenance + log mixin | audit + provenance + obs (read) | audit + provenance + log (`metadata: :all`) | audit + provenance + log formatter¹ |
| **G. Genealogy tail** (`operationId`/`nodeId`/`kind`/`timestamp`) | `operationId` + `At` on audit rows; no `nodeId`/`kind` | `operationId`/`action`/`at` on rows; no `nodeId`/`kind` | `operationId` on audit only | `operationId` on audit only | none beyond id-triad |
| **H. Parallel/fan-out branches** | siblings share parent (correct) | `for-each` shares scope (sequential — fine) | unhandled (ThreadLocal not copied) | unhandled (`Logger.metadata` not copied into `Task`) | unhandled (relay runs frame-less) |
| **Verdict** | **FULL** | **FULL** | **fields-only** | **fields-only** | **fields-only** |

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

### Java — fields-only
- Carrier: SLF4J `MDC` (ThreadLocal-backed) — `src/generator/java/emit/request-context.ts:26`.
- Root: `ExecutionContextFilter extends OncePerRequestFilter`, `@Order(HIGHEST_PRECEDENCE)`, mints `scope_id`, `MDC.clear()` in finally (`request-context.ts:114`).
- **`parentId` never written** — the filter sets `CORRELATION_ID`/`SCOPE_ID`/`LOCALE`/`STARTED_AT` only; `parentId()` reads an MDC slot nothing populates (`request-context.ts:52` comment: "no per-dispatch nesting yet"). Audit/provenance read it and get `null`.
- Hazards: ThreadLocal leaks across `@Async`/pool boundaries; MVC-only (WebFlux would need Reactor `Context`).

### Elixir (vanilla) — fields-only
- Carrier: `Logger.metadata` stamped by a `RequestContext` Plug (`src/generator/elixir/shell/runtime.ts:173`).
- Root only: `scope_id = generate_id()`; `parent_id` accessor hard-returns the unset metadata key (`nil`). Comment (`runtime.ts:165`): per-dispatch child frames deferred — "the BEAM has no per-dispatch pipeline in the generated app."
- Consumers: audit + provenance read `RequestContext.{correlation_id,scope_id,actor_id,parent_id}` (`vanilla/audit-emit.ts:159`, `vanilla/provenance-emit.ts:199`); every log line carries the metadata (`metadata: :all`).
- Hazard: `Logger.metadata` is not inherited by `Task.async`/Oban — fan-out loses the frame (documented caveat, not handled).

### Python (FastAPI) — fields-only
- Carrier: one `RequestContext` `ContextVar` (`src/generator/python/emit/obs.ts:76`), subsuming the prior obs request-id var.
- Root: `ObservabilityMiddleware` opens the frame with `scope_id=new_id()`, token-reset in finally (`obs.ts:214`).
- **No child frames** — `open_context`/`reset_context` appear only in the middleware, never in event dispatch / workflow / outbox relay (`dispatch-builder.ts`); `parent_id` always `None`.
- Consumers: audit + provenance read the four ids (`repository-builder.ts:860`, `:1024`); log formatter stamps all but `parent_id`.
- Background outbox relay runs with **no** frame (frame-less) — relay work should re-open a root from the outbox row's captured `correlation_id`.

## The genuine remaining gaps (what "PARTIAL" means)

1. **Per-dispatch child frames + `parentId` chaining on Java / Elixir / Python.**
   The carrier is in place on all three; what's missing is opening a child
   frame at each boundary (operation / command-query dispatch / workflow step)
   and chaining `parentId ← caller scopeId`. Today these three emit a flat
   request: every audit/provenance row in one request shares the root
   `scopeId` and a null `parentId`, so the call tree is not reconstructable
   from the governance tables. This is the headline parity gap.
   - Java seam: write `MDC.put(PARENT_ID, …)` + restore around dispatch.
   - Elixir seam: a `with`-step child frame (push/restore `Logger.metadata`).
   - Python seam: `open_context(child)` / `reset_context(token)` in handlers.
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

The execution-context backbone is **not** unstarted (the prior tracker claim)
and **not** uniformly complete (a naive reading of "emitted on all five
backends"). It is **`PARTIAL`, two-tier**: a fully-wired carrier + root frame +
governance consumers on all five, with the distinguishing
child-frame/chaining/enter-exit discipline live on **.NET and node** and
**deferred** on **Java, Elixir, Python**. Closing gap #1 across those three is
what would make the backbone uniform.
