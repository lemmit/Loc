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
| B2 | **Generation properties** — idempotence, no-spurious-touch, timezone independence, source-form independence, `--dry-run` fidelity (`test/cli/regeneration.test.ts`), plus per-shape determinism folded into the existing fuzzer. | landed |
| C2 | **`--verify-ir`** — total IR structural checker run on every generation (M-T9.40). Denominator + enumeration landed: 176 declaration expression sites, walked by `src/ir/util/model-exprs.ts`, its completeness asserted against an independently-derived census. The measurement it enabled: `validateExprIntegrity` reached 2,316 of 3,609 expressions; migrated onto the walk it reaches all of them, with zero new diagnostics and 31 net lines deleted. Two migrations landed and the "eleven partial walks" count was corrected to two — the rest are scope-carrying or local by design. Verifier landed: zero violations everywhere, so a regression guard — but the enrichment-idempotence property beside it, widened from 4 examples to the whole corpus, found a real duplicate-append in the `policy deny` derivation. | part |
| C3 | **Universal proofs** for tenancy / denyByDefault / masking (M-T9.41). **Re-scoped by measurement**: a probe found 17 tenancy aggregates and zero gaps, because an IR check restates the enrichment that derives the filter. Tenancy breaks at EMISSION — each backend applies `contextFilters` in its own read paths, which is where the `projection-agg-filters` COUNT/SUM leak lived, with a correct IR. The census must read emitted source. | re-scoped |
| B5 | `render-expr-kinds` evaluated rather than rendered — one value table executed on five backends. | planned |
| B3 | Extend `wire-golden` to the uncovered corpus features + the route census. | planned |
| B7 | Warnings-as-errors uniformly in the compile legs (config, not code). | planned |
| C4 | Cross-backend duplication detector over `generator/*/`. | planned |
| C5 | Regeneration / customization-gradient. The regeneration half landed with B2; the user-edit-survives-a-model-change half is still open (scaffold-once and `.loomignore` already have their own gates). | part |
| C6 | Metamorphic pins: `unfold` ≡ un-unfolded output; `byLayer` ≡ `byFeature` modulo paths. | planned |
| A5/A6 | Drain the duplicated per-target string scenarios under the ledger rule, ratcheting. **Re-scoped by §5 — it is a corpus-PROMOTION campaign, not a deletion one.** | blocked on corpus growth |
| A7 | Collapse ~60 per-backend npm legs into parameterized legs + one workflow matrix. | planned |

**Explicitly not building:** a reference interpreter (§3); mutation-testing infrastructure
(keep `corpus-mutation` + the PR-body mutation proof as policy); a separate metamorphic
harness (fold into the fuzzer); a new cross-framework DOM differential (extend
`generated-a11y`).

## 5. What the first slice found

The ledger's own numbers, on `main` @ `6e32849`: **289 declared cells — 220 at the
behavioural tier, 69 at compile only, 0 at generation alone.** The compile-only set is 14
features (`projection-agg-filters`, `projection-document-aggregation`, `outbox`,
`channels-broker`, `tenancy-hierarchy`, `policy-document`, `extern`, `extern-handlers`,
`handler-resource-ops`, `handler-triad`, `resources`, `api-call`, `lifecycle-guard`,
`collection-op-shapes`), which is the 2026-08 audit's R6 list of seven plus seven more it
did not name. Two of them — `projection-agg-filters` and `projection-document-aggregation`
— exist *because* an audit found a cross-tenant COUNT/SUM leak, and a leak is a runtime
value: the tier that watches them cannot see a wrong number. Those are the cells where a
string test is still the only thing making a runtime claim, and the drain must leave them
alone until the behavioural tier reaches them.

### The drain is a promotion campaign, not a deletion one

The first thing the ledger settles is that the naive reading of §1 was wrong. Of the 42
scenarios duplicated across three or more target directories, **only 3 (2,061 LOC) have a
corpus fixture** — `audit-history`, `projection-groupby`, `field-mask` — and those three
sit at the behavioural tier, so their per-target copies are drainable today. The other
**39 (33,639 LOC) have no corpus fixture at all**, which means the string tests are the
only gate those scenarios have on those targets, and deleting them would lose real
coverage rather than redundant lines.

So the productive unit of work is not "delete five copies". It is: promote the scenario
into the corpus — one `.ddd` plus one manifest row buys five compile cells, and a
behavioural block plus a golden buys five runtime cells — and *then* delete the five
copies. `temporal` is the canonical example: 813 LOC across five near-identical fixtures
asserting that five emitters write particular tokens, replaced by ~60 LOC of fixture whose
cells assert that five backends compile and answer. The line count falls and the claim gets
strictly stronger; the two are the same move.

That also re-scopes the headline. 126,741 LOC of string-only tests is the *size of the
tier*, not the size of the drain. The drain is bounded by how fast the corpus grows, which
is why B3 (extend the goldens) and the corpus-promotion work are the rate-limiting items,
not the deletions.

### B7 is nearly done already

Four of the five compile legs already run at maximum strictness — python `mypy --strict`,
dotnet `/warnaserror`, elixir `mix compile --warnings-as-errors`, node `tsc --noEmit`
against the generated project's own strict config, and `generated-biome` gates emitted
TS/TSX at zero errors. **Java is the only leg without `-Xlint:all -Werror`.** B7 is that
one flag plus, optionally, ErrorProne/NullAway — not a programme.

**The risk of the deletion campaign, stated plainly.** String tests localize failures — a
compile gate says "the Java build broke", a string test says "the temporal emitter dropped
`Duration.between`". The mitigations are the ledger rule itself (never delete the last gate
on a cell) and C2, which restores localization at the IR level where the bug usually
originates. Keep one smoke anchor per emitter FILE rather than per scenario.
