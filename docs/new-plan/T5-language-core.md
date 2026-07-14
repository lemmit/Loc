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

## M-T5.6 — Strict decimal/money bounds bug — `done` (verified 2026-07-14) · **S** · P1 ⭐ correctness
Full-code-review #6: strict `>`/`<` bounds on decimal/money were folded to inclusive comparisons via the `n±1` identity — a real, shipping correctness bug (`weight > 0.5` → `min(1.5)`, rejecting the whole open interval at the wire boundary). **Fixed on `main`:** `src/ir/validate/invariant-classify.ts:468-484` reads the left operand's lowered type via `isNonIntegerNumericType` (`decimal`/`money`) and, for a strict `>`/`<` on a non-integer field, carries the RAW literal with `exclusive: true` instead of `n±1`; integer fields keep the (sound) inclusive fold. All five wire-validator emitters honour the flag: zod `zod-refine.ts:37/39` (`.gt`/`.lt`), .NET `validator-emit.ts:193/195` (`.GreaterThan`/`.LessThan`), Python `routes-builder.ts:384/386` (`gt=`/`lt=`), Java `emit/validator.ts:201/203` (`>`/`<`), Elixir `changeset-validators.ts` + `document-emit.ts`. Repro on fresh `main`: `invariant weight > 0.5` on a `decimal` emits `weight: z.coerce.number().gt(0.5)` (was the buggy `.min(1.5)`) and domain guard `this._weight.gt(new Decimal("0.5"))`.
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

## M-T5.10 — API derivation completion — `partial` · **M→L** · P2 ⚠ verify-first
`commandHandler`/`queryHandler`/`route` shipped on all 5 (+scaffold A3.2/A3.3). **Verified 2026-07-14 (state audit): the "full response-DTO projection + `[FromBody]` request records" item is STALE — already shipped** (`<Handler>Body`/`@RequestBody`/Pydantic request records on 4/5 backends; response projection via repo `toWire`/`projectToResponse`). The genuine gap was **Layer 2 (contract)** — no `scaffoldResponse`/`command`/`query` records existed; handlers took flat scalars + returned bare aggregates.
- **PR1 (contract-record layer) landed** (#1900) — `scaffoldHandlers` now splices source-visible literal `response`/`command`/`query` `PayloadDecl` records (`src/macros/api/factories.ts` `payload`/`response`/`command`/`query` + `apiReadFields` = AST twin of `forApiRead(wireShape)`; `src/macros/stdlib/scaffold/_contracts-shared.ts`). Macro-layer only, additive + **inert** (byte-identical generation, proven). `unfold` ejects the contract as real `.ddd`.
- **PR2–PR6 (response-DTO read-rewire) landed — all 5 backends** (#1905 .NET, #1909 Hono, #1910 Python, #1911 Java, #1912 Elixir). Each backend's response-DTO/schema emitter now READS the declared `<Agg>Response` record (override-by-name on `ctx.payloads`) instead of re-deriving from `wireShape`: .NET record params, Hono zod schema, Python Pydantic model, Java record + `from()` mapper, Elixir OpenApiSpex schema. The `id` row (grammar-reserved, omitted) is re-prepended and containment fields (already `<Part>Response`) map via an `isResponsePayloadName` guard (no `<Part>ResponseResponse` double-suffix). Each PR is **byte-identity + divergence gated** (scaffolded record ≡ wireShape baseline; a hand-declared divergent record emits differently). PR2 also threaded `env` into `lowerPayload`/`lowerField` (macro-spliced refs skip the Langium Linker). The DTO's source of truth now moves from enrichment-stamped `wireShape` to the declared contract.
- **Remaining:** rewire the explicit-handler emitters to take `cmd`/`q` record params + declare `<Agg>Response` returns; tighten Hono 200 schema `z.unknown()` → `<Agg>Response`. (The response-record read — the prerequisite for suppressing the wireShape derivation — is now done on all 5.)
- **Spun off:** the `wireShape` retirement (proposal steps 6–8) — 179 refs / 49+45 files, gated on the contract layer + entangled with the still-active auto-derivation mainstream; XL, deserves its own mission (not this M). Extern handler LSP/scaffold polish is a separate tail.
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

## M-T5.17 — Surface normalization: aggregate-header modifiers + `httpStatus` — `design` · **S–M** · P3
Cosmetic (zero-semantics) surface cleanup from the 2026-07-14 language-surface review. (1) The aggregate header carries four modifier syntaxes in a rigid order — collapse the call-style axis modifiers (`persistedAs(eventLog)`/`shape(document)`/`inheritanceUsing(ownTable)`) to colon clauses (`persistedAs: eventLog`, order-independent) matching every other enum-value pick in the language, and hoist `crossTenant` to lead beside `abstract`; `extends`/`with` unchanged. (2) `httpStatus E N` space-triple → `httpStatus E -> N` (matches route/link/migration "maps to"); #1918 makes this clause load-bearing. **No soft-keyword growth.** Rollout is phased: Phase 1 accept-both (additive, zero fixture re-baseline, land anytime + deprecation fix-it); Phase 2 codemod + remove old forms (the only fixture-churning piece — time it against #1904/#1922/#1920, not a PR headcount). Design + grammar/codemod sketch: [M-T5.17 design](./missions/M-T5.17-header-modifier-normalization-design.md).
Sources: language-surface review 2026-07-14, `src/language/ddd.langium` (`Aggregate`/`ApiStatus`), D-DOCUMENT-AXIS §4.
