# T5 — Language core & type system

*The expression language is deliberately small; these missions finish the in-flight type-system families (errors-as-data, criteria, payloads), close audited correctness bugs, and keep the surface honest.*

## M-T5.1 — Exception-less completion (A4/A5/A6 + VO→422) — `partial` · **L** · P1 ⚠ coordinated
The remaining errors-as-data arc: **A4** re-shape `Repo.getById` from `: X` to `X or NotFound` (`: X?` → `X option`) — THE coordinated single-PR fixture re-baseline across all backends; **A5** parse-intrinsic/external-api results as `or`; **A6** `validate for X` → `X or ValidationError[]`; VO-construction `invariant` → 422 routing with RFC-7807 `errors[]` (failure-taxonomy's highest-leverage piece); variant-`match` with scrutinee + variant-pattern binding (real prerequisite — `match` is boolean-guard-only today). The `?` propagation operator stays DROPPED — do not reintroduce.
Sources: [exception-less](../old/proposals/exception-less.md), [failure-taxonomy](../old/proposals/failure-taxonomy.md), [implementation-plan](../old/proposals/implementation-plan.md) decision table.

## M-T5.2 — Backend failure-sink contract — `open` · **M** · P2
Uniform problem+json envelope + `traceId` as a cross-backend wire contract; `errors {}` policy override (backend half of M-T1.8); `expose`/public-contract error translation at api blocks (failure-taxonomy OQ4).
Sources: [error-handling-and-failure-sink](../old/proposals/error-handling-and-failure-sink.md), [failure-taxonomy](../old/proposals/failure-taxonomy.md).

## M-T5.3 — Payload tail: P3 nested carriers, P5, `option` — `partial` · **M** · P2
Nested carriers `P<Q<T>>` (gated `loom.generic-arg-not-carrier`); `validate for X` / `authorize for X` (no surface); the `option` carrier end-to-end (unblocks [partial-update](../old/proposals/partial-update.md) three-state PATCH and M-T1.6's "leave unchanged"); page-aware React hooks.
Sources: [payload-transport-layer](../old/proposals/payload-transport-layer.md) P3/P5, [partial-update](../old/proposals/partial-update.md).

## M-T5.4 — Criterion & retrieval tails — `partial` · **L** · P2
(a) `from <Criterion>(args)` on params/command fields (input validation + UI dropdown + OpenAPI constraints — also unblocks domain-service param criteria); (b) findAll `sort:`/`loads:` + single-result `Repo.find(<Criterion>)`; (c) `private workflow` / workflow-calls-workflow (Crit5); (d) reified-criteria phases: `Criterion<T>` object reification (incl. principal constructor-arg), retire `usesUser` threading, **add criteria reification on Phoenix** (it has none), `isSatisfiedBy` duality, Java `Specification<T>` fallout; (e) explicit `loads:` plans or the autoload inference direction (retrieval Phase 6 / load-specifications v2) — pick one, gate the other honestly.
Sources: [criterion](../old/proposals/criterion.md), [reified-criteria](../old/proposals/reified-criteria.md), [retrieval](../old/proposals/retrieval.md), [load-specifications](../old/proposals/load-specifications.md), DEBT-24/28.

## M-T5.5 — Stdlib tail — `partial` · **S** · P2
A4 reductions verified complete 2026-07-13 (`src/util/collection-ops.ts:18-34` — count/sum/min/max/avg all registered). Remaining: block-form top-level functions (`loom.function-toplevel-block`), storable `duration`/PG interval columns, externalising the prelude to `std/*.ddd`.
Sources: [stdlib plan](../old/plans/stdlib.md), completeness-audit Tier 1.

## M-T5.6 — Strict decimal/money bounds bug — `open` · **S** · P1 ⭐ correctness
Full-code-review #6: strict `>`/`<` bounds on decimal/money get folded to inclusive comparisons somewhere in lowering/emission — a real, shipping correctness bug. Reproduce, fix across the five `ExprTarget`s, add per-backend kind tests.
Sources: [full-code-review-2026-07](../audits/full-code-review-2026-07.md) #6.

## M-T5.7 — Inheritance tail — `partial` · **M** · P3
I4 per-concrete storage override / mixed strategy (gated; UNION-ALL variant was dropped — re-justify before building); `<Concrete>Id → <Base>Id` threading across ~49 .NET application-layer sites (mechanical, `/warnaserror`-gated); polymorphic `<Base> id` refs.
Sources: [aggregate-inheritance](../old/proposals/aggregate-inheritance.md), [dotnet-tph-emission](../old/proposals/dotnet-tph-emission.md) follow-on.

## M-T5.8 — Lifecycle operations phases 3–5 — `partial` · **M** · P3
Backend route emission per action kind + action-param walking in API generators; `crudish` reframing (`createOp`/`destroyOp` factories); scaffold macros emit noun-named ops by default (+ fixture re-baseline).
Sources: [lifecycle-operations](../old/proposals/lifecycle-operations.md).

## M-T5.9 — Surface hygiene: signposting + with/implements — `open` · **S–M** · P2
(a) `loom.reserved-not-emitted` diagnostic routed through every parse-but-no-emit surface (old S1 — additive, self-emptying); (b) the `with`/`implements` keyword-kind split + fix-it + codemod (old S4). S2 redundancy cuts are DONE (#1795).
Sources: [reserved-surface-signposting](../old/proposals/reserved-surface-signposting.md), [with-implements-split](../old/proposals/with-implements-split.md).

## M-T5.10 — API derivation completion — `partial` · **M** · P2 ⚠ verify-first
`commandHandler`/`queryHandler`/`route` shipped on all 5 (+scaffold A3.2/A3.3 just landed). Remaining: full response-DTO projection + `[FromBody]` request records; the `wireShape` retirement steps 6–8 (coordinate with the shipped consumers per the coordination note); extern handler LSP/scaffold polish.
Sources: [unfoldable-api-derivation](../old/proposals/unfoldable-api-derivation.md) + [coordination note](../old/proposals/unfoldable-api-derivation-coordination-note.md).

## M-T5.11 — Extern domain extension — `done` (verified 2026-07-13) · —
Phase 2 re-homing is complete on **all five** backends — the injected-registry apparatus is deleted everywhere (`typescript/extern-builder.ts:14`, `python/extern-builder.ts:20`, `dotnet/emit/extern.ts:10`, `elixir/vanilla/extern-emit.ts`). [extern-domain-extension-point](../old/proposals/extern-domain-extension-point.md) is closed. Kept briefly as the record; delete next refresh.

## M-T5.12 — Typed-capabilities tail — `partial` · **M** · P3
Phase 5 remainder: LSP tooling (go-to-capability, find-implementors, completion) + marker-interface emission `I<Capability>`; then the [capability-emission-dedup](../old/proposals/capability-emission-dedup.md) stamp-dedup ladder (deferred until a second stamping capability exists). Also the persist-time auditing simulations (node awaiting §7 sign-off; Java §5-vs-§6-ALT fork).
Sources: [typed-capabilities-implementation](../old/plans/typed-capabilities-implementation.md) Phase 5, [node-persist-time-auditing-simulation](../old/plans/node-persist-time-auditing-simulation.md), [capability-stamp-dedup-simulation](../old/plans/capability-stamp-dedup-simulation.md).

## M-T5.13 — Multi-file & composition tails — `partial` · **M** · P3
Stage B cross-context `X id` identity refs via `uses`/`export`; zero-system synthesis decision; `ui with scaffold` cross-file gate test. (Stages C+ stay deferred indefinitely.)
Sources: [multi-file-source](../old/plans/multi-file-source.md), [implicit-system-composition](../old/proposals/implicit-system-composition.md).

## M-T5.14 — Domain-services Shape B — `open` · **M** · P3
The coordinator shape (Phase 2); Shape C stays deferred. Plus shipped-tier refinements (read-port shape, `audited` on service ops).
Sources: [domain-services](../old/proposals/domain-services.md).

## M-T5.15 — Language misc (DEBT-29/30, BUG-003/004) — `open` · **S–M** · P3
Joined view sources + per-view params (DEBT-29, grammar-level); seed create-shape validation, applier misc, block-body lambdas (DEBT-30 a/b/c); BUG-003 scalar-return op HTTP divergence (gate reverted — re-land properly); BUG-004 `resource`-keyword field name collision.
Sources: old DEBT backlog, [showcase-coverage-bugs](../audits/showcase-coverage-bugs.md).

## M-T5.16 — Compiler-internal fragility guards — `open` · **M** · P2
From the weak-spot review §7: (a) exhaustiveness-check the type-system's parallel walkers (`stepInto` + `typeAfterSuffix`) so a new bindable type can't silently miss one; (b) revisit the `unknown`-cascade suppression (a placeholder type silently disables ALL downstream operand checks) — at minimum a lint that counts suppressed sites; (c) full-code-review #22: macro expansion under LSP incremental rebuilds (C5).
Sources: [weak-spots §7](../audits/architecture-weak-spots-2026-07.md), `experience_gathered.md` §unknown, full-code-review #22.
