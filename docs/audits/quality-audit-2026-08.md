# Quality audit — where the bugs come from, and how to push quality higher (2026-08-02)

*Scope: the 988 commits on `main` from 2026-06-20 → 2026-08-02 (~29/day), of which 235 are fix-related; the 17 open PRs; the CI gate inventory (59 workflows); and the fast suite (~1,400 files / ~11,700 tests). Method: root-cause classification of a 24-commit stratified sample (full commit bodies, which in this repo name the discovering gate), subject-line classification of all 235, and a gate-tier reconciliation against actual workflow `on:` blocks. Snapshot-in-time; `main` @ `7fbb54c`.*

---

## 1. The headline answer

**The bugs are not mostly regressions, and the test suite is not failing at its job — it was never pointed at where the bugs live.** The dominant bug class is *latent*: a feature that shipped on one backend and silently never worked (or worked differently) on another, sitting green under thousands of tests until a deliberately-constructed audit or a newly-built runtime gate walked into it. Only ~1 revert in 988 commits and a near-absence of "fix the fix" chains means merged work is rarely *broken by later work* — it was *born incomplete on some cell of the matrix*, and nothing measured that cell.

Three structural facts produce this:

1. **The product surface is combinatorial; the fast suite is string-level.** Every feature must be correct on 5 backends × 6 frontends × persistence adapters × design packs. The 783 generator test files assert `expect(emitted).toContain("…")` — they pin *what the emitter writes*, not whether it compiles, boots, or answers correctly. Every one of the recorded bug waves ("built green because its example exercised none of these paths" — #2081; decimal `%` emitting uncompilable Java/Elixir — #2241; `.NET with audit` having *never compiled* — #1419) lived below the string tier.
2. **The gates that would catch these run after merge, or not at all.** Branch protection requires only `tests-passed`. Every compile gate, behavioral leg, and conformance check is per-PR *non-required* (can be red and merge anyway) or main-push/nightly/label-only. The dapper behavioral gate spent its entire life in `startup_failure` — red on 100% of main pushes — unnoticed, because it had never been green (no red *transition* to alert on).
3. **Ash-removal debt.** ~10% of the 235 fixes are the elixir-vanilla §-gap drain — a backend rewritten from Ash to plain Ecto/Phoenix and then patched into parity gap by gap. This wave is essentially done (the §-numbered fixes end mid-July) but it inflates the recent "agents fixing bugs of all kinds" impression.

## 2. Root-cause distribution (all 235 fix commits, sampled + subject-classified)

| Root cause | ~Share | Canonical examples |
|---|---|---|
| Generated code compiles but is **wrong at runtime / on the wire** | ~28% | optional find → 200-null instead of 404 (#2278); Phoenix `requires` deny → 500 (#1716); python commit-after-response race (#1736-era, ~1-in-3 flake); relational ops not persisting writes (#1797); enum casing breaking wire casts (#1622) |
| **Cross-backend parity gap** — silently missing/divergent on backend X | ~18% | python emitted *zero* WHERE scoping for capability filters, no error (#1477 F1); elixir extern op persisted an empty changeset and reported 204 success (#1841); Phoenix routing `PATCH` while its own spec said `POST` (#2342) |
| Generated code **fails to compile** | ~16% | corpus skip-list drains (#1543, #3396d7f); `/warnaserror` on rabbit channels — "no per-PR gate compiles that combination" (#2181); Jackson 2→3 stragglers (#2315) |
| Toolchain-internal (IR/lower/enrich/scaffold/walker) | ~11% | nested workflow saves silently discarding writes (#2148); derived optionality dropped from wireShape (#2141) |
| Ash-removal elixir-vanilla debt | ~10% | the §1–§15 drain, #1573–#1628 wave |
| Test/CI infrastructure itself | ~10% | never-ran dapper workflow YAML (#2156); stale pins from a squash landing red (#1650); harness not unwrapping the paged envelope (#2184) |
| Grammar/validator | ~6% | soft-keyword collisions (`write`, `parent`, `filter/stamp/implements` — #1926, #1645); trailing-comma error swallowed by Langium recovery while ~30 fixtures "parsed" (#2302) |
| Other (docs, playground, a11y) | ~6% | |

## 3. How the bugs are actually found (the uncomfortable table)

From the 24-commit deep sample:

| Detection mechanism | Share of sample |
|---|---|
| **Deliberate audit / coverage exercise** (fleet bug-hunt, showcase-100%, behavioral-parity construction, Phoenix-boundary slices, full code review, hollow-work sweep) | **~58%** |
| Post-merge / main-only gate going red | ~17% |
| Per-PR behavioral/e2e gate | ~8% |
| Per-PR compile gate (corpus etc.) | ~8% |
| Per-PR fast vitest suite | **~0%** — it is where the regression *pin lands afterward*, almost never where the bug is discovered |

This is the core finding: **discovery is manual and episodic; prevention is what the gates do only after an audit has minted them.** The repo's own ratchet — every audit batch ships the gate that converts its discovery class into a per-PR check (behavioral tier, corpus tiers, wire-golden, keyword-identifier probe, workflow-lint, api-surface scrape) — is working and is why the compile-skip maps are now empty and wire waivers number just 2. But the ratchet is reactive by construction.

## 4. Why 11,700 tests don't stop these — the five recorded blind spots

Each of these is documented as having actually shipped a bug (refs: `experience_gathered.md` §§16/22/54/55/57/59/62):

1. **Assertion-style ceiling.** `toContain` on emitted strings cannot see non-compiling output, runtime divergence, or example-coincidence (assertions that hold only because the fixture's names happen to coincide, §54).
2. **Tests pinning the bug.** `slice2-crud-write.test.ts` asserted the *wrong* Phoenix route as intended behavior; six Phoenix workflow-param tests pinned a `MatchError` (§59). A green test is evidence of *stability*, not *correctness* — the golden/oracle discipline (a reviewed answer key, not a majority vote, §57) is the countermeasure.
3. **Honesty holes in the harness.** `test/_helpers/generate.ts` never checked parser errors — Langium error-recovery let **77 tests in 14 files** assert against partial ASTs of fixtures that never parsed (PR #2354, in flight). Generator tests bypass `validateLoomModel` entirely (§22). `ddd parse` silently filters IR errors and prints OK (§62) — the measuring instrument itself was blind.
4. **Coverage counted per-feature, holes live per-cell.** Bugs cluster at feature × backend × adapter × example intersections no fixture crosses. The canonical `update` route — the most basic CRUD verb — had **zero callers in any test in the repo** while carrying two contract bugs (§62, #2342).
5. **Gate-tier inversion.** The checks most correlated with real bugs (behavioral legs, corpus compile, conformance) are exactly the ones a PR can merge red on. Merge-queue triggers exist on the key workflows and are inert; `docs/ci-gating.md` names the queue as the structural fix and labels as the interim 80/20.

## 5. What is already strong (do not re-litigate)

- Compile-tier parity **drained**: all five corpus `COMPILE_SKIP` maps empty; 33 features × 5 backends compile per-PR.
- The wire-golden differential (M-T9.11): five one-way per-PR runtime gates at zero new boot cost, with a reviewed oracle; found RS-13/RS-14 on its first run. **This is the pattern to extend.**
- Hollow-work guards (`generated-output-sentinels`, `dead-generator-exports`, `allowlist-ratchet`) ride the fast suite.
- Waiver registries ratchet (stale waivers fail); the 2 java RS-20 wire waivers noted at audit time grew to 5 and were then **deleted with the fix** (java's `version` is now a command-driven guarded bump, not JPA `@Version`), leaving 4 wire waivers (1 elixir RS-18, 3 elixir M-T6.20) and 1 HEEx pin (DataGrid, reasoned).
- The audit→gate ratchet culture itself; `workflow-lint` + `ci-red-alarm` closing the "never-green gate" class.
- Mutation-proofing of new gates ("revert the fix, watch the gate fail") is appearing in recent PR bodies (#2342) — currently discipline, not policy.

## 6. Recommendations — ordered by leverage

### P0 — structural (close the tier inversion)

**R1. Turn on the merge queue.** The single highest-leverage change in the repo, already scaffolded (#2156): `merge_group` triggers sit inert on test.yml, tenancy, obs/oidc, compose, behavioral. With `main` at ~29 commits/day, "green PR, red main one merge later" is not an edge case, it is the steady state — 4 of 24 sampled fixes were "fix what main-only CI has been screaming about." Queue entry should run: the behavioral legs, corpus-build, the per-backend build gates, `langium-generated`, `conformance-parity`.

**R2. Make the per-PR runtime tier *required*, not advisory.** Until the queue is on, promote from "can merge red" to required: `behavioral-e2e` (Hono/PGlite — cheap, no docker), `corpus-build`, `langium-generated`, and each backend's `behavioral-e2e-*` leg (already path-scoped, so the cost only lands on PRs touching that backend). A non-required gate is a dashboard, not a gate.

### P1 — instrument honesty (make the existing suite tell the truth)

**R3. Land and generalize the harness-honesty fixes.** #2354 (parse-error assertion in `generate.ts`) closes one hole; the remaining two from §22/§62 need the same treatment: (a) a fast-suite census test that runs every tracked `.ddd` fixture through parse+validate and fails on parser errors repo-wide (not just via the one helper); (b) fix `ddd parse` to surface IR-level errors (today it filters to `loom.index-suggestion` — a blind instrument that "proved nothing" in the #2342 blast-radius scan).

**R4. Make gate-mutation-proofing policy.** Every new gate/test that claims to cover a bug class must demonstrate it fails on the reverted fix (or a seeded mutation) *in the PR body*. This is already emerging practice in the best recent PRs; write it into CLAUDE.md's conventions so it's the norm, not the exception. It is the only known defense against §59's "the written assurance is why the bug survives" and against tests that pin bugs.

**R5. Route-coverage census.** The `update`-route lesson: extend the new api-surface scrape (#2342) with a one-directional census — every derived API operation must have ≥1 runtime caller across the behavioral corpus + `test e2e` blocks; new operations fail until exercised. Same idea for walker primitives × frontends (an emitted-but-never-driven census, the write-path-client lesson of §59).

### P2 — extend the proven patterns to the remaining blind cells

**R6. Finish the behavioral matrix** (already missioned, keep priority): the 7 corpus features with no behavioral block (`channels-broker`, `extern`, `extern-handlers`, `field-auth`, `outbox`, `resources`, `tenancy-hierarchy` — M-T9.13), Flutter's zero-runtime-coverage cell (M-T9.14), one non-React per-PR full-stack cell (M-T9.15).

**R7. Kill the sentinel-`ExprIR` exhaustiveness hole (M-T9.9).** Tenancy/authz filters ride as sentinel `ExprIR`s pattern-matched by ~8 translators with no compile-time exhaustiveness — a missing arm is a *silent tenant-data leak*, the worst failure mode in the codebase. Promote to typed IR nodes so a new arm is a compile error on every backend, the same move that made `ExprTarget` safe.

**R8. Continue derivation-unification.** The Phoenix route bug was possible because five backends implement the API surface independently and only *documents about them* were compared. #2342's endgame — route builders rendering *from* `deriveContextOperations`, backend by backend — removes the divergence class structurally, exactly as `ExprTarget`/`TypeTarget`/`WalkerTarget` did for expressions/types/pages. Prioritize the same single-source-of-truth move for HTTP status/error ladders (in flight: #2351) and success-body shapes.

**R9. Grammar-level fuzz + swallowed-error gate.** Two recorded classes: Langium error-recovery silently swallowing errors (~30 fixtures, #2302) and new soft keywords breaking identifier positions one merge later (§16, M-T5.18's 277×6 probe found `parent` on its first run). Keep the keyword-probe snapshot growing with the grammar, and add a recovery-honesty check (any fixture that parses with recovered errors fails) — R3(a) subsumes half of this.

### P3 — process

**R10. Flake budget with teeth.** The channels-e2e redis/java leg "intermittently never delivers" (#2350); the python commit-race was found *as* a 1-in-3 flake. Track per-leg pass rates; a leg below threshold gets a claiming issue automatically — flakes in runtime gates are how real races hide.

**R11. Weekly quality delta, mechanically.** Waiver counts (wire, HEEx, skip-maps), gates added vs bugs found by audit vs bugs found by gate, red-time on main. The data for §3's table took an afternoon to reconstruct; a cron that appends it to a dashboard makes the discovery-vs-prevention ratio a tracked number. Success metric: **the share of bugs discovered by per-PR gates (today ~16%) should overtake the share discovered by episodic audits (today ~58%).**

**R12. Duplicate-claim hygiene.** #2349/#2351 are the same branch open twice (draft + ready). Cheap fix: a scheduled check flagging multiple open PRs sharing a head branch, and closing drafts on ready-flip.

## 7. One-paragraph summary

The stream of bug-fix PRs is not evidence of a failing test suite; it is evidence of an *audit engine* systematically draining a latent-defect inventory that a string-assertion suite could never see, across a 5×6 combinatorial surface, faster than the per-PR gates have been promoted to hold the line. The compile tier is now airtight; the runtime tier exists but is advisory; the merge queue that would make it binding is built and switched off. Quality goes "top-level" when three things flip: the runtime gates become *required* (R1/R2), the instruments stop lying (R3/R4), and every divergence class that has been caught twice gets its single-source-of-truth derivation (R7/R8) — at which point the audits stop finding whole classes and start finding stragglers.
