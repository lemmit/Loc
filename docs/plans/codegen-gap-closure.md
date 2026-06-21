# Codegen gap-closure plan

Status: Wave 1 landed (5 branches pushed, no PRs). Derived from a full audit (2026-06) of generated output across every
backend and frontend for unimplemented features — TODO comments emitted into generated
files, `undefined`/null-render sentinels, runtime-throwing stub bodies, reserved-but-throwing
adapter axes, and primitives lacking a renderer for a given target.

The buckets below touch **disjoint file trees** so they run as parallel agents without merge
collisions. Each carries a cross-target **hint**: when a sibling backend/frontend already
implements the feature, port the logic from there rather than designing fresh.

## Wave 1 — landed

Each bucket implemented on its own branch off fresh `main`, pushed, no PR.

| Bucket | Branch | Result |
|---|---|---|
| V · validator guards | `claude/gap-validators` | F1/F2/P4/P0 as IR-validate errors; new `src/ir/util/find-predicate-capability.ts`; 12 negative tests; suite exit 0. |
| E1 · Elixir vanilla workflow | `claude/gap-elixir-workflow` | for-each/if-let via `with`-chains, returning-op exhaustive; fixed 2 latent compile-gate bugs. Docker `--warnings-as-errors` vanilla gate still to re-run (port 443 was contended). |
| E2 · Elixir LiveView | `claude/gap-elixir-liveview` | page `renderStmt` exhaustive over `StmtIR`; `new Part{}` struct literal; mix-compile verified. |
| J · Java persistence reads | `claude/gap-java-reads` | document + event-sourced in-memory hydrate-then-filter (shared `inMemoryRetrievalLines`); `gradle bootJar` clean. |
| A · Angular | `claude/gap-angular` | all api-read shapes + CreateForm/Action/Modal/WorkflowForm render real bodies; `ngc --strictTemplates` clean; stub gate narrowed to residual. |

### Follow-ups discovered during Wave 1

- **A-residual** — shared-RHF form primitives `Form` / `EditForm` / standalone `OperationForm` / `DestroyForm` not yet Angular-forked (still stubbed by the narrowed `pageNeedsDeferredFeatures`). New bucket.
- **A-reactive-find** — a param-find driven by page state reads the signal as a snapshot at field-init (`useFind({ status: this.status() })`); compiles but isn't live-reactive. Convert to a getter-based binding. Small.
- **E1-verify** — re-run `LOOM_PHOENIX_VANILLA_BUILD=1 LOOM_HEX_MIRROR=1` mix-compile now the hex-mirror port is free.
- **V-F2-scrutiny** — `loom.method-call-unresolved-receiver` has false-positive risk on valid bodies; audit against all example `.ddd` before merge (full suite passed, good signal).

## Priority tiers

- **P1 — Correctness:** valid `.ddd` produces broken/incomplete output (page stub, codegen throw, emitted `# TODO`).
- **P2 — Cheap guards:** valid input throws at runtime or silently mis-emits; the fix is a validator that turns it into a compile-time error.
- **P3 — Reserved vocabulary:** nothing breaks today (validation rejects the selection); pure feature expansion. **Deferred** (see bottom).

## Active buckets

Files listed are the *only* trees each bucket edits.

### A · Angular frontend  — P1, XL
Whole page categories render a title stub instead of real content: any form
(`CreateForm`/`OperationForm`/`WorkflowForm`), `Action(inst.op)` mutations, modals, and any
read beyond `useAll*`/`*ById` (parameterized finds, views).

- Files: `src/generator/angular/**`, `designs/angularMaterial/**`
- Gate to remove: `pageNeedsDeferredFeatures` (`angular/walker/page-shell.ts:68`) → `renderAngularPageStub` (`page-shell.ts:485`, `index.ts:131`).
- **Hint:** React/Vue/Svelte fully implement all of this.
  - Wire schemas/zod are framework-neutral — reuse `src/generator/_frontend/api-module.ts` directly (it already emits `useQuery`/`useMutation` shapes; Angular consumes via Angular Query or a signals service).
  - Port *logic* (not JSX) from `react/walker/page-shell.ts` (form wiring split), `_walker/primitives/forms.ts` + `controls.ts` (the `idExpr` derivation — `<instance>.id` for a prop/row, `id ?? ""` for a route param).
  - `angular/action.ts` + `angular/modal.ts` **already exist** — they are gated, not missing, so the Action/Modal slice is mostly un-gate + wire.
- Stage internally: (1) API service layer → (2) Reactive Forms (Create/Operation/Workflow) → (3) un-gate Action/Modal → (4) parameterized/view reads → drop the stub predicate last.
- Done when: `generated-react-build`-equivalent for Angular (examples × angularMaterial) `ng build` clean with no `renderAngularPageStub` output for the example set.

### J · Java persistence reads — P1, L (splittable J1/J2)
Custom retrievals on `shape(document)` and event-sourced aggregates throw at codegen.

- Files: `src/generator/java/emit/document-store.ts` (J1), `src/generator/java/emit/event-store.ts` (J2)
- Symptom: build fails — "retrievals … are not implemented (the … is not a query target)".
- **Hint:** .NET implements both via in-memory hydrate-then-filter. Mirror the `dotnet`
  document-repository, and the event-repo `_LoadAllAsync` (fold the event log through appliers
  → list → filter). Evaluate the find predicate in memory with the existing `java/render-expr.ts`.
