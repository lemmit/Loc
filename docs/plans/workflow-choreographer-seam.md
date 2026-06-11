# Plan — the `WorkflowChoreographer` seam

**Status:** proposed (design + pilot). Tracks finding #4 of
[`docs/audits/architecture-review-2026-06.md`](../audits/architecture-review-2026-06.md).

## Problem

Workflow code generation is the worst-duplicated concern across the five
backends. Each re-implements the same statement-sequence "choreography" — a
switch over the 10-kind `WorkflowStmtIR` union, in declaration order, collecting
deferred saves and emitted events, recursing into `for-each` bodies — and then
renders each arm in its own idiom.

Measured (`wc -l`, not estimated):

| Backend | Workflow emitter | Statement switch |
|---|---|---|
| .NET | `src/generator/dotnet/workflow-emit.ts` | 1187 LOC (`renderStatement`) |
| Hono/TS | `src/platform/hono/v4/workflow-builder.ts` | 1122 LOC (`renderStmt`) |
| Elixir | `src/generator/elixir/workflow-emit.ts` | 577 LOC (`renderWorkflowStmt`) |
| Java | `src/generator/java/emit/workflow.ts` | 357 LOC (`renderWorkflowStmt`) |
| Python | `src/generator/python/workflows-builder.ts` | 251 LOC (`renderWorkflowStmt`) |

The **iteration order and branching logic are structurally identical** across
all five; only the per-arm rendering and a handful of structural decorations
diverge. Critically, the workflow emitters do **not** reuse the existing
`render-stmt.ts` seam — that handles aggregate *operation* bodies (the disjoint
`StmtIR` union), so the workflow spine is genuinely un-shared today. Expression
rendering *is* already delegated (each arm calls the backend's
`renderExprWith` leaf), so the spine is the only thing left to extract.

## Why this is tractable — precedent

Loom already has two seams of exactly this shape, both byte-identical-gated:

- **`ExprTarget`** (`src/generator/_expr/target.ts`): `renderExprWith(e, target,
  ctx)` owns the 17-arm `ExprIR.kind` dispatch + recursion; each backend supplies
  a leaf table (`TS_TARGET` / `CS_TARGET` / `ELIXIR_TARGET` / `PY_TARGET` /
  `JAVA_TARGET`). A new `ExprIR.kind` is a compile error until every backend fills
  it.
- **`WalkerTarget`** (`src/generator/_walker/target.ts`): shared `walkBody`
  engine + per-framework leaf seams.

`WorkflowChoreographer` is the third instance of the same pattern, one layer up:
the dispatch is over `WorkflowStmtIR.kind` instead of `ExprIR.kind`.

## Design

A new shared module `src/generator/_workflow/choreographer.ts`:

```ts
// Owns the spine: iteration, the 10-arm WorkflowStmtIR dispatch,
// save/emit collection, and for-each recursion. Calls the target for
// every leaf. Mirrors renderExprWith.
export function renderWorkflowBody<Ctx>(
  wf: WorkflowIR,
  target: WorkflowTarget<Ctx>,
  ctx: Ctx,
): string[];
```

```ts
export interface WorkflowTarget<Ctx> {
  readonly platform: string;

  // --- per-statement leaves (one per WorkflowStmtIR.kind) ----------------
  // Each returns the rendered lines for that statement in the backend's
  // idiom. Expression sub-nodes are rendered by the backend's own
  // renderExprWith leaf, so these never re-resolve.
  renderPrecondition(s, ctx): string[];   // guard → early failure
  renderRequires(s, ctx): string[];       // auth guard → early failure
  renderEmit(s, ctx): string[];           // collect/broadcast a domain event
  renderFactoryLet(s, ctx): string[];     // create aggregate + bind
  renderRepoLet(s, ctx): string[];        // load/find + bind
  renderExprLet(s, ctx): string[];        // arbitrary expr + bind
  renderRepoRun(s, ctx): string[];        // retrieval → array bind
  renderOpCall(s, ctx): string[];         // invoke op on a bound aggregate
  renderResourceCall(s, ctx): string[];   // resource op (Phase 4)

  // --- structural seams (the divergence axes) ----------------------------
  // for-each: spine recurses to render the body, hands the target the
  // pre-rendered inner lines + the per-iteration saves; target supplies
  // the loop syntax (`for (const x of xs)` / `Enum.each` / `foreach`).
  // Mirrors WalkerTarget.renderMatch taking pre-rendered arms.
  renderForEach(s, renderedBody: string[], ctx): string[];

  // Wrap the whole rendered body in the backend's transaction construct
  // when wf.transactional — `db.transaction(tx => …)` / `Ash.transaction`
  // / `BeginTransactionAsync` / declarative no-op for Spring @Transactional.
  wrapTransaction(wf: WorkflowIR, body: string[], ctx): string[];

  // Emit the collected events after saves (or no-op for backends that
  // broadcast inline at the emit site, e.g. Elixir PubSub).
  renderEventDispatch(events: EmitStmt[], ctx): string[];

  // Render the deferred saves (savesAtExit / a for-each's savesPerIteration).
  renderSaves(saves: SaveRef[], ctx): string[];

  // Tail-position success return for wf.returnType.
  renderReturn(wf: WorkflowIR, ctx): string[];
}
```

