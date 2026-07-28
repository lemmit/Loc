# Loom code & test weak-spot audit

*Snapshot: 2026-07-28, `main` @ `18c62ff`. Method: four parallel code-grounded sweeps — (1) silent-vs-honest codegen gaps across all 5 backends + 6 frontends, (2) test-suite coverage & CI-gate topology, (3) complexity / fragility hotspots in the 10 hottest files, (4) the project's own documented debt (`docs/new-plan/`, `docs/audits/`, `experience_gathered.md`). Every finding carries a `file:line` and is re-verified against fresh `main` — audits rot fast here because `main` moves under you. This is a ranked risk register, not a feature inventory.*

## Verdict in one line

The compiler's **type discipline, layering, and backend parity are genuinely strong** — near-zero `any`, a strictly-enforced one-directional pipeline, all five backends drain-complete with empty `COMPILE_SKIP` maps. The weakness is **structural and lives in the feedback loop, not the code**: the required per-PR gates prove *compilation*, never *execution*, so an entire class of "compiles green, breaks on first boot" bugs ships to `main` and is discovered post-merge. Everything below is downstream of that one gap.

---

## The systemic weakness (this is the report)

**Required PR gates prove compilation; every gate that proves execution runs post-merge or behind a narrow path filter.**

Branch protection requires only `tests-passed` (fast vitest), the `*-build` compile gates (`tsc --noEmit`, `mix compile --warnings-as-errors`, `gradle testClasses`), `corpus-build`, and `behavioral-e2e` (Hono on PGlite — the one daemonless runtime gate). Every heavy runtime/boot gate — `tenancy-e2e.yml`, the five `*-obs-e2e`, four `*-oidc-e2e`, `auth-oidc-compose-e2e`, `pages` — triggers on **`push: [main]` only**. They carry `merge_group:` triggers too, but `docs/ci-gating.md` states these are **inert until the merge queue is turned on** in branch settings.

**Bug class that passes every required gate and still reddens `main`:** a broken migration DDL, a bad generated `docker-compose.yml`, a DB-connection wiring regression, a missing audit column, a snake_case wire leak, an OIDC token→User mapping break, a tenant scope-filter that *stamps* but doesn't *isolate*. Compile gates are structurally blind to all of it. Worse, a change to a **shared** file (`src/ir/lower/lower.ts`, `src/ir/enrich/enrichments.ts`, `src/system/migrations-builder.ts`) that breaks tenancy/obs runtime won't match the *narrow per-path* `pull_request` filters some e2e workflows carry (e.g. `behavioral-e2e-mikroorm.yml` only fires on `mikroorm.ts`, `hono/**`, `_adapters/**`, `ir/**`, `_expr/**`) — so the PR goes green and `main` goes red one merge later. Precedent is documented: `behavioral-e2e-dapper.yml` sat red across 100% of main pushes because it was *never* green and nobody was watching.

This is not a hypothetical — it's the repo's own dominant retro theme (`experience_gathered.md` §14/§21: the "EF PascalCase columns vs snake_case DDL" and Phoenix `put_embed` classes of "compiles fine, 500s on first request"). The project has institutionalized *working around* it with skills (`generated-stack-verifier`, `dependency-upgrade`) that exist precisely because authors ship green PRs that fail the nightly boot.

> **Highest-leverage hardening:** pull one fast, daemonless runtime assertion per high-blast-radius surface (migrations, tenancy stamp+isolate agreement, wire-shape casing) into the required lane — the pattern the repo already proved with `behavioral-e2e` on PGlite — instead of waiting for the heavy e2e.

---

## Ranked weak spots

### 1. Migration diff/rename heuristic — data-loss class, all 5 db backends at once (HIGHEST blast radius)
`src/system/migrations-builder.ts` (2448 LOC; `diffTable` L705, `applyDestructivePolicy` L958, `matchTables` L572)

Derived once in phase ⑨ (`MigrationsIR`) and shared by TS/.NET/Java/Python/Elixir, so a bug here hits **five backends simultaneously**. The risk core is heuristic column-rename detection: absent an explicit annotation, a rename collapses to drop+add (L791–807) = **silent data loss behind a flag**. The code flags its own gap (L720–724: "the one-drop-one-add heuristic can't collapse for two-at-once or rename+type-change"). `applyDestructivePolicy` then *weaves* backfill `UPDATE`s between column adds and `NOT NULL` flips (L1038, L1110) — a mis-ordered weave emits a migration that fails at apply-time on a populated table. **The only gate that catches any of this is a live boot** (nightly/heavy), so a green PR can ship a data-losing migration to all five backends. `docs/new-plan/T2-data-evolution.md` (P1) tracks the deeper hole: no data migrations, no down migrations, and correctness silently depends on git hygiene — a missing `.loom/snapshots/<module>.snapshot.json` re-emits a full `Initial` against a live DB, unguarded.

