# Execution-context backbone — scope frames

> Status: **runtime backbone COMPLETE across all five backends** (2026-06-24
> code-verified; full matrix in
> [`../audits/execution-context-parity-2026-06-24.md`](../../audits/execution-context-parity-2026-06-24.md);
> the architecture carrier doc,
> [`../architecture/request-context.md`](../../architecture/request-context.md),
> pins **D-CTX-SHAPE**). By design there is **no `ddd.langium` surface** —
> context boundaries are emitted structurally from constructs Loom already
> has, not annotated (see § Surface). The **carrier + root frame + id-triad
> (`correlationId`/`scopeId`/`parentId`) + governance consumers (audit /
> provenance / logging) AND the full per-dispatch discipline — child frames +
> `parentId` chaining + enter/exit push-restore — now ship on all five
> backends**: `.NET` (`AsyncLocal`; `OpenChild`/`Enter`-restore), node/Hono
> (`AsyncLocalStorage`; `runInChildContext`), Python (`ContextVar`;
> `child_context`/`in_child_context`), Java (MDC; `openChild()`
> try-with-resources `Frame`), Elixir (`Logger.metadata`; `with_child_frame/1`
> push + `after`-restore). The three fields-only backends (Python, Java,
> Elixir) were drained 2026-06-24, so every dispatch boundary (workflow run +
> reactor handlers) now opens a child frame whose `parentId` chains to the
> caller's scope. What remains is **not** per-backend parity but the
> cross-cutting tail: (1) exposing the build-flag surface below as
> **user-facing** options (today derived internally from field presence, not a
> CLI/build switch); (2) the scope-event genealogy (`operationId` ships on
> audit records; `nodeId`/`kind`/`timestamp` do not); (3) parallel-branch frame
> copying across the ambient backends; and (4) the open `scopeId`-semantics
> decision. This is the shared substrate beneath
> [provenance](./provenance.md), [audit](./audit-and-logging.md), and
> logging.

## Problem

"Where did this value come from?" and "who did what?" both need to know
the **call context** a computation ran inside: which operation, which
workflow, which run, which parent invocation. Tracking every
instruction is the wrong granularity; the right boundaries are the ones
Loom already names — operations, workflows, sub-workflows, and the
helper/function calls between them. A helper you can't see inside is an
**atom**: keep only its name, inputs, and output. The question that
drove the thread: can this be added later, or must the compiler emit
context boundaries from the start? Conclusion: **the compiler must own
boundary emission**; provenance/audit/logging are then thin consumers.

## The model

A logical **stack of context frames**. The compiler recognises a
semantic boundary and emits *enter scope* on the way in and *exit scope*
on the way out — concretely, a push/restore around the boundary (the
ambient slot is set to a child frame on entry and restored in `finally`),
so nested and reentrant calls stack. It is a *logical* stack: the "stack"
is the frames' own `parentId` chain, not a literal runtime object.

Each frame carries:

| Field | Meaning |
|---|---|
| `correlationId` | the whole run / request — shared by every frame in one flow |
| `scopeId` | the logical/business boundary this frame belongs to |
| `parentId` | the frame that invoked this one ("who called me") |
| `operationId` | the step name (which operation/workflow) |
| `nodeId` | this concrete call instance |
| `timestamp`, `kind` | when; `helper` / `workflow-step` / `subworkflow` |

> **Ambient shape vs frame record.** The pinned ambient `RequestContext`
> (D-CTX-SHAPE,
> [`../architecture/request-context.md`](../../architecture/request-context.md))
> surfaces only the **governance-relevant** subset every feature reads
> ambiently — `correlationId`, `scopeId`, `parentId` (plus the
> request-stable `currentUser`/`locale`/`startedAt`). The richer fields
> above (`operationId`, `nodeId`, `kind`, `timestamp`) are recorded on
> the emitted **scope event** — the trace/provenance channel — not
> carried in the value features read ambiently. Keep the two lists
> distinct: the ambient carrier stays small; the scope event holds the
> genealogy detail.

The two axes that are easy to conflate:

- **`parentId`** is *call structure* — who invoked me.
- **`scopeId`** is *business boundary* — which whole I belong to.

A workflow that calls another workflow: from the parent's view the
child is a single atomic node (`kind: subworkflow`), but the child
opens its own frame and may build its own internal provenance graph —
two layers, linked by `parentId`.

### Parallelism

One *current* frame per flow. Parallel branches each open their **own
child frame** sharing the same `parentId`/`correlationId`; never share
one frame object across tasks. This is what makes a fan-out/fan-in
attributable.

## Surface

There is **no per-field keyword** for this layer — context boundaries
are emitted structurally from the constructs Loom already has
(`operation`, `workflow`, function calls, parallel branches). What the
source thread was firm about: *emission is a compiler option, not a
field annotation* (`emitProvenance` as a field marker was explicitly
rejected). So the only surface is build-level configuration:

```
# conceptual build flags (compiler options, not DSL keywords)
emitContextBoundaries   # master switch — inject enter/exit scope
emitProvenance          # build provenanced lineage nodes on boundaries
emitTracing             # build the runtime event timeline
```

When emission is off, `startScope()` returns a null/no-op handle, so a
build with tracing disabled pays nothing.

## Lowering & generation

- **IR**: boundary nodes (operation entry, workflow entry, sub-workflow
  call, parallel branch) are tagged in the IR walk.
- **Lowering** inserts `enterScope(...)` / `exitScope()` (or the
  platform equivalent) around tagged boundaries and threads the frame
  into provenance-node / audit-record / log-scope construction.
- **.NET**: the governance carrier is a **dedicated `AsyncLocal<RequestContext>`**
  (the `AsyncLocalStorage` twin), surfaced via a scoped `IRequestContext`
  accessor for DI ergonomics; the frame-local tier *must* be `AsyncLocal`,
  not a scoped singleton (which cannot isolate parallel branches) and not
  `ThreadLocal` (which is lost across `await`). Establishment is **two
  seams** (see [`../architecture/request-context.md`](../../architecture/request-context.md)
  § Two seams): boundary **middleware** births the request-stable tier and
  the root frame (HTTP), or a non-HTTP entrypoint opens a root explicitly;
  the per-boundary `enterScope`/`exitScope` pushes above lower to emitted
  inline `using` scopes, and the **command/query** subset can ride a
  Mediator pipeline behaviour (`DomainLogBehavior` generalised and renamed,
  e.g. `ExecutionContextBehavior`, widening its payload from `ILogger` to
  the frame). The behaviour is a convenience for `Send`-shaped frames, not
  the whole mechanism. Either way: no `Activity`/`ActivitySource` and no
  OpenTelemetry dependency. The backbone mints its own ids; whether the
  **observability** layer later *projects* a frame onto an OTel span is its
  concern, owned by [`observability.md`](./observability.md), not a
  component of (or dependency of) this backbone.
- **Other backends** divide into two *realization classes* (see the
  table in
  [`../architecture/request-context.md`](../../architecture/request-context.md)
  § Per-backend realisation):
  - **Ambient** (node/Hono `AsyncLocalStorage`, node/`nest` request-scoped
    DI, elixir process dictionary, Java/Spring MVC `ThreadLocal`, Python
    `contextvars`) — a per-flow slot the runtime carries implicitly;
    `enterScope`/`exitScope` push/pop a child frame on it. Realisation is
    **foundation-sensitive**: on elixir the frame-open seam is the
    `vanilla` foundation's `with`-block step (the Ash foundation was
    removed — `foundation: ash` is now a validation error), and on node it
    differs under the minimal foundation (middleware) vs `foundation: nest`
    (interceptor / `@nestjs/cqrs` handler). On the BEAM
    the child frame must be **copied explicitly into a spawned `Task`** —
    process state is not inherited across the fan-out.
  - **Explicit-threading** (**Go** `context.Context`; Java/Spring WebFlux
    Reactor `Context`) — there is no ambient slot. The context is an
    ordinary value and the compiler threads a context *parameter* into
    every generated call site (operation / repo / workflow /
    domain-service calls in `render-stmt`/`render-expr`), deriving a child
    value at each boundary instead of pushing onto an ambient stack. This
    is a distinct *lowering* shape, and the strongest test that the IR's
    boundary tags are realisation-neutral — a Go target carries
    context-threading as a structural pivot on a par with
    errors-as-values and no-classes (see
    [`go-backend.md`](./go-backend.md)).

When emission is off, the ambient class returns a null/no-op handle and
the explicit-threading class threads a no-op context (request id /
cancellation only), so a tracing-off build pays nothing on either.

## Why a shared backbone

`provenanced`, `audited`, and `logged` (see the other docs) each need
"which operation, which run, which parent". Defining one frame model
means:

- a provenance trace's `parentId` and an audit record's `parentId` are
  the *same* id, so lineage and audit are joinable;
- `correlationId` ties a request's logs, audit entries, and value
  lineage into one timeline;
- there is exactly one place to decide what `scopeId` means.

## Open questions

- **What `scopeId` denotes** (HTTP request vs workflow vs business
  transaction) is the single most consequential decision and is left to
  the system author / configuration.
- Whether provenance is *reconstructed* from a trace timeline (needs a
  strict trace discipline + log analysis) or recorded directly as
  genealogy. The docs here assume **direct genealogy** with the trace
  timeline as an independent, optional channel.
- Whether to attach a CST/code snapshot of each operation to its
  frame, or rely solely on the provenance snapshot artefact.
