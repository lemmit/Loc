# Execution-context backbone — scope frames

> Status: proposal. Not in `ddd.langium`. This is mostly a
> compiler/runtime mechanism with a small surface; it is the shared
> substrate beneath [provenance](./provenance.md),
> [audit](./audit-and-logging.md), and logging.

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
semantic boundary and emits *enter scope* on the way in and *exit
scope* on the way out (in .NET this maps cleanly onto
`Activity`/`ActivitySource` + `ILogger.BeginScope`; `Activity.Current`
is the top of the stack, `Dispose` pops it). It is a *logical* stack,
not a literal runtime one.

Each frame carries:

| Field | Meaning |
|---|---|
| `correlationId` | the whole run / request — shared by every frame in one flow |
| `scopeId` | the logical/business boundary this frame belongs to |
| `parentId` | the frame that invoked this one ("who called me") |
| `operationId` | the step name (which operation/workflow) |
| `nodeId` | this concrete call instance |
| `timestamp`, `kind` | when; `helper` / `workflow-step` / `subworkflow` |

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
- **.NET**: `ActivitySource.StartActivity(...)` per boundary,
  `using var _ = …` for automatic pop, child activity per parallel
  branch. No hard OpenTelemetry dependency — a lightweight internal
  context that mints ids/relations is enough; OTel export is an
  optional channel.
- **Other backends**: an equivalent ambient context (async-local /
  request-scoped) carrying the same five ids.

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
