# Verification architecture — what the suite proves, what it costs, and what to delete (2026-08-31)

*Scope: a first-principles design of "how would you verify a five-backend / six-frontend
compiler and the apps it emits", built by reading `src/` only, then reconciled against the
suite that exists. Companion to [`quality-audit-2026-08.md`](quality-audit-2026-08.md),
which asked **where the bugs come from**; this one asks **what the verification apparatus
costs to own**. Snapshot-in-time; `main` @ `6e32849`.*

---

## 1. The measurement the 2026-08 audit did not take

| Measure | Value |
|---|---|
| `src/` | 332,393 LOC |
| `test/` | 302,948 LOC / 1,825 `.test.ts` files (0.91× `src/`) |
| `test/generator/` | 147,044 LOC (47% of the suite) / 985 files |
| — per-backend/per-frontend dirs | ~90,000 LOC |
| — shared-seam dirs (`_walker`, `_packs`, `_stmt`, `_workflow`, `_obs`, `_i18n`, `_persistence`, `_frontend`) | ~10,700 LOC |
| Assertions | 35,040 `expect(` — 16,909 `toContain`, 2,813 `not.toContain`, 3,923 `toMatch` = **67% substring** |
| Files asserting ONLY by substring on emitted text | **879 files / 126,741 LOC (42% of suite LOC)** |
| Scenario names duplicated across ≥3 target dirs | 42 scenarios / 199 files / 35,700 LOC |
| Workflows / npm test scripts | 67 (10,300 LOC YAML) / 88, ~60 of them one leg × per-backend |

The 2026-08 audit measured that tier's **yield** (~0% of bug discovery). This one measures
its **cost**. Both numbers are needed to act: a cheap tier with low yield is fine, a tier
costing 127k LOC with ~0% yield is the largest unmanaged liability in the repo.

**The structural diagnosis.** The compiler factors emission into one shared spine plus N
leaf tables — `renderExprWith` + 5 `ExprTarget`s, `walkBody` + 6 `WalkerTarget`s, one
`MigrationsIR` + N renderers. **The suite does not factor at all.** `src/generator/_expr/
target.ts` owns the 17-arm dispatch for all five backends and has no dedicated test
directory, while `render-expr-kinds.test.ts` is duplicated 4× for 3,203 LOC of assertions
on strings that one dispatcher produced. `temporal.test.ts` is 813 LOC across five
near-identical `.ddd` fixtures. So the suite pays the combinatorial cost the architecture
was designed to avoid, in the weakest assertion tier.

## 2. The governing rule

> **Keep exactly one gate per (feature × target) cell, at the strongest tier available for
> that cell. A string assertion earns its place only when it is the strongest gate for its
> cell, or when it pins a property no stronger tier can observe** — import hygiene, a
> negative no-leak, a name that never reaches the wire.

Deletion is therefore gated on knowing each cell's strongest tier, which is what the gate
ledger (§4 C1) derives. Nothing is deleted on judgement; a deletion cites a cell whose
stronger gate is named.

## 3. What was found already strong (do not rebuild)

- **`wire-golden` as a reviewed answer key.** The design note in `wire-differential.mjs`
  records the exact failure that motivates a reference interpreter (RS-11: three backends
  agreed, all three wrong) and solves it more cheaply — a committed golden is an oracle
  that names a winner, and `A ≡ golden ∧ B ≡ golden ⇒ A ≡ B` decomposes an N-way nightly
  diff into N one-way per-PR gates. **A reference interpreter for Loom IR is therefore
  explicitly NOT on the roadmap**; extending the goldens dominates it on every axis.
- The corpus manifest is already a live, enforced feature × backend matrix.
- Covering arrays (`test/pairwise/axes.ts`) over the configuration space.
- Meta-gates on the suite's own honesty: `assertion-free-census`, `vacuous-file-assertion`,
  `generated-output-sentinels`, `dead-generator-exports`, `allowlist-ratchet`,
  `flake-budget`, `quality-delta`, `diagnostic-firing-census`.
- Layering enforcement, printer completeness, pack required-emits, HEEx parity freeze.

## 4. The plan

Ordered so each item either funds a deletion or costs no maintenance. Status is kept
current here; missions land in `docs/new-plan/`.

| Id | Item | Status |
|---|---|---|
| C1 | **Gate ledger** — derive per-cell strongest tier from the registers that already exist; fail on a cell with no gate above `generate`. Deletion authority + silent-gap detector. | landed |
| B2 | **Generation properties** on the existing fuzzer — determinism, idempotence, input-order invariance, rename equivariance. | planned |
| C2 | **`--verify-ir`** — total IR structural checker run on every generation. | planned |
| C3 | **Universal IR proofs** — tenancy scope-filter, denyByDefault route gating, `mask unless` serialization closure. Proven once for all models; funds trimming per-backend runtime legs to faithfulness spot-checks. | planned |
| B5 | `render-expr-kinds` evaluated rather than rendered — one value table executed on five backends. | planned |
| B3 | Extend `wire-golden` to the uncovered corpus features + the route census. | planned |
| B7 | Warnings-as-errors uniformly in the compile legs (config, not code). | planned |
| C4 | Cross-backend duplication detector over `generator/*/`. | planned |
| C5 | Regeneration / customization-gradient test. | planned |
| C6 | Metamorphic pins: `unfold` ≡ un-unfolded output; `byLayer` ≡ `byFeature` modulo paths. | planned |
| A5/A6 | Delete duplicated per-target string scenarios under the ledger rule, ratcheting. | blocked on C1 |
| A7 | Collapse ~60 per-backend npm legs into parameterized legs + one workflow matrix. | planned |

**Explicitly not building:** a reference interpreter (§3); mutation-testing infrastructure
(keep `corpus-mutation` + the PR-body mutation proof as policy); a separate metamorphic
harness (fold into the fuzzer); a new cross-framework DOM differential (extend
`generated-a11y`).

**The risk of the deletion campaign, stated plainly.** String tests localize failures — a
compile gate says "the Java build broke", a string test says "the temporal emitter dropped
`Duration.between`". The mitigations are the ledger rule itself (never delete the last gate
on a cell) and C2, which restores localization at the IR level where the bug usually
originates. Keep one smoke anchor per emitter FILE rather than per scenario.