### Split of responsibility

**Shared spine owns** (deleted from every backend):
- the `for (const st of wf.statements)` walk in declaration order
- the 10-arm `switch (st.kind)` dispatch
- `for-each` recursion (render body, then `target.renderForEach`)
- save/emit *collection* (which aggregates are dirty, which statements emit)
- the assembly order: `[params] → wrapTransaction([body + saves + dispatch]) →
  return`

**Per-backend leaf keeps** (genuinely idiom-specific):
- every arm's output syntax (throw vs raise vs `{:error, _}`, assignment forms,
  call syntax) — these already lean on the backend's `renderExprWith` for the
  expression parts
- transaction construct (`wrapTransaction`)
- event-dispatch timing/mechanism (`renderEventDispatch`)
- async/await vs sync — baked into each leaf's strings, not a seam
- error/guard idiom — baked into `renderPrecondition` / `renderRequires`

### What this is NOT

- Not a unification of the *output* — generated code stays idiomatic per
  ecosystem, exactly like the `ExprTarget` outputs do.
- Not a re-resolution layer — expressions are already resolved in the IR; the
  choreographer never re-walks expression names.
- Not forcing Elixir's `with`-chain into the linear spine (see Risks).

## Pilot

The chosen approach is **design → prove on one pair → then roll out**.

**Recommended pilot pair: Hono/TS + Python.** Rationale:
- Both are `async/await`, so their spines are the closest of any pair — the
  cleanest first extraction, lowest risk of the abstraction leaking.
- They still differ on the transaction axis (Hono wraps in a
  `db.transaction(tx => …)` callback; Python relies on request-scoped session
  commit, no explicit wrap), so the pilot genuinely exercises `wrapTransaction`
  rather than trivially agreeing on it.
- Both throw domain errors and collect events into a workflow-scoped list, so
  `renderEventDispatch` / guard leaves prove out on aligned semantics first.

> Note: the appetite question floated ".NET + Python" as an example. I recommend
> Hono+Python instead for the *first* pilot because .NET's workflow emitter is
> the largest (1187 LOC) and carries a transaction/state-machine shape that is
> the riskiest, not the cleanest, place to validate a brand-new abstraction.
> .NET is the ideal *third* adopter (it stress-tests `wrapTransaction` hardest),
> not the pilot. Easy to switch if you'd rather.

**Pilot gate (must stay byte-identical):**
- `npm test` workflow generator suites for both backends
- `LOOM_TS_BUILD=1` (Hono tsc) and `python-build.yml`'s build
- a diff of generated workflow files for every `examples/` + `web/src/examples/`
  `.ddd` against the pre-refactor output (capture baseline first)

**Success criteria:** the two backends' workflow statement switches are deleted
in favour of `renderWorkflowBody` + two `WorkflowTarget` leaf tables, generated
output is byte-identical, and the extracted shared spine is < ~250 LOC.

## Rollout order (after the pilot proves out)

1. **Hono/TS + Python** — pilot (closest spines).
2. **Java** — adds the sync axis (`wrapTransaction` becomes a near no-op behind
   Spring's declarative `@Transactional`).
3. **.NET** — stress-tests `wrapTransaction` (explicit `BeginTransactionAsync`)
   and the largest leaf set.
4. **Elixir** — last, and **conditional**: see Risks.

## Risks & non-goals

- **Elixir may justify staying separate.** Its body composes as a `with`-chain
  (`with {:ok, a} <- …, {:ok, b} <- … do`), not a flat statement sequence, and
  `for-each` lowers to `Enum.reduce_while`. That is a different *control-flow
  topology*, not a different spelling — the same class of mismatch that keeps
  HEEx on a parallel walker (finding #5). If forcing Elixir through the spine
  requires a "compose mode" flag on the target, that is leakage and Elixir
  should keep its own emitter. The choreographer is still a win across the other
  four. Decide this at step 4 with the pilot's hook surface in hand, not now.
- **Refactoring ~3.5k LOC of generation code is inherently high-risk** — hence
  the byte-identical gate and one-pair-at-a-time rollout. No big-bang.
- **Don't over-grow the interface.** If an arm needs a hook the others don't,
  prefer rendering it inside the existing leaf over adding an interface method
  used by one backend (the `ExprTarget` discipline).

## Next step

Land this design for review, then execute the Hono+Python pilot on a branch with
the baseline diff captured first.
