# Loom improvement waves — 2026-09

*Snapshot: `main` @ `5dc8b4e` (2026-09-02), 11 open PRs, the 2026-08-30 gap ledger re-counted against the 29 merges since it was cut. Goal of this plan: higher quality, stability and fewer bugs in the generated systems and the toolchain, without bending the pipeline architecture (`language → ir → generator → system`, one seam per axis). It is an execution plan for Opus/Sonnet agent waves, not a new audit — every row cites a register that already exists.*

*This plan does not fork any status table. Mission statuses stay in the track files; ledger rows stay in `docs/audits/targets-completeness-2026-08-30.ledger.json`. When a wave lands a row, close it there (RUNBOOK §5).*

---

## 0. Where things stand (verified on this head)

**Health.** The `main-red alarm` workflow is green on all of its last 25 runs on `main`. `npx tsc -b` is clean. The compile-tier corpus matrix is drained on the backend axis (every `*_COMPILE_SKIP` map empty). The `M-T9.33` diagnostic-firing census is at 0 uncovered codes.

**The drain programme is most of the way through.** The 2026-08-30 two-fleet audit produced a 251-row ledger and a 13-packet wave plan (`targets-completeness-2026-08-30.waves.json`). Since then W1 (TPH cluster, seed family, walker-shared, macros), W1b (dotnet-adapters, node-ts, elixir, java+wire-openapi) and W2 (validator, walker, python/java, macros — 25 rows) have **merged**, W2's flutter / feliz / frontend-js packets are **ready for review**, and W3 (pairwise axes) and W4 (frontend collection ops) are **claimed drafts**. Recount of the 130 rows the wave plan scheduled, by matching row ids against merged PR bodies and open-PR bodies:

| packet | scheduled | landed or claimed | residue | of which P0 / P1 |
|---|---|---|---|---|
| dotnet-adapters | 16 | 5 | 11 | 2 / 2 |
| node-ts | 18 | 2 | 16 | 1 / 6 |
| elixir | 25 | 11 | 14 | 1 / 5 |
| validator-diagnostics | 24 | 8 | 16 | 0 / 4 |
| walker-shared | 12 | 8 | 4 | 0 / 0 |
| frontend-js | 10 | 5 (#2720) | 5 | 0 / 2 |
| feliz | 7 | 5 (#2721) | 2 | 0 / 0 |
| flutter | 6 | 5 (#2723) | 1 | 0 / 0 |
| macros | 5 | 1 | 4 | 0 / 1 |
| wire-openapi | 5 | 4 | 1 | 0 / 0 |
| cli | 1 | 0 | 1 | 0 / 1 |
| python, java | 5 | 5 | 0 | — |

The match is by id, so a row a PR *mentions but defers* counts as landed above; §2 below lists the residue row by row, with the ones that need a **verify-first** re-check flagged. The 117 unscheduled rows are P3–P5 (honest gates, breadth, stale prose) and stay unscheduled.

**Three P0s are still open on this head, all security/data-integrity class:**

- `F2-ADP-1` — .NET `ignoring *` drops the `policy { deny }` always-false sentinel; read-denied rows are served (both adapters).
- `F2-ADP-5` — drizzle, the default node adapter, enforces `writeScopeFilter` on the relational shape only.
- `F2-ELX-ESCAPE-FUNNEL` — four elixir emit sites splice a `.ddd` string literal into Elixir source with bare `JSON.stringify`, so `#{` in a string is code injection into the generated app.

And one P0 deferred with a written handoff by W1b: `F2-ADP-3` (a context hosted by both a dapper and a migration-chain deployable reads two different physical tables) — it needs an **IR-layer gate**, which the dotnet packet's tree fence could not reach.

**Where the bugs come from now.** Reading the last two months of `experience_gathered.md` (§83–§93) and the 08-24 review's §F, the recurring shapes are not per-backend typos. They are:

1. **One contract, N independent implementations, no gate that they agree** (§89 addresses, §92 the dev-claims stub on four backends, the numeric wire contract re-decided at five read paths → M-T9.36, the `#{`/attr/apostrophe escape funnels, `propagateSinkFlags` vs `propagateChildFlags`). The fix that holds is one classifier with N readers plus a census that a new reader cannot bypass.
2. **A hand-rolled walk over `ExprIR`/`StmtIR` kinds that stops early** (#2720's `collectExprRefs`, python's `collectStmtExprImports` missing `variant-match`, the projection fold running one statement kind in nine — #2705). `src/ir/util/walk.ts` exists precisely so these cannot happen; the residue is the callers that never migrated.
3. **A gate that never reached the thing it names** (§59/§63/§85/§90): mechanism exists, target unreached. The 08-31 verification audit measured it structurally — 69 of 289 feature×backend cells are compile-only, and two of those cells exist *because* of a cross-tenant COUNT leak that only a runtime value can show.
4. **Both-green-separately merge pairs** (§86, 4× in five days) — the one class no per-PR gate can see; the merge queue is built but inert (personal-account repo).
5. **Hotspot files that every packet touches.** `ui-checks.ts` (3.0k LOC) is edited by #2723 and #2729 at once; `system-checks.ts` is 4.3k LOC with 9 commits since mid-July; `mikroorm.ts` 3.5k, `walker-core.ts` 2.7k, `heex-walker-core.ts` 2.5k. Packet fences work by tree, and these files are where trees overlap.

The waves below are ordered so that (a) the P0/P1 residue closes first, (b) the class-level fixes land as seams with byte-identical gates rather than as more instances, and (c) the verification tier gains the ability to see runtime values, which is what would have caught most of (a) before an audit did.

---

## 1. In flight — the do-not-duplicate fence

Read before claiming anything. An agent that finds its row here stacks on the branch or picks another row.

| PR | state | claims (tree) |
|---|---|---|
| #2729 | draft | **W4** frontend collection ops — the reshaping ops on all six frontends + HEEx (`_walker/**`, six targets, `feliz/fs-expr.ts`, `flutter/dart-expr.ts`, `elixir/heex-*`, `ui-checks.ts`, `unsupported-register.ts`) |
| #2728 | draft | **W3** pairwise corpus: inheritance (TPH/TPC) and paged-read axes (`test/pairwise/**`, `test/e2e/pairwise-corpus*`) |
| #2723 | ready | **W2 flutter**: `F2-CFE-9`, `F2-FFE-3`, `flutter-form-field-drops`, `F2-FFE-8`, `F2-CFE-11` + a third filtering component emitter gate (`flutter/**`, `ui-checks.ts`) |
| #2721 | ready | **W2 feliz**: `F2-CFE-7`, `F2-FFE-4`, `F2-FFE-5`, `sourcemap-feliz-flutter-not-emitted`, `M-T1.20-feliz-match-await` (`feliz/**`) |
| #2720 | ready | **W2 frontend-js**: `F2-FFE-2`, `F2-FFE-1`, `F2-CFE-3`, `F2-XB-2`, `M-T3.15-C3` + two honest gates (react/vue/svelte/angular, `unsupported-register.ts`) |
| #2713 | ready | **Verification architecture**: gate ledger (C1), regeneration properties (B2), `--verify-ir` denominator (M-T9.40), mints M-T9.41/M-T9.42 (`test/_helpers/gate-ledger.ts`, `src/ir/util/model-exprs.ts`, `src/ir/verify/`) |
| #2678 / #2674 / #2672 / #2671 | ready | numeric fleet: M-T1.21 (flutter money as wire string), M-T1.22 (Feliz numeric conformance), M-T1.24 (money form seams), M-T1.23 (one `decimal.js` import owner) |
| #2628 | ready | docs-only record C3 (nav vs `requires`) |

Two stale statuses to fix while landing these: `M-T9.36` is recorded `blocked(M-T6.46, M-T6.47)` in `T9-toolchain-health.md`, but both landed on 09-02 (#2677, #2675) — it is **unblocked**. `M-T9.38` (Flutter/Feliz runtime leg) unblocks the moment #2678 and #2674 merge.

---

## 2. The residue, row by row

Ids are ledger ids. **VF** = verify-first: a merged PR body mentions the id (possibly as a deferral), so re-derive on fresh `main` before building — a stale-row rebuild is the single most expensive mistake in this repo (CLAUDE.md §Sync).

**dotnet-adapters** (`src/generator/dotnet/**`): `F2-ADP-1` P0 · `F2-ADP-2` P1 (dapper seed inserts into a schema its DDL never creates) · `F2-ADP-4` P1 (ES `writeScopeFilter` repo does not implement its port, CS0535) · `M-T3.9-dotnet-audit-masked-snapshot` P2 VF (#2708 says "an audit trail that depended on the writer" — check) · `G2667-D3` P2 (projection join unguarded index → 500) · `G2667-D4` P2 VF · `dapper-no-schema-evolution` P2 L (a design decision: dapper has no ALTER path at all — decide *gate* vs *build*, do not leave silent) · `F2-W-14` P3 · `F2-EXPR-7` P3 (`.first` on empty — cross-backend contract decision).

**node-ts** (`src/platform/hono/**`, `src/generator/typescript/**`): `F2-ADP-5` P0 · `F2-ADP-6` P1 (MikroORM `raw()` bare identifiers) · `F2-CB-C8` P1 (domainService call without import) · `F2-EXPR-4` P1 (`distinct`/`contains` over value objects by reference) · `F2-W-05` P1 VF (#2705 says `.000Z` fixed) · `F2-CB-C1-paged-nonrelational` P1 VF (#2705 says the paged arm now exists on both adapters) · `G2667-C2-money-array` P1 VF (#2668 claimed it) · `timer-tz-overlap-inert` P1 (validator gate — belongs to the validator packet) · `G2667-C4-mikroorm-save-no-transaction` P2 (needs the M-T4.3 item-5 ruling; ship the ruling, not a guess) · `M-T5.14-reading-service-readport` P2 · `static-subpath-405-node-only` P2 (four backends) · `G2646-open-projection-on-event-no-channel` P2 (semantics decision B20) · `M-T1.11-domain-floor-message-code` P2 L.

**elixir** (`src/generator/elixir/**`): `F2-ELX-ESCAPE-FUNNEL` P0 · `F2-FFE-6` P1 (`+` vs `<>` chosen by literal-ness, not type) · `F2-MT640-SORT-DEAD` P1 (sortable headers are a no-op refetch) · `F2-W-01` P1 (multi-word VO field reads back null — camelCase written, snake_case read) · `M-T6.26-doc-put-presence` P1 · `elixir-grapheme-vs-codepoint-length` P1 · `G2667-C7` P2 (HEEx `Button { icon:/loading: }`; rationalised — decide gate-or-emit) · `G2667-C8` P2 VF · `G2667-D6-seeder-not-atomic` P2 VF (#2719) · `M-T6.2-s14-audit-wiresnapshot` P2 · `F2-W-08`, `F2-W-09`, `M-T6.2-s12` P3.

**validator-diagnostics + cli** (`src/ir/**`, `src/diagnostics/**`, `src/language/validators/**`, `src/cli/**`): `ir-warnings-invisible-in-cli` P1 — **first**, the wave plan's own sequencing rule: `ddd parse`/`generate system` print AST diagnostics and the IR *error* set, and discard 17 of 18 IR warning codes, so no new warning-severity gate can be mutation-proved from the CLI until this lands · `F2-VAL-1` P1 (AST validator crashes on a partially-parsed `derived`, swallowing the whole context's diagnostics) · **`F2-ADP-3` P0 gate** (one context, two adapters, two physical tables — the W1b handoff) · `M-T5.9-reserved-not-emitted` P1 · `M-T6.18-gap3-criterion-arg-types` P1 · `eventlog-shape-silently-ignored` P1 · `timer-tz-overlap-inert` P1 (gate half) · `F2-CB-C9`, `F2-CB-C10` P3 (message wording — cheap, same files) · `F2-EXPR-5` P3 (false rejection of `money * literal`) · `M-T3.8-sensitivity-phases-2-4` P2 L (a diagnostic saying `sensitive(...)` reaches one emitter is the S-size slice; the masking is a T3 mission).

**macros** (`src/macros/**`): `M-T1.15-nonstring-filter-finds-dropped` P1 · `provenanced-bare-read-in-page-body` P2 · `M-T3.7-e-claim-typed-capability-fields`, `M-T5.5-stdlib-tail` P3.

**walker-shared** (`src/generator/_walker/**`, `_expr`, `_stmt`, `_frontend`): `queryview-lambda-int-plus-literal-concat` P2 · `G2667-D2`, `G2667-D7`, `G2667-D9` P2 VF (all three are mentioned by #2702 / #2694 — likely landed).

**frontend-js after #2720** (react/vue/svelte/angular, `designs/**`): `F2-CFE-2` P1 (two forms on one page — duplicate declarations or cross-wired) · `F2-CFE-8` P1 (Angular drops component `Slot {}` children silently) · `M-T1.8-error-boundary-five-targets` P2 · `M-T1.12-raw-field-aria` P2 · `G2667-D8-pack-loader-global-handlebars` P2.

**feliz / flutter after #2721 / #2723**: `M-T1.16-invariant-validation-feliz-flutter` P2 · `flutter-modal-instance-operationform` P1 VF (#2694 built the gate; the Flutter widget for the instance shape is recorded open in that PR's IMPL-NOTES).

**wire-openapi**: `schemathesis-F11-int32-range` P2 (an `int` body field publishes no bound while the column is `int4`; explicitly deferred once — decide, don't defer twice).

**From the 08-24 follow-up register, not in the ledger's waves:** `M-T4.12` (no generated SPA can authenticate its own SSE stream on an `auth: required` deployable — live on every frontend) · `M-T6.50` (three python saga/workflow collector gaps → F821 in the generated app) · `M-T6.51` (node document finds ignore `ignoring`) · `M-T5.25` (`ignoring` after `group by` silently dropped) · `M-T1.26` (`Image`/`Avatar` `src:`/`alt:` on the pre-A12 helper) · `M-T9.39` (i18n round-trip gate).

---

## 3. Rules every wave agent follows

These are the repo's rules, restated because each one was violated at least once in the last month and cost a red `main` or a duplicate PR.

1. **Fresh `main`, then verify the row.** `git fetch origin main && git switch -c <branch> origin/main`; grep the emitter/gate the row names; read the merged-PR body that mentions the id. A row that is fixed gets closed in the ledger, not rebuilt.
2. **Claim with a draft PR titled by packet + row ids** before the first code change. Check the open drafts first (§1).
3. **Stay inside the packet's tree fence.** A fix that needs a file outside it is *handed off* in the PR body (the W1b/W2 convention: an `IMPL-NOTES` section naming the row, the file, and the reason), never raced.
4. **Silent → honest or fixed, never silent → different-silent.** A row closes either with the emitter fixed on every target that has it, or with a `loom.*` diagnostic (text in `src/diagnostics/messages.ts`, a row in `unsupported-register.ts` when it is a gap, the firing census updated).
5. **Mutation-prove and name the assertion.** The PR body states which test fails when the fix is reverted (file copy, never `git checkout --`; unique backup names — §84/§87/§92). A green first run proves nothing.
6. **Seam-first when the row has siblings.** If the same defect exists on ≥3 targets, land one classifier/helper in the shared layer with per-target readers, and a census test that a new reader cannot bypass (§89, §92). Do not land three copies of a fix.
7. **Byte-identical gate on every refactor.** A seam extraction changes no emitted byte; prove it with the existing corpus snapshot diff before and after (the PR #843 / #607–#627 protocol).
8. **Before pushing, `npx tsc -b` and `npm test` on the merged tree, and grep the open PR list for in-flight consumers of any rule you mint** (§86 — a validator, a required artifact, a matrix-fed fixture).
9. **Close the loop in docs**: ledger row → `done` bucket with the PR number; mission status line flipped with a file:line; no new counts in prose (§91 — make the number code).

Model choice: **Opus** for anything security/data-integrity, cross-backend, needing a design ruling, or a seam refactor; **Sonnet** for register-driven S-size rows with a proven repro and a named tree, docs/ledger reconciliation, CI/config, and mechanical corpus promotion under a written recipe. Every agent gets the two-line RUNBOOK kickoff plus the packet block below.

---

## 4. The waves

### Wave 0 — land the ready queue, reconcile the ledger (1–2 days, Sonnet ×2 + owner merges)

Nothing new is built until the eight ready PRs are in; three of them touch the same hotspots the next wave needs (`ui-checks.ts`, `unsupported-register.ts`, the walker targets).

- **0.1 Merge order** (minimises rebases): #2628 (docs) → #2713 (test infra only, no emitter change) → #2671 → #2672 → #2674 → #2678 (numeric fleet, in dependency order) → #2720 → #2721 → #2723 (W2 packets; each rebased after the previous lands — squash-merge invalidates stacked children, §87). A Sonnet agent drives each rebase, re-runs `npm test` + the packet's compile leg, and re-requests review; the owner merges.
- **0.2 Ledger reconciliation** (Sonnet, docs-only): move every row landed by W1/W1b/W2/#2719/#2726 into the ledger's `done` bucket with the PR number; re-count the `.md` header from the JSON (a script, not a hand tally); flip `M-T9.36 → open (unblocked)`, `M-T9.38 → blocked(#2678, #2674 merge)`; record the W1b `F2-ADP-3` handoff as a validator-packet row. This is the input Wave 1 agents trust.
- **0.3 Open-PR collision scan** for W3/W4: #2729 and #2723 both edit `ui-checks.ts`; #2729 must rebase after #2723 merges. Note it on #2729.

Exit: 0 ready PRs older than 3 days; ledger `open` count equals the §0 residue.

### Wave 1 — close the P0/P1 silent residue (1 week, 5 Opus + 2 Sonnet, tree-fenced)

Parallel packets, one agent each, the wave plan's sequencing rules honoured (`cli` first; `VAL-1` before other validator rows; ESCAPE-FUNNEL first in elixir).

| packet | model | rows (in order) | tree |
|---|---|---|---|
| **1a validator + cli** | Opus | `ir-warnings-invisible-in-cli` → `F2-VAL-1` → `F2-ADP-3` gate → `timer-tz-overlap-inert` gate → `eventlog-shape-silently-ignored` → `M-T5.9` → `M-T6.18-gap3` → `M-T5.25` → `CB-C9`/`CB-C10`/`EXPR-5` messages → `M-T3.8` diagnostic slice | `src/cli/**`, `src/ir/**`, `src/diagnostics/**`, `src/language/validators/**` |
| **1b dotnet-adapters** | Opus | `F2-ADP-1` → `F2-ADP-4` → `F2-ADP-2` → `G2667-D3` → `M-T3.9` VF → `G2667-D4` VF → `dapper-no-schema-evolution` *decision* (gate it honestly this wave; building the ALTER path is a T2 mission) | `src/generator/dotnet/**` |
| **1c node-ts** | Opus | `F2-ADP-5` → `F2-ADP-6` → `F2-CB-C8` → `F2-EXPR-4` → `M-T6.51` → VF rows (`W-05`, `CB-C1`, `money[]`) → `M-T5.14` → `static-subpath-405` (four backends: hand off the non-node arms) | `src/platform/hono/**`, `src/generator/typescript/**` |
| **1d elixir** | Opus | `F2-ELX-ESCAPE-FUNNEL` (route all four sites through the existing escape helper; add the census in Wave 2.2) → `F2-W-01` → `F2-FFE-6` → `M-T6.26` → `grapheme-vs-codepoint` → `F2-MT640-SORT-DEAD` → `M-T6.2-s14` → `G2667-C7` decision | `src/generator/elixir/**` |
| **1e python + macros** | Sonnet | `M-T6.50` (three collector gaps — migrate them onto `walk.ts`, do not patch the switch) → `M-T1.15` → `provenanced-bare-read-in-page-body` → `M-T1.26` | `src/generator/python/**`, `src/macros/**`, `_walker/primitives/text.ts` |
| **1f frontend-js (after #2720)** | Sonnet | `F2-CFE-2` → `F2-CFE-8` → `M-T1.8` (error boundary on the five targets that lack it) → `M-T1.12` → `G2667-D8` | react/vue/svelte/angular, `designs/**` |
| **1g SSE auth** | Opus | `M-T4.12` — every generated SPA 401s its own realtime stream under `auth: required`; land the `_frontend/realtime.ts` credential path per backend's auth style and the realtime plan contract (§F4) so stream auth stops being re-decided per backend | `src/generator/_frontend/realtime.ts`, `src/ir/util/realtime-rooms.ts`, per-backend SSE plugs |

Each packet's PR body carries the row table (fixed / gated / handed-off / verified-already-done) in the W2 format. Exit: ledger P0 = 0, P1 silent = 0 or handed off with a named owner; `main` green after each merge (0.1's rebase protocol).

### Wave 2 — seams: fix the class, not the next instance (1–2 weeks, Opus ×4, each byte-identical-gated)

Every item here is a defect family with ≥3 landed instances. Each PR is a refactor + a completeness census, and its diff on the corpus snapshots is empty.

- **2.1 M-T9.36 numeric wire-codec seam** (now unblocked). One per-backend codec table (money = F4 string, decimal = float64, int/long = integer) consumed at every read boundary; a boundary-enumeration test so a new read path must declare its codec. Sequenced after the numeric fleet merges (Wave 0). Retires the #2545→#2631→#2675/#2677 series for good.
- **2.2 One string-escape funnel per target.** Elixir `#{`, HEEx attributes, Angular text slots (A15), F#/Dart string literals, Java/C# identifiers: one `escapeStringLiteral`/`escapeAttr` pair per target on the `ExprTarget`/`WalkerTarget` seams, and a lint-style test that fails on a `JSON.stringify(` splice in `src/generator/**` that lands in a non-JS literal position (173 such sites in the elixir emitters today; most are legitimate JSON, the test must classify by destination). Closes the class `F2-ELX-ESCAPE-FUNNEL` belongs to.
- **2.3 No hand-rolled IR walks.** A census test: every `switch (e.kind)` / `switch (s.kind)` over `ExprIR`/`StmtIR`/`WorkflowStmtIR` outside `src/ir/util/walk.ts`, `_expr/target.ts`, `_stmt/target.ts`, `_workflow/stmt-target.ts` and the lowerers is either `never`-checked (exhaustive) or waived with a reason that ratchets. Migrate the offenders it finds (the #2720/#2705/M-T6.50 class). Pairs with #2713's `model-exprs.ts` census.
- **2.4 Emission mode as a declared seam (§F2).** The java JPQL `principalAccessors` branch and its siblings become a declared *mode* on the shared render context that refuses out-of-vocabulary constructs, instead of a per-arm `if`. Small; mostly a contract test.
- **2.5 Seeder contract (M-T6.52).** After W1's seed family: one shared "what does the seeder know" model (aggregate shape, principal, dataset identity) with five readers — the remaining event-sourced seeding on elixir/java/dotnet rides it.
- **2.6 Hotspot splits (mechanical, Sonnet).** `system-checks.ts` (4.3k) and `ui-checks.ts` (3.0k) split into per-theme leaves the way `validate.ts` already fans out; `mikroorm.ts` (3.5k) split by shape (relational/document/embedded/ES). Diagnostic set byte-identical (the M-T9.33 firing census is the proof), emitted output byte-identical. Purpose: packet fences stop overlapping, and #2723-vs-#2729-style conflicts stop recurring.

Exit: the 08-24 §F queue rows F2/F3/F5 read `done`; M-T9.36 `done`; no new `G*-C` register row of the "same defect, next backend" shape in the following review.

### Wave 3 — verification that can see runtime values (2–3 weeks, Opus ×3 + Sonnet ×3; starts once #2713 is in)

The 08-31 audit's rule: one gate per feature×target cell at the strongest tier. Wave 1's P0s were all runtime-value defects behind green compile gates. This wave moves cells up a tier.

- **3.1 M-T9.37 wire-golden precision** (Sonnet, S–M, P1): the comparator can never fail on excess precision — the gate that was blind to M-T6.46 by construction.
- **3.2 M-T9.42 corpus promotion campaign** (Sonnet ×2, batches of ~5 scenarios): of the 42 scenarios duplicated across ≥3 target test dirs, 39 have no corpus fixture. Recipe per scenario: one `.ddd` + manifest row (five compile cells) → behavioural block + golden (five runtime cells) → delete the per-target string copies the ledger now proves redundant. `temporal` first (813 LOC → ~60). The gate ledger (#2713 C1) is the deletion authority; nothing is deleted on judgement.
- **3.3 The E2E-less register** (Opus): `E2E_LESS_CORPUS_FIXTURES` (`test/ir/api-caller-census-pins.ts`) still waives 13 fixtures — `collection-op-shapes`, `numeric-operands`, `projection-agg-filters`, `projection-document-aggregation`, `api-call`, `channels-broker`, `extern`, `extern-handlers`, `handler-resource-ops`, `handler-triad`, `outbox`, `resources`, `tenancy-hierarchy` — the same set the gate ledger reports as compile-only. Two are witness-by-design (`collection-op-shapes`, `numeric-operands` — their oracle is the compile tier or a pure `test` block). The other 11 each name a blocker; §90/§92 record that in three of the last three drains the stated blocker was not the blocker. Start with `projection-agg-filters` and `projection-document-aggregation` (the two cells that exist *because of* a cross-tenant COUNT leak) and `tenancy-hierarchy`, using the two-principal harness (M-T9.28 slice 1) — re-derive each waiver's nouns against the code, then run it.
- **3.4 M-T9.38 Flutter/Feliz runtime leg** (Opus, L): a money crash shipped behind a green compile gate on both self-hosting frontends; unblocked by Wave 0.
- **3.5 M-T9.41 tenancy/authz/masking proof on emitted code** (Opus, L): re-scoped by #2713 — the proof belongs on each backend's read paths, not on the IR.
- **3.6 M-T9.39 i18n round-trip gate** (Sonnet, M): every catalog key has a consumption site per target and every user-visible slot has a key; the A13-instance gate exists, the general one does not.
- **3.7 B7 + A7 CI economics** (Sonnet, S): java `-Xlint:all -Werror` (the one compile leg not at max strictness); collapse the ~60 per-backend npm legs into parameterised legs + one matrix so a new corpus feature costs one row, not five workflow edits.
- **3.8 Pairwise axes after #2728** (Sonnet): the next axis pair the 08 findings named — `persistence:` adapter × saving shape × capability. Three findings from a young corpus is a discovery rate; keep widening while it finds things.

Exit: gate-ledger compile-only cells 69 → ≤ 40 with the two leak cells and `tenancy-hierarchy` at the behavioural tier; the wire-golden set covers every numeric-divergence row the 08-23 audit listed.

### Wave 4 — process, and the class no gate can see (continuous, Sonnet ×1, owner clicks)

- **4.1 §86 merge-pair defence in the hook layer.** The `PreToolUse` push hook already dry-runs `git merge-tree`; extend it to run `npx tsc -b` on the merged tree when the merge is clean (≈1 min; the §87 TS2304 case). The RUNBOOK gains the rule "a PR that mints a rule greps the open-PR list for consumers before merge".
- **4.2 F6 fix-scope rule for remediation fleets** into the RUNBOOK (the W1b/W2 hand-off format becomes the written norm).
- **4.3 §93 unresolved mechanism** — the pr-gate "expected" block with a successful check on the head: an owner compares the ruleset's required-check app identity with the check run's `app`. Until then the remedy stays empirical (fresh SHA + fresh evaluation); write nothing else down as cause.
- **4.4 M-T9.6 status hygiene** after each wave: README "last refreshed", the T9 `M-T9.36`/`M-T9.38` lines, `coverage.md` rows for drained audits. A count that appears in prose becomes code (§91).
- **4.5 Merge queue**: still the structural fix for §86 and still inert on a personal-account repo. Recorded, not scheduled.

---

## 5. Kickoff prompts

Per packet (copy, replace the bracketed parts):

> Implement wave **[1b dotnet-adapters]** from `docs/new-plan/improvement-waves-2026-09.md` — rows **[F2-ADP-1, F2-ADP-4, F2-ADP-2, G2667-D3, M-T3.9 (verify-first), G2667-D4 (verify-first), dapper-no-schema-evolution (decision)]**, tree **`src/generator/dotnet/**`**. Follow `docs/new-plan/RUNBOOK.md` end to end and §3 of the wave plan: fresh `main`, verify each row against the code and the merged PR that mentions it, claim with a draft PR titled `W5 dotnet-adapters: …`, mutation-prove every fix and name the failing assertion in the PR body, hand off anything outside the tree, close the ledger rows in `docs/audits/targets-completeness-2026-08-30.ledger.json`.

For a seam wave item, add: *"Byte-identical emission across the refactor is a hard gate — diff the corpus snapshots before and after and state the result; the census test must be mutation-proved by adding one unregistered [boundary / reader / walk]."*

## 6. Success metrics (measured, not asserted)

| metric | now | after W1 | after W3 |
|---|---|---|---|
| ledger P0 open | 4 (3 + the ADP-3 gate) | 0 | 0 |
| ledger P1 silent open | ~21 | 0 (or handed off with owner) | 0 |
| gate-ledger compile-only cells | 69 / 289 | 69 | ≤ 40 |
| `E2E_LESS_CORPUS_FIXTURES` | 13 | 13 | ≤ 8 (the two witness-by-design rows stay) |
| "same defect, next backend" rows minted per review | 5 (08-24 §C/§D) | — | 0 |
| `main` red incidents / week (M-T9.31 delta) | 0 this week | 0 | 0 |

The weekly quality delta (M-T9.31) is the pinned metric; if a wave moves the ledger but the delta shows new `fix:` cascades of one root cause, the wave was instance-level and the seam item it belongs to moves up.