### 2. Flutter silently drops deferred page primitives — no validator gate (open silent gap)
`src/generator/_packs/required-primitives.ts:142` (`FLUTTER_INLINE_OR_DEFERRED`); drop sites `src/generator/flutter/pack.ts:449`, `forms-emit.ts:172`

The entire interactive/form family is absent on Flutter: `Tabs`, `Field`, `MultilineField`, `PasswordField`, `NumberField`, `SelectField`, `Toggle`, `FileUpload`, `Form`, `Modal`, `MasterDetail`. Frontends validate against the target-*agnostic* `walker-stdlib`, so a page using `Toggle` or a standalone `Field` **type-checks, passes validation, and emits a `// TODO(flutter …)` comment** where the widget should be — the element vanishes from the UI. `generated-flutter-build.yml` stays green because the comment is valid Dart. Confirmed **no** `loom.flutter*` gate exists in `src/language/` or `src/ir/validate/`; the only detector is `src/generator/flutter/parity.ts`, a *post-generation playground lint*, not a compile-time gate. Mitigated by being a documented "walking skeleton" with loud, greppable markers — but it's the single genuine **silent** codegen gap open on `main` today. Safe interim: a one-line `loom.*-unsupported` gate on the deferred set for `platform: flutter`, matching how the four Handlebars frontends fail loud at pack-load (`_packs/loader.ts:346`).

> Context: the sibling procedural pack, **Feliz**, had the *same* disease — 24 of 44 primitives dropped as compile-clean F# comments — **closed 2026-07-27** (`RENDERERS` grew 20→~45 keys, `feliz` added to `REQUIRED_PRIMITIVES`). Both procedural packs escape the pack-load required-primitive gate that structurally protects react/vue/svelte/angular; Flutter is simply the one not yet drained.

### 3. ~100+ validator diagnostic codes have no negative test (validator can silently stop rejecting)
`src/ir/validate/` + `src/language/validators/` (394 distinct `loom.*` codes; ~332 referenced anywhere in `test/`)

Spot-checked genuine holes — literal code present in `src`, zero test references:
- `loom.match-non-exhaustive` — a non-exhaustive `match` slips through
- `loom.event-sourced-direct-mutation`
- `loom.applier-impure`
- `loom.auth-missing-issuer`
- `loom.currentuser-not-in-request-scope`
- `loom.resource-op-in-transaction`

(The raw untested count over-reads because some codes are dynamically built — `loom.${kind}-name-conflict` at `structural.ts:726` — but the auth / match / event-sourcing families above are real.) **Bug class:** a refactor that stops *emitting* one of these is undetectable — the validator silently accepts invalid `.ddd` and the bad model flows to codegen. The auth and event-sourcing gates are the thinnest, and they guard the two most safety-critical surfaces.

### 4. Residual per-backend duplication the seam extraction left behind
`src/generator/{elixir,java,dotnet,python,typescript}/render-expr.ts` (1399 / 1071 / 1081 / 708 / 759 LOC)

The `ExprTarget` seam (`src/generator/_expr/target.ts`) shares the 17-arm dispatch spine but **not the leaf logic** — and much of the leaf logic is pure IR analysis that *cannot legitimately diverge*:
- `isDescendingSort` is **byte-identical across all 5 backends** (reads `e.args[1]` literal-bool, zero target-specificity).
- `renderBinary` duplicated ×4; `isDecimalOperand` / `renderDecimalBinary` / `renderDateTimeCompare` re-implemented per backend.

**Why risky:** these encode IR *structural assumptions* (how a sort flag / decimal operand is shaped). Change the IR encoding and you must silently edit up to five files; the seam gives false confidence that dispatch-sharing eliminated the duplication.

### 5. Money/decimal semantics decided twice — type-system AND every backend renderer
`src/language/type-system.ts` (`moneyArithmetic` L742, `arithmeticResult` L594) vs. per-backend `isDecimalOperand`/`renderDecimalBinary`

Decimal/money arithmetic is decided in phase ④ (type-system), then **re-derived independently** in each of the 5 `render-expr.ts` files, which re-sniff operand types rather than reading a threaded IR fact. **The type checker and the code generators can disagree about whether an expression is money**, and nothing cross-checks them — a money-typing change in one place is silently wrong in the other six. This is a "derive, don't stamp" violation in spirit: the fact should be lowered onto the IR once, not re-computed per backend.

### 6. Hidden mutable module-globals inside the "pure" lowering pass
`src/ir/lower/lower-expr.ts:140` (`ambientEnumIndex`), `:153` (`topLevelFnIndex`); `lower-types.ts:305` (`ambientDeclIndex`); `lower-test.ts:42` (`hoistedTestsBySubject`)

