# Loom — testing & quality improvement plan

*Created 2026-07-28 from a full test-coverage sweep of `main` (commit `18c62ff`): the fast vitest suite (~10,700 tests / 1,386 files), the opt-in `LOOM_*` runtime tiers, the corpus feature×backend matrix, and the CI gate inventory. This is an **analysis + proposal** doc — it feeds concrete missions into [`T9-toolchain-health.md`](T9-toolchain-health.md) (and a few into [`T6`](T6-backend-parity.md)/[`T3`](T3-security-governance.md)); it does **not** fork any status table. Every proposed mission is **verify-first** — `main` moves fast, re-check the gap exists before building.*

## Posture — what's already strong

The suite is large and, on the *structural* axis, thorough. Three things are genuinely healthy and should not be re-litigated:

- **Compile-tier parity is drained.** Every `*_COMPILE_SKIP` map (`test/e2e/corpus-{tsc,dotnet,java,python,elixir}-build.test.ts`) is **empty** — all 33 corpus features compile clean on all five backends per-PR (elixir via `LOOM_HEX_MIRROR`, M-T9.10).
- **The corpus is a machine-checked matrix.** `test/fixtures/corpus/manifest.ts` (33 features) × 5 backends is gate-enforced by `corpus-coverage.test.ts`; a feature with no row, or a documented feature with no fixture, fails CI (`feature-doc-coverage.test.ts`).
- **The hollow-work guards exist.** `dead-generator-exports.test.ts`, `generated-output-sentinels.test.ts` (no `TODO`/`unsupported` in emitted code), and `allowlist-ratchet.test.ts` already ride the fast per-PR suite (M-T9.8).

The gaps are **not** in breadth of string-level assertions. They are in three places: (A) whether generated output is proven to **run**, not just compile; (B) **shared cross-backend cores** that no test hits directly; (C) **honest validator gates** that fire in no test. This plan is ordered by risk, highest first.

---

## A — Generated-output runtime validity (P1)

The generated-code validation pyramid is: string-assert → compile → **behaviorally run** → full-stack round-trip. Per-PR, the top two tiers are uneven. Originally **9 of 33 corpus features carried no behavioral block at all** (`test/fixtures/corpus/*.ddd` with no `test e2e`/`test`), proven to *compile* on 5 backends and to *run* on zero. M-T9.12 closed `event-sourcing` + `eventsourced-workflow`; the remaining **7** are: `channels-broker`, `extern`, `extern-handlers`, `field-auth`, `outbox`, `resources`, `tenancy-hierarchy`. (Several have *dedicated* runtime e2e legs — `outbox`/`channels-broker` via `channels-e2e.yml`, `tenancy-hierarchy` via `tenancy-e2e.yml` — but those are nightly/post-merge, not per-PR, and the rest have none.)

### M-T9.12 — Event-sourcing runtime validation — `done` · **M** · P1
`event-sourcing` (append-only stream + appliers) and `eventsourced-workflow` (a saga folding its own emitted events) emitted on all five backends but were validated **nowhere at runtime** — a wrong fold/replay produced green CI. **LANDED:** a `test e2e` block on each corpus fixture so the five per-feature `behavioral-e2e-*` legs execute them:
- `event-sourcing.ddd` — create/deposit/withdraw then read back the **folded balance** (`70` and, through a `byOwner` filter query, `250`), asserting the replayed scalar, not HTTP 200. Reconstruction proven reader-independent.
- `eventsourced-workflow.ddd` — an explicit `create` added (Order was never runtime-drivable — no create route), then `place()` drives the self-folding saga end to end: OrderPlaced → workflow start → emit PaymentRegistered → `apply` folds `paid` → the `on` handler reads that folded `paid` in `precondition paid >= 0` → emit FulfillmentCancelled → `apply` folds `cancelled`. **Non-hollowness proven** by a mutation probe: forcing `precondition paid >= 999` fails `place()` with 400, confirming the applier folds *before* the next handler reads it and that fold errors propagate.

Verified passing on **node + python** behavioral legs (the self-fold chain runs in one synchronous request); clean generation on all five backends. **Follow-up (own slice, S):** asserting the folded workflow-instance *scalars* (`paid`/`cancelled`) directly needs a workflow-instance read verb the `test e2e` DSL doesn't have yet — today the ES-workflow test asserts the observable (order round-trips, saga runs without error) + the mutation-probe proof. Cross-ref: the node ES-create-invariant bug M-T9.3 surfaced shows this class is live.

### M-T9.13 — `resources` / `extern` runtime validation — `open` · **M** · P2
`resources` (objectStore/queue/api/email clients) and `extern`/`extern-handlers` (escape-hatch scaffolds) are compile-only. `email-e2e`/`channels-e2e` exist but do not exercise these corpus fixtures. Add a behavioral block or a dedicated harness proving a resource client round-trips (put→get) and an extern handler is invoked. (`extern` bodies that legitimately `throw "not implemented"` stay honest fail-fast, excluded.)