- Done when: `LOOM_JAVA_BUILD=1` green for a fixture with a document aggregate + an event-sourced aggregate, each carrying a non-`all` find.

### E1 · Elixir vanilla workflow/operation — P1, M
`for-each` body (only `op-call`), `if-let` branch, and exception-less returning-op (add/remove
collection mutations) emit `# TODO: lower … kind '<kind>'`.

- Files: `src/generator/elixir/vanilla/workflow-execution-emit.ts`, `.../operation-returns-emit.ts`
- **Hint:** the Ash path + the shared `_workflow/stmt-target.ts` dispatch already cover these
  statement kinds; mirror that dispatch into the vanilla emitter.
- Done when: `LOOM_PHOENIX_BUILD=1` (vanilla leg) green for a workflow exercising nested
  for-each / if-let / collection add+remove with no emitted `# TODO`.

### E2 · Elixir LiveView pages — P1, M
Page-handler statement kinds beyond assign/let/expression, and `new Part{}` in a page body,
emit `# TODO`.

- Files: `src/generator/elixir/heex-walker-core.ts`
- **Hint:** Ash operation/workflow emit already lowers `new Part{}` (struct literal) and
  control-flow; port those arms into the page-handler path.
- Done when: a LiveView page with a control-flow handler + a `new Part{}` emit compiles with no `# TODO`.

### V · Validator guards — P2, S–M
Turn three runtime/silent-wrong cases into compile errors, plus the find-predicate gate.

- Files: `src/language/validators/**`, `src/ir/validate/checks/**`, new IR-level capability descriptor under `src/ir/`
- Gaps:
  - **F1** — `Action(inst.op)` emits `mutateAsync({})` (`_walker/primitives/controls.ts:196`); a parameterized op used in an `Action` silently drops its params. Reject `Action` on an op with params (point to `OperationForm`).
  - **F2** — unresolved mutation/method-call receiver → `/* TODO … needs hooks {} binding */ undefined` (`_walker/walker-core.ts:1150`). Reject the unresolvable handle ref upstream so the sentinel is unreachable.
  - **P4** — raw seed row with a non-literal column value throws in `sql-pg.ts:176`. Reject (or extend to `now()`/`uuid()`) at validation.
  - **P0** — find predicates outside a persistence adapter's SQL subset throw at runtime (MikroORM `emit/mikroorm.ts:437`, Dapper `emit/dapper.ts`) or emit a TODO (Drizzle `repository-find-predicate.ts:33`). Add a per-adapter "find-predicate capability" descriptor (IR-level, platform-neutral — `ir/` may not import `generator/`) and a validator that errors when the selected adapter can't lower a find.
- **Hint:** EF Core lowers the richest find subset — use its shape rules as the "fully lowerable"
  baseline; each narrower adapter declares its subset. The gate makes the existing backend
  throw/TODO fallbacks unreachable dead code (leave them as defence-in-depth).
- Note: P0 is a *gate*. Extending each lowerer so MORE finds work (toward the EF subset) is a
  larger follow-up, tracked separately.
- Done when: negative validator tests cover F1/F2/P4/P0; a find an adapter can't lower fails `ddd parse` instead of at runtime.

### R-PEROP · per-op style decomposition (F6d) — P3-internal, M each
`emitEndpoint` / `emitHandlerOrService` throw `AdapterNotImplementedError` on the real
`layered` styles (node/elixir/java) and elixir `ash`; those styles currently route everything
through `emitForAggregate`. Internal seam (not user-visible), kept active per scope decision.

- Files: each backend's `adapters/*-style.ts` (node `platform/hono/v4/adapters/layered-style.ts`, elixir `generator/elixir/adapters/{ash,layered}-style.ts`, java `generator/java/adapters/layered-style.ts`)
- **Hint:** `dotnet/adapters/cqrs-style.ts:121-150` implements both methods fully — the reference
  for per-op extraction.
- Sequencing: prerequisite for any future `R-STYLE` work, so land it before that bucket is undeferred.

## Execution waves

- **Wave 1 (now, fully parallel — no shared files):** A · J · E1 · E2 · V.
  `V` is the highest value-per-effort; `A` and `J` are the long poles.
- **Wave 2:** R-PEROP (one agent per backend; independent of Wave 1).

Cross-bucket dependencies (the only edges):
- P1/P2/P3 find-predicate fallbacks → gated by **V/P0** (no code change needed in the backends once gated).
- Future `R-STYLE` → depends on **R-PEROP**.

## Deferred (P3 — reserved vocabulary, nothing breaks today)

Selecting any of these fails fast at validation via `AdapterNotImplementedError`; no broken code
ships. Undefer when the vocabulary is actually needed.

- **R-PERSIST:** marten (.NET), jooq (Java), axon (Java). Hint: each is the eventLog/stateBased sibling of a real adapter (efcore/jpa); reuse `system/migrations-builder.ts` + the real adapter's emit scaffold.
- **R-STYLE:** .NET `layered`, node `cqrs`, java `cqrs`, `flat` (all backends). Hint: `dotnet` cqrs / the real `layered` styles are the references; `flat` has none. Depends on R-PEROP.
- **R-TRANSPORT:** .NET `minimalApi`, node `express`+`fastify`. Hint: real refs hono / `controllers` / `restController` / phoenix.
- **R-RUNTIME:** orleans (.NET), worker (node), genserver (elixir). Greenfield concurrency/actor models; lowest priority.
