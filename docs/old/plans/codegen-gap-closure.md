# Codegen gap-closure plan

Status: **Wave 1 shipped and merged** (PRs #1452/#1453/#1455/#1456/#1457). Derived from a full
audit (2026-06) of generated output across every backend and frontend for unimplemented
features — TODO comments emitted into generated files, `undefined`/null-render sentinels,
runtime-throwing stub bodies, reserved-but-throwing adapter axes, and primitives lacking a
renderer for a given target.

Wave 1 closed every **P1/P2** correctness gap. What remains is **R-PEROP** (Wave 2, an internal
seam — not user-visible) and the **deferred P3 reserved-vocabulary** buckets (selecting them
already fails fast at validation, so nothing broken ships). See *Remaining* below.

Each bucket touches **disjoint file trees** (parallel agents, no merge collisions) and carries a
cross-target **hint**: when a sibling backend/frontend already implements the feature, port the
logic from there rather than designing fresh.

## Shipped — Wave 1 (merged)

| Bucket | PR | What landed |
|---|---|---|
| V · validator guards | #1452 | F1/F2/P4/P0 as IR-validate errors; new `src/ir/util/find-predicate-capability.ts`; 12 negative tests. The backend throw/TODO fallbacks the gates cover are now unreachable defence-in-depth. |
| E1 · Elixir vanilla workflow | #1453 | for-each / if-let bodies lower a broad `StmtIR` set via per-iteration `with`-chains; returning-op switch exhaustive; 2 latent compile-gate bugs fixed. |
| E2 · Elixir LiveView | #1455 | hoisted page event-handler `renderStmt` exhaustive over `StmtIR`; `new Part{}` → qualified struct literal; `mix compile --warnings-as-errors` clean. |
| J · Java persistence reads | #1456 | document + event-sourced custom retrievals via in-memory hydrate-then-filter (shared `inMemoryRetrievalLines`); `gradle bootJar` clean. |
| A · Angular | #1457 | every form (`CreateForm`/`OperationForm`/`WorkflowForm`/`DestroyForm`), `Action`/`Modal`, and every read shape (collection / byId / **reactive** param-find / view) render real bodies; `ng build` clean. |

### Wave-1 follow-ups — all resolved

- **A-residual** — ✅ **closed by #1457, not a separate bucket.** There is no `Form` / `EditForm`
  primitive (the registry has exactly `CreateForm` / `OperationForm` / `WorkflowForm` /
  `DestroyForm`; the plan's "Form/EditForm" was loose shorthand for the internal
  `emitFormOf{Aggregate,Operation,Runs}` helpers). All four primitives fork to Angular via the
  `render<X>Form` `WalkerTarget` seams; each fork's only `null` return is an unreachable
  `call.kind !== "call"` guard, so the shared `formOfs` / `actionMutations` sinks are never
  populated on Angular and `pageNeedsDeferredFeatures` is **pure defence-in-depth** (can't fire
  for a real call). Nothing left to fork.
- **A-reactive-find** — ✅ **closed by #1457.** Parameterized finds carry `reactiveQuery` from
  `_walker/walker-core.ts`; the Angular shell wraps them as a getter
  (`useByStatusOrder(() => ({ status: this.status() }))`) so the `injectQuery` options re-read on
  signal change. Gated by `test/generator/angular/walked-pages.test.ts` ("hoists the find factory
  with a REACTIVE getter").
- **E1-verify** — covered per-PR by `elixir-vanilla-build.yml` (the vanilla
  `mix compile --warnings-as-errors` leg).
- **V-F2-scrutiny** — `loom.method-call-unresolved-receiver` merged; the full fast suite + every
  example `.ddd` parse clean, no false positives observed.

## Priority tiers

- **P1 — Correctness:** valid `.ddd` produces broken/incomplete output. **All closed (Wave 1).**
- **P2 — Cheap guards:** valid input throws at runtime or silently mis-emits; fix is a validator
  turning it into a compile-time error. **All closed (Wave 1, bucket V).**
- **P3 — Reserved vocabulary:** nothing breaks today (validation rejects the selection); pure
  feature expansion. **Deferred** (see *Remaining*).

## Remaining

### R-PEROP · per-op style decomposition (F6d) — P3-internal, M each
`emitEndpoint` / `emitHandlerOrService` throw `AdapterNotImplementedError` on the real
`layered` styles (node/elixir/java); those styles currently route everything
through `emitForAggregate`. Internal seam (not user-visible), kept active per scope decision.
(The elixir `ash` style is gone — Ash foundation removed; elixir is plain Ecto/Phoenix now.)

- Files: each backend's `adapters/*-style.ts` (node `platform/hono/v4/adapters/layered-style.ts`, elixir `generator/elixir/adapters/layered-style.ts`, java `generator/java/adapters/layered-style.ts`)
- **Hint:** `dotnet/adapters/cqrs-style.ts:121-150` implements both methods fully — the reference
  for per-op extraction.
- Sequencing: prerequisite for any future `R-STYLE` work, so land it before that bucket is undeferred.
- Status: **still open** — `emitEndpoint` / `emitHandlerOrService` throw `AdapterNotImplementedError`
  on the real `layered` styles (`platform/hono/v4/adapters/layered-style.ts:67,75`,
  `generator/elixir/adapters/layered-style.ts:45,49`); those styles route through
  `emitForAggregate`. Not user-visible, so low urgency. (The elixir `ash` style is gone —
  Ash foundation removed; elixir is plain Ecto/Phoenix now.)

### Deferred (P3 — reserved vocabulary, nothing breaks today)

Selecting any of these fails fast at validation via `AdapterNotImplementedError`; no broken code
ships. Undefer when the vocabulary is actually needed.

- **R-PERSIST:** marten (.NET), jooq (Java), axon (Java). Hint: each is the eventLog/stateBased sibling of a real adapter (efcore/jpa); reuse `system/migrations-builder.ts` + the real adapter's emit scaffold.
- **R-STYLE:** .NET `layered`, node `cqrs`, java `cqrs`, `flat` (all backends). Hint: `dotnet` cqrs / the real `layered` styles are the references; `flat` has none. Depends on R-PEROP.
- **R-TRANSPORT:** .NET `minimalApi`, node `express`+`fastify`. Hint: real refs hono / `controllers` / `restController` / phoenix.
- **R-RUNTIME:** orleans (.NET), worker (node), genserver (elixir). Greenfield concurrency/actor models; lowest priority.