### M-T9.14 — Flutter runtime proof — `open` · **M** · P2 ⭐
Flutter is the one frontend with **zero** runtime coverage: `generated-flutter-build.yml` (compile) is its entire gate — no SPA smoke, absent from the nightly `frontend-fullstack-e2e.yml` matrix. It is also the only frontend with **no `render-expr` per-kind test** (`flutter/dart-expr.ts` untested — see D) and **no auth-UI test**. Add, at minimum, the backend-less SPA smoke (`flutter build web` + a Playwright mount/route assertion) the other frontends have, then a matrix cell in `frontend-fullstack-e2e`.

### M-T9.15 — Per-PR full-stack round-trip for one non-React frontend — `open` · **L** · P2
React is the only frontend with a **per-PR** full-stack round-trip (`behavioral-ui-e2e.yml`). Vue/Svelte/Angular/Feliz get a build gate + a *backend-less* SPA smoke (routing only, `push:main`); their only proof that generated forms create+read against a real backend is nightly (`frontend-fullstack-e2e.yml`, cron `17 5 * * *`). A wire-contract/form-binding regression on those four ships and sits on `main` until the nightly. Promote **one** (Vue, the most-used) to a per-PR `run-ui.mjs` cell.

### M-T9.16 — Cross-backend *runtime* differential per-PR — `in-flight` (see M-T9.11) · P1
Per-PR, `conformance-parity.yml` diffs the five backends' **OpenAPI specs** but never asserts they return the **same data**. Runtime value divergence (rounding, ordering, null handling, error codes) is caught only nightly (`conformance-full`) on one fixture. **This is already M-T9.11** (the differential-response gate, slice (a) landed, report-only) — folded in here as the runtime-validity face of that mission; the ask is promoting it from nightly report to a per-PR blocking gate (its slice (c)).

---

## B — Shared cross-backend cores with no direct unit test (P1)

These are the contract-plus-leaf-table dispatchers and shared derivations. A bug here breaks **multiple targets at once**, yet each is exercised only end-to-end through full generation — so a regression shows up as a confusing multi-backend failure far from its cause, if a fixture happens to hit the path at all.

### M-T9.17 — Direct unit tests for the shared generator/IR cores — `in-flight` · **M** · P1
Add focused unit tests (mock target / minimal IR fixtures, no full generation) for the shared cores that currently have **zero** direct test reference:

- `src/generator/_workflow/stmt-target.ts` — `renderWorkflowStmts` (the 10-kind `WorkflowStmtIR` spine + the only `for-each`/`if-let` recursion, shared by the Hono/.NET/Java/Python workflow emitters) and `collectUnionFindLets`. A mock `WorkflowStmtTarget` pins dispatch + recursion + indent + chunk granularity byte-exactly.
- `src/generator/_persistence/seed-datasets.ts` — `groupByDataset`/`usedAggregates` (first-boot seed grouping shared by the three SQL backends).
- `src/ir/util/reachable-types.ts` — `collectReachableTypes` (transitive VO/enum closure feeding every schema emitter; cycle-safety is untested and is exactly the off-by-one/infinite-loop class).
- `src/ir/util/repo-methods.ts` — `isReadMethod`/`isWriteMethod` (the CQRS read/write routing predicate + the `loom.domain-service-no-repo-write` gate).