Module-scoped `let` bindings feed **name resolution** (read at `lower-expr.ts:797/1361/1554`), populated by setters with **no reset**. The lowering pass is nominally pure, but enum-value / top-level-fn resolution actually depends on whichever model last called the setter. **Bug class:** any path that resolves an expression without re-running the setter (`mergeLoomModels`, multi-model runs, future refactor) reads stale cross-model state — passes unit tests in isolation, manifests only under batch/merge. A resolution cache with no invalidation story.

### 7. Complexity hotspots most likely to grow a subtly-wrong gate
- `src/ir/validate/checks/system-checks.ts` (**3214 LOC**, 40 `case`, **183 `if`**, ~9-deep nesting at L386–422) — the largest hand-written validator, with three near-identical copy-pasted diagnostic-emit blocks (op/workflow/find) differing only in a `source:` string; exactly where a message drifts out of sync with its condition. Only 2 dedicated `test/ir/validate/` files exist against it.
- `src/ir/lower/lower-expr.ts` (**2482 LOC**, **262 `if`**, ~10-deep nesting, **22 non-null assertions** — the highest `!` density in the codebase). Each `!` asserts a resolution succeeded instead of handling failure; a wrong one doesn't crash lowering — it produces a mis-typed IR node a backend renders incorrectly, far from the cause.
- `src/generator/_walker/walker-core.ts` (2030 LOC) — three parallel dispatchers (`walk`/`emitExpr`/`emitStmt`) shared by **all six frontends** via mutable `WalkContext` threading (`propagateChildFlags` L1016, `recordStoreUse` L1040); a missed flag-propagation renders wrong in one framework only.

### 8. Genuinely disabled / silently-skipping tests (distinct from the ~70 correctly env-gated e2e suites)
- `test/system/storage-declaration.test.ts:45` — `describe.skip("… legacy — superseded by D-STORAGE-SPLIT")`: a whole storage-declaration suite is dead weight; if the split left any of that surface live, it's untested.
- `test/language/print/print-structural-roundtrip.test.ts:61` & `print-roundtrip.test.ts:96` — `it.skip(... fragment — not a complete model)`: a fixture that regresses into *unparseable* gets its print round-trip check **quietly dropped** rather than failing.
- The `test/fixtures/**` byte-identical snapshot fixtures are **excluded from vitest discovery** (`vitest.config.ts:27`) — consumed only by the capture script, so a regression fixture no runner asserts is stale-prone.

---

## What is actually strong (so effort isn't misdirected)

- **Backend parity is drain-complete.** Every validator gate set (`LIMITED_FAMILIES`, `TPH_CAPABLE`, `EVENT_SOURCING_BACKENDS`, `FIELD_MASK_BACKENDS`, `AUDIT_*_BACKENDS`, …) lists all five backends, and **all five corpus `COMPILE_SKIP` maps are empty** — no backend declares a corpus feature it can't compile.
- **Type discipline is high.** Near-zero `any` even in the 2000–4000-LOC hot files; the hidden holes are `!` assertions (finding 6/7), not `any`.
- **Layering is strictly enforced, zero exceptions** (`test/platform/pipeline-layering.test.ts` — no permitted backward value-edge across `language→ir→generator→system`). The fragility is intra-layer duplication, not backward coupling.
- **The HEEx parity freeze is closed** (`test/generator/elixir/heex-parity.test.ts:59` — `KNOWN_HEEX_GAPS = {}`): every TSX-rendered primitive now has a HEEx renderer. The residual risk is structural only — the freeze can't catch a HEEx renderer that emits *wrong* markup (no byte-identical gate; Phoenix runs a parallel walker engine).
- **`vanilla-phoenix-gaps.md` is nearly fully closed** — the runtime-500 class is gone; residuals (`mix format` cleanliness §7, a workflow-serializer snake_case tail) are cosmetic.

---

## Recency caveats

The `docs/new-plan/` roadmap is current (refreshed 2026-07-28). The `docs/audits/` corpus is ~2 weeks old (mostly `2026-07-13` snapshots) and fast-moving `main` has already drained several of their P0/P1 findings — treat every prior audit finding as *verify-first*. The `2026-06*` audits and `gated-features-inventory.md` are explicitly **superseded**. The freshest cross-checks used here: `frontend-parity-audit-2026-07.md` (Feliz, now closed), `target-gate-inventory-2026-07-18.md` (gate sets, re-verified against `system-checks.ts`), `architecture-weak-spots-2026-07.md` (the roadmap's ranking authority).

## One-line prioritization

Close **finding 1** (a fast migration-diff runtime assertion in the required lane) and **the systemic gap** it belongs to first — that single move retires the largest class of "green PR, red main" defects. **Findings 2–3** (Flutter silent drop, untested validator codes) are cheap, high-value one-line gates. **4–7** are refactors that reduce the *rate* of future silent bugs rather than fixing one.