**Slice 1 (this doc's companion PR)** lands the four above. **Slice 2 (follow-up):** the branch-dense lowering leaves `src/ir/lower/repo-read.ts` (377 lines of repo-read pattern matching) and `id-follow.ts` (join/path planning), plus the remaining `ir/util` predicates (`aggregate-flags.ts`, `audit-capability.ts`, `workflow-command-route.ts`, `handler-contracts.ts`, `merge-contexts.ts`) — these need heavier `EnrichedAggregateIR` fixtures, so factor a small IR-fixture builder first.

### M-T9.18 — Direct tests for the macro engine — `open` · **S** · P2
`src/macros/expander.ts` (975 lines, the core expansion engine) and `src/macros/registry.ts` (ships an unused `_resetRegistryForTests` hook no test calls) have no direct unit test — only incidental coverage through the stdlib-macro tests. Add registration/lookup and arg-resolution/diagnostics-draining unit tests against the registry's own surface.

---

## C — Honest validator gates that fire in no test (P2)

387 `loom.*` diagnostic codes are emitted; ~288 are asserted by code identity, and a second valid style (message-substring assertions) covers many more. **Verify-first caveat — this class rots the fastest.** An initial sweep flagged ~23 "uncovered" codes; on re-check against fresh `main`, **most were false gaps** — their tests live in `test/language/` (not `test/language/validation/`) or assert by *message* in `validation.test.ts`, both of which a code-identity grep misses. Always confirm code-**and**-message absence, and reachability, before writing.

### M-T9.19 — Negative tests for the unexercised validator gates — `done` · **S** · P2
**Already covered (do NOT re-add — verified 2026-07-28):** `auth.ts` (all 5 codes → `test/language/auth-block.test.ts`), `permissions.ts` (both → `test/language/permission-implies.test.ts`), `seed.ts` (all 4 → `test/language/seed.test.ts`), `types.ts` ternary (both → `test/language/type-system/ternary.test.ts`, by message), the workflow `emit-unknown-field` / `emit-unknown-event` codes (→ `validation.test.ts:2051,2099`, by message), `loom.canonical-{create,destroy}-conflict` (→ `test/ir/lifecycle-operations.test.ts:180,196`), and `loom.derived-display-not-string` (→ `display-inspect-derived.test.ts:31`).

**Unreachable / preempted (→ M-T9.8 "diagnostic codes defined but unemittable", not a test gap):** `loom.workflow-name-collision` (`workflow-checks.ts:180` — `loom.duplicate-workflow` fires first); `loom.workflow-create-unknown-aggregate` (`:502` — correlation/scope resolution preempts it); and **`loom.workflow-unknown-repository` (`:551`) + `loom.workflow-run-unknown-repository` (`:621`/`:674`)** — an unknown repository name lowers to a generic `expr-let`, never the `repo-let`/`repo-run` these arms guard, so the checks are structurally unreachable from source. Audit each for `assertNever`-style deadness or removal.

**Genuine, reachable gaps — LANDED:** `test/ir/workflow-dataflow-checks.test.ts` pins the six reachable IR-layer checks asserted nowhere before — `loom.workflow-unknown-name`, `-unknown-binding`, `-unknown-operation`, `-emit-missing-field`, **`-run-retrieval-mismatch`** (a `Repo.run(<Retrieval>)` whose retrieval is over another aggregate) and **`-foreach-unknown-binding`** (a `for … in` op-call on an unbound name) — each with a passing counterpart. Plus `loom.derived-inspect-not-string` (the `inspect` twin of the covered `display` check) in `display-inspect-derived.test.ts`.

**Nothing left open** — the only remaining template-literal code (`loom.canonical-${kind}-conflict`) was already covered, and every reachable `workflow-checks.ts` arm now has a negative test. The residue is the two unreachable-arm audits handed to M-T9.8.

---

## D — Cross-target unit-test parity skews (P3)

Lower-severity, but each is a place where one target's emitter is pinned per-kind and a peer's is not:

### M-T9.20 — Frontend unit-test parity fill — `open` · **S** · P3
- **`render-expr` per-kind**: all 5 backends pin every `ExprIR` kind; the two frontends with their own expression renderers — `flutter/dart-expr.ts` and `feliz/fs-expr.ts` — have none.
- **`file-upload`**: tested on react + feliz frontends; missing on vue/svelte/angular/flutter.
- **`sourcemap`**: react/vue/svelte/angular covered; feliz + flutter uncovered.
- **frontend ACL / field-mask redaction**: react-only (`frontend-acl-emit.test.ts`); no vue/svelte/angular/feliz/flutter equivalent.
- **backend micro-skews**: no dedicated `hono` timer-scheduler test (the other four backends have one); no dedicated `java` migrations-emit test.

---

## Suggested order of attack

1. **M-T9.17** (shared-core unit tests) — highest leverage per unit of effort: one bug in these cores fans out across backends, and the tests are cheap (mock target / minimal fixtures). *(In flight — companion PR to this doc.)*
2. **M-T9.19** (validator negative tests) — **done**: the six reachable workflow data-flow gaps + `derived-inspect-not-string` landed; the larger claimed set was false gaps (already covered) or four structurally-unreachable arms handed to M-T9.8.
3. **M-T9.12** (event-sourcing runtime) — **done** (both fixtures behaviorally validated, node + python). **M-T9.16 / M-T9.11** (per-PR runtime differential) next — close the rest of the "compiles green, runs wrong" class on the highest-risk features.
4. **M-T9.14 / M-T9.15** (Flutter + one non-React per-PR round-trip) — frontend runtime proof.
5. The rest as capacity allows.

*Sources: this session's coverage sweep; cross-refs — M-T9.3 (per-PR boot gates), M-T9.8 (hollow-work audit), M-T9.11 (differential-response gate), M-T3.13/#2259 (negative-authz runtime), M-T2.13/#2264 (migration-evolution runtime).*
