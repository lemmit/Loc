# Loom verification waves — 2026-09 (gate promotion, honest instruments, coverage)

*Snapshot: `main` @ `36d8516` (2026-09-03). Companion to [`improvement-waves-2026-09.md`](improvement-waves-2026-09.md) (PR #2751), which owns the silent-gap drain, the class-level seams and the runtime-value verification tier. This plan owns what that plan leaves out: **(1) making the runtime gates binding per-PR**, **(2) the instruments that cannot fail**, **(3) direct tests for the shared cores nothing pins**. It forks no status table — mission statuses stay in the track files; ledger rows stay in `docs/audits/targets-completeness-2026-08-30.ledger.json`.*

*Every row below was code-verified on this head by a four-agent survey (gate triggers, instruments, structural seams, coverage). Three candidate rows were found already closed and are recorded in §2 so nobody rebuilds them.*

---

## 0. Why this plan exists

The 2026-08 quality audit's core finding still holds: fixes are discovered by audits (~58–60%), not by gates. The weekly delta on issue #2580 shows the gate share at 40% then 0% over the last two windows, and the runtime legs most correlated with real bugs — observability ×5, OIDC ×5, tenancy, channels, the four generated-frontend smokes — run only on `push: main` or by label. Whatever they catch, they catch on a red `main`.

Two structural facts set the shape of this plan:

- **Binding is emergent, not configured.** `scripts/pr-gate.mjs` fails `pr-gate` on any non-passing check run on the head SHA; a path-skipped workflow produces no run and is OK by construction. So **the only change that makes a post-merge gate binding per-PR is a `pull_request:` trigger with `paths:`** — no `pr-gate.yml` edit, no branch-protection change, no required-checks manifest edit (`pr-gate.yml` already lists all 66 workflows; the `lane` field in `merge-queue-required-checks.ts` is documentary).
- **The merge queue stays inert** (personal-account repo) and "require branches up to date" is `blocked(admin)` (M-T9.7). Both are owner clicks, recorded here, not scheduled.

The waves are ordered so that (G0) the two flaky legs and the doc drift are fixed first, because a promoted gate with a 40% pass rate is a `pr-gate` red on 60% of PRs; (G1) the cheap, docker-light gates are promoted first with narrow paths; (G2) the instruments that hide bugs are fixed; (G3) the untested shared cores get direct tests, which are file-disjoint and can run entirely in parallel.

---

## 1. In flight — the do-not-duplicate fence

| PR / wave | claims | what this plan does about it |
|---|---|---|
| #2751 **W3.1** | M-T9.37 wire-golden precision | **Not ours.** One finding to hand W3.1: the goldens are stored *post-parse* (`test/behavioral/wire-differential.mjs` `readGolden`/`writeGolden`), so the digit string is destroyed on disk, not just in the comparator; and the stated blocker M-T6.46 landed (#2677), so no java waiver is needed. All 52 goldens are `String(Number(s)) === s`-canonical today, so a text-level comparator is green on them as committed — the exposure is on the non-oracle legs. |
| #2751 **W3.3** | draining `E2E_LESS_CORPUS_FIXTURES` with the two-principal harness | G2.2 (the authz-gate census) is the ratchet that *counts* refused callers; W3.3 *adds* them for E2E-less fixtures. Fence on `test/behavioral/cases.mjs`: G2.2 adds `AUTHZ_LADDERS` entries only for fixtures that already carry a `test e2e` block (`policy-deny`, `policy-document`, `field-mask`, `union-find-absence`); W3.3 owns the E2E-less ones. |
| #2751 **W3.5** | M-T9.41 emitted-source census | Not ours. |
| #2751 **W3.7** | collapse the ~60 per-backend npm legs into parameterised legs | **Sequencing:** G1 lands before W3.7, so the collapse parameterises the promoted triggers too. If W3.7 lands first, G1 re-targets its edits onto the collapsed workflows. |
| #2751 **W2.6** | mechanical split of `system-checks.ts` / `ui-checks.ts` | G2.3 touches `src/diagnostics/unsupported-register.ts` line refs into `system-checks.ts`; lands **after** W2.6 or re-derives the refs. |
| #2752 (Wave 1) | `unsupported-register.ts` (`MAX_OPEN_GAPS` bump), hono v4 route files, `query-projection-emit.ts` | G2.3 waits for #2752, #2720, #2729 to merge (all three touch the register). |
| #2759 | mission-status audit; archives 76 closed missions; rewrites README and the T9 headings; flips M-T2.14 / M-T6.44 / M-T6.46 to `done` | This plan mints nothing into a track file until #2759 merges. Two flips #2759 does **not** carry are handed to G0.2: **M-T6.41 → `done`** (#2667, `src/generator/dotnet/query-projection-emit.ts` `aggregationCapabilityFilters`) and the Schemathesis register's **F27 → fixed** (#2719). |
| #2754 | M-T9.42 `temporal` corpus promotion | Not ours (W3.2). |
| #2755 | Schemathesis F30 (dotnet) | G2.4 excludes F30. |
| #2720 / #2729 / #2723 / #2721 | W2 frontend packets | G3's `_frontend` tests are additive test files; no `src/` edit, no conflict. |
| #2647 (merged) | direct-`generateSystems` importer ratchet | G2.2 and every G3 test must go through `test/_helpers/generate.ts`, never import `generateSystems` directly. |

---

## 2. Rows verified closed or declined on this head

| candidate | verdict | evidence |
|---|---|---|
| M-T9.9 typed authz-filter IR | **done** (tracker agrees) | `kind: "authz-filter"` at `src/ir/types/loom-ir.ts:3757`; `_expr/target.ts:331-340` throws on the generic arm; 28 consumer files dispatch by `kind` with `_exhaustive` never-checks. The successor is M-T9.41 (W3.5). |
| M-T2.14 `columnTypeEqual` precision/scale | **done** (#2669) — #2759 flips it | `src/system/migrations-builder.ts:2666-2679` compares `precision`/`scale`; `decimalBoundWidens` at `:2694`; unit + e2e witnesses shipped. **Residual, unmissioned:** `ColumnShape.default` is never diffed and no `alterColumnDefault` op exists — a default change emits no migration. Recorded in G2.5. |
| M-T6.41 dapper aggregation residue | **done** (#2667) — tracker stale | `aggregationCapabilityFilters` applied at both the whole-table (`:661`) and grouped (`:857`) arms. G0.2 flips the header. |
| M-T9.26 `RouteTarget` seam | **defer** | No `src/generator/_route/`; the five backends render from `deriveAggregateOperations`, not `deriveContextOperations`; slice-1 blast radius is 11.8k LOC of `src/platform/hono/v4/**`, and #2752 edits three of its six files. Only the S-sized re-measurement is worth dispatching, after W2. |
| promote `channels-e2e` / `api-call-e2e` | **do not promote** | 18 + 5 cells, docker-in-runner brokers, 35-minute legs, neither has `merge_group:`. The `run-channels` / `run-api-call` labels stay the pre-merge path. |
| promote `phoenix-ui-e2e` | **blocked(#2718)** | 40% first-attempt pass rate over the last 20 `main` runs. G0.1 owns the root cause; promotion moves to G1 only after the flake-budget issue closes. |
| promote `tenancy-e2e` as-is | **needs design** | 12-cell matrix + rollup = 13 jobs, over half the ~20-slot pool from one workflow. G1.5 promotes only the `flat` legs per-PR via an event-conditional matrix. |
| `src/cli/main.ts` unit tests | **declined** | The module exports nothing (Commander program built at module scope); 15 black-box files cover the surface. A seam would be a `src/` refactor, not a coverage packet. |
| `src/verify` rollup tests | **declined** | `test/cli/verification.test.ts` already pins all-pass, partial, missing result, no-tests, suite disambiguation. Only the render half is untested (G3 VERIFY-1). |

---

## 3. Mechanics every gate-promotion packet must get right

Verified against the tests that pin workflow files; each was a trap an agent would walk into.

1. **The trigger.** Add `pull_request: types: [opened, synchronize, reopened, ready_for_review]` with a `paths:` list mirroring the sibling `behavioral-e2e-<backend>.yml` PR block (`src/ir/**` + the gate's own narrow globs + the workflow file itself). Keep the existing `push: main` block untouched — it stays the post-merge regression net and keeps `ci-red-alarm` coverage. `test/system/workflow-path-coverage.test.ts` unions globs across all triggers, so a narrow PR block passes as long as the push block already carries the five generation trees (all targets do).
2. **Never use YAML anchors for `paths:`.** `workflow-path-coverage.test.ts`'s header regex does not match `paths: &paths` / `paths: *paths`; `pairwise.yml` and `context-integration-e2e.yml` are silently outside that gate today. Duplicate the list.
3. **Replace the label guard.** `if: github.event.label.name == 'run-x'` is `false` on `opened`/`synchronize`. Drop `labeled` from `types:` and use the canonical draft guard **verbatim** — `test/system/draft-gate.test.ts` matches the literal string `github.event_name != 'pull_request' || github.event.pull_request.draft == false` on every entry job. Keeping `labeled` exempts the file from draft-gate enforcement *and* makes `paths:` apply to the label event, which defeats the label anyway.
4. **Concurrency.** Twelve targets carry `cancel-in-progress: false` (deliberate for `push: main` attribution). On a PR trigger that leaks runner slots. Use the shape `elixir-vanilla-obs-e2e.yml` already has: `group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
5. **Nothing else.** No `pr-gate.yml` edit; no `merge-queue-required-checks.ts` edit (adding a row would demand `merge_group:` — extra scope); no `run:` line edits (`workflow-npm-scripts.test.ts` bans computed script names); `docs/testing.md`'s reverse index already has a row for all 23 workflows.
6. **Local proof.** There is no `act`. The proof is: `npx vitest run test/system/draft-gate.test.ts test/system/workflow-path-coverage.test.ts test/system/pr-gate.test.ts test/system/merge-queue-readiness.test.ts test/system/local-run-mapping.test.ts test/system/main-red-alarm-coverage.test.ts test/system/workflow-npm-scripts.test.ts` (7 files, green in ~3 s on this head) plus `python3 -c "import glob,yaml;[yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]"` and `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest`. Trigger matching itself can only be proven by a PR that touches one path in the new list and shows the check appear — say so in the PR body.
7. **Fix the header prose in the same edit.** Every target's header comment argues for staying post-merge (`hono-obs-e2e.yml:13-18`, `generated-react-e2e.yml:28-32` "has caught zero regressions per-PR", …). A promoted workflow whose comment asserts the opposite is the §59 shape.
8. **Flake telemetry does not see PR runs.** `scripts/flake-budget.mjs` queries `main` only. A promoted gate's PR-side flake surfaces as red `pr-gate` on unrelated PRs and nowhere else. G0.1 is a prerequisite, not a nicety.
9. **Doc edits are serialised into one packet.** Every promotion wants the same paragraphs in `docs/ci-gating.md` (the blind-spot bullet, the tier table, the label table, the "80/20" section), `docs/testing.md` rows 38/39/42, and `CLAUDE.md`'s "post-merge blind spot" sentence. None is test-pinned. Packets touch only their own workflow files; G1.7 rewrites the documents once against what actually landed.

---

## 4. The waves

Model: **Opus** for every packet unless marked *(Sonnet-capable)*. One draft PR per wave (§3a of the companion plan), packets on `verif-N/<packet>` sub-branches, coordinator folds. G3's packets are test-only and file-disjoint, so its wave can fold daily.

### Wave G0 — prerequisites (Opus ×2 + Sonnet ×1; one PR for code, docs ride #2759's wake)

| packet | rows | tree | notes |
|---|---|---|---|
| **G0.1 flake root causes** | (a) #2718 `phoenix-ui-e2e` 40% first-attempt pass rate; (b) #2579 `schemathesis` 30% — the register's own W26 note shows the mechanism: findings are data-dependent, so a known root cause reaching an unclaimed surface (`POST …/{id}/update`, `…/freeze`) arrives **unwaived** and fails the run identically to a new bug; (c) #2636 `frontend-fullstack-e2e` 25% | `src/generator/elixir/**` + `test/behavioral/heex-ui*`; `test/behavioral/schemathesis-*.mjs` + `schemathesis-waivers.json`; `test/behavioral/run-ui*.mjs` | Start from the failing run artifacts (`schemathesis-reports-<backend>`, the Playwright traces), not the summary. For (b) the fix is pattern-complete waivers keyed on root cause plus a deterministic pinned case per `intermittent` rule (the shape #2615 took for W6), not wider `intermittent` flags. Mutation proof: re-seed the last real defect the leg caught and show it still fails; then 20 consecutive green local runs. Exit: all three `flaky-gate` issues closed by the budget script, not by hand. |
| **G0.2 doc drift (after #2759 merges)** *(Sonnet-capable)* | M-T6.41 → `done` (#2667); Schemathesis F27 → fixed (#2719); `docs/testing.md` rows 38 (generated frontend runtime is post-merge only, omits react/angular), 39 (obs is post-merge), 42 (pairwise **is** per-PR path-scoped since #2690); the T9 prose that narrates `MAX_OPEN_GAPS` as 42 → 37 while the pin is 46 (§91: make it a computed number or delete it); `src/diagnostics/unsupported-register.ts` `site:` lines are drifted on all six adapter rows (register says 2629/3127/1460/1594/1903/2873; raisers are at 2900/3185/1704/1838/2147/3140) | `docs/**`, `src/diagnostics/unsupported-register.ts` (line refs only) | Docs-only except the register line refs. The register fix is the input to G2.3's gate. |

### Wave G1 — promote the runtime gates (Opus ×4 + Sonnet ×1 + coordinator; **one PR**, lands before #2751 W3.7)

Cost budget (re-priced — see §7.2: `pull_request` path filters match the PR's cumulative diff, so this is 19 jobs on *every* push to such a PR, not only on pushes that touch a listed path): packets 1.1 + 1.2 + 1.3 + 1.4 add **19 jobs** to a maximally broad PR on a ~20-slot pool that already fires 30–50 jobs per push. The narrow `paths:` are what make this survivable; a PR block broader than its sibling `behavioral-e2e-<backend>` leg's is the thing to reject in review. The hono obs header's anti-abuse note ("three concurrent docker runs … the shape anti-abuse heuristics watch for on public repos") is the one documented objection with teeth; the answer is paths narrow enough that a typical PR fires one or two of the five, plus the concurrency fix.

| packet | workflows | jobs | docker | paths (PR block) | risk |
|---|---|---|---|---|---|
| **1.1 obs ×5** | `hono-obs-e2e`, `python-obs-e2e`, `java-obs-e2e`, `dotnet-obs-e2e`, `elixir-vanilla-obs-e2e` | 5 | 4 of 5 (hono is pure node) | `src/ir/**` + each file's own backend globs from its push block (`src/generator/<backend>/**`, `src/platform/<backend>.ts`, `src/generator/_obs/**`, its `test/e2e/observability-events-*.test.ts`) | `_obs/**` fans out to three legs — acceptable |
| **1.2 generated-frontend e2e ×4** | `generated-react-e2e`, `generated-vue-e2e`, `generated-svelte-e2e`, `generated-angular-e2e` | 9 | none | mirror `generated-<fw>-build.yml`'s PR block **including its `!src/generator/{java,dotnet,python,elixir}/**` negation tail** (path-coverage ignores `!` entries) | these four have **no** `pull_request:` today, so they enter draft-gate enforcement for the first time — `types:` and the literal guard are both mandatory. The header's "zero regressions per-PR" claim predates the react/angular files and must be rewritten. Cheapest packet operationally. |
| **1.3 oidc native ×4** | `hono-oidc-e2e`, `python-oidc-e2e`, `java-oidc-e2e`, `dotnet-oidc-e2e` | 4 | all (Keycloak + postgres pulls; backend native) | as 1.1, plus `src/generator/_auth/**`, `src/generator/_frontend/auth-ui.ts` | unauthenticated Docker Hub pulls ×4 per PR; watch for rate limits on the first week |
| **1.4 elixir VO wire** *(Sonnet-capable)* | `elixir-vanilla-vo-e2e` | 1 | postgres service | `src/generator/elixir/vanilla/wire-serialize.ts`, `render-expr.ts`, the test | the cheapest promotion in the list; shares `run-e2e` with `phoenix-ui-e2e`/`playground-e2e` — split the label-table row |
| **1.5 tenancy flat legs** | `tenancy-e2e` | 6 of 13 | postgres service | its existing file-level PR paths | promote only the `flat` matrix legs on `pull_request` via `if: github.event_name != 'pull_request' || matrix.leg == 'flat'`-style conditioning; `hierarchy`/`subtree-explain` stay on `run-tenancy`. Needs `merge-queue-readiness.test.ts` `:194-197` re-checked (the required job's `if:` must not be `pull_request`-only). |
| **1.6 migration-evolution** | `migration-evolution-e2e` | 6 | postgres + host `psql` | already has `synchronize, reopened` and the `contains(labels)` form; add `opened, ready_for_review`, a `paths:` mirror, the draft guard | the longest single leg (35-minute cap) — measure the pr-gate cycle before and after; revert if it pushes the cycle past the documented ~45 min under load |
| **1.7 docs (last commit of the wave)** *(Sonnet-capable)* | — | — | — | `docs/ci-gating.md`, `docs/testing.md`, `CLAUDE.md` §CI surface, the `run-obs`/`run-oidc`/`run-e2e` label rows | rewritten once against what actually landed |

Deferred with reasons (§2): oidc compose ×2 (`elixir-oidc-e2e`, `auth-oidc-compose-e2e` — image builds in the runner), `channels-e2e`, `api-call-e2e`, `phoenix-ui-e2e` (until #2718), `tenancy` hierarchy legs.

Exit: obs, oidc-native and the four SPA smokes produce a check run on every PR that touches their surface; the next two weekly deltas on #2580 show the gate-discovered share above the audit share at least once; no `flaky-gate` issue opened against a promoted leg.

### Wave G2 — instruments that cannot fail, and the census that counts refusals (Opus ×3 + Sonnet ×1; **one PR**)

| packet | rows | tree | size |
|---|---|---|---|
| **2.1 the legacy generate path** — *mint as* **M-T9.44** *after #2759 merges (M-T9.43 is reserved by M-T9.42's text for the evaluated-value-table shape; mint that heading at the same time so the reference stops dangling)* | `generateHono` (`test/_helpers/generate.ts:19-20`) is one line with no checks: **66 call sites in 37 files** (not the 93 #2713 reported) bypass phases ⑤/⑥/⑦ and the IR verifier; 25 of those files also bypass ① and ④ (they use `parseString`, not `parseValid`). Route 1: add `assertModelVerifies(model)` — `lowerModel` → `mergeLoomModels` → `enrichLoomModel` → `assertLoomModelVerifies` → `validateLoomModel` — and call it from `generateHono`; synchronous, zero call-site churn. Slice 2: migrate the 25 `parseString` files to `parseValid`. Plus a ratchet modelled on `test/system/direct-generate-systems-ratchet.test.ts` so the legacy path can only shrink. | `test/_helpers/generate.ts`, the 37 test files (fixture repairs), one new ratchet test | M |
| | **Mutation proof:** re-seed the M-T9.40 mutation (`enumName: undefined` in the enum-value lowering) and show the four `test/generator/hono` tests that were silent now fail with `IR verification failed`. Measure the blast radius before claiming — `npx vitest run test/generator/typescript test/generator/hono test/generator/_packs` after Route 1 is the number. | | |
| **2.2 M-T9.28 slice 2 — the authz-gate census** | For every operation that carries a `requires` / `policy` rung / `mask unless` / tenancy predicate across the corpus and `examples/`, assert an `AUTHZ_LADDERS` entry names a caller that must be **refused**; shrink-only pins for the rest. Enumerate by unioning `deriveContextOperations` with `apiSurfaceCoverage.notLifted` (`prepare`, `workflow`, `workflowInstances`, `explicitHandler`, `projectionQuery`, `history` — the six route classes the validator gates but the derivation does not lift; a naive census under-counts exactly the surfaces #2446 shipped ungated). The M-T3.15 premise in older notes is stale: `validateDefaultDeny` enumerates all eight classes on this head. Reuse `E2E_LESS_CORPUS_FIXTURES` as the honest-exemption list — do not mint a second one. | `test/ir/authz-gate-census.test.ts`, `test/ir/authz-gate-census-pins.ts`, `test/behavioral/cases.mjs` (+3–4 ladders: `policy-deny`, `policy-document`, `field-mask`, `union-find-absence`) | M |
| | **Mutation proof:** seed a no-op `requires` and show the ladder (not the e2e) catches it — the proof recorded at `test/ir/api-caller-census-pins.ts:642`. Fence: W3.3 owns ladders for E2E-less fixtures. | | |
| **2.3 the register that cannot notice a moved raiser** *(Sonnet-capable; after #2752 / #2720 / #2729 merge)* | `test/system/unsupported-register.test.ts:247` validates `site:` only by regex shape, never that the line exists or raises that code — all six adapter rows are drifted today. Strengthen to resolve the file and assert the row's code appears within ±N lines. Then the M-T6.35 re-classifications: `loom.persistence-mode-unsupported` (a missing `dataSource` binding, not an adapter gap — re-own), `loom.saving-shape-unsupported` (empty latent seam — re-classify), mikroorm `#scalar-array` (S emitter drain; drizzle stores it natively). | `test/system/unsupported-register.test.ts`, `src/diagnostics/unsupported-register.ts`, `src/generator/typescript/emit/mikroorm.ts` (scalar-array only) | S |
| **2.4 Schemathesis single-backend drain** | Open on this head: F16/F17 (python), F20/F22 (dotnet), F26 (java `Allow` on 405), F5 grapheme residual (elixir). Excluded: F30 (#2755), F18 (W1c handed off the non-node static-subpath arms — verify-first), F9/F28 (by design/decision). **Mint two five-backend missions rather than fixing per backend:** F11 (int32/int64 ranges declared and enforced — five emitters plus the shared zod, no choke point) and F19/F21/F23 as one class ("published but unenforced at the wire boundary", open on dotnet + java). Each waiver deleted in the same PR as its fix. | per-backend wire/validator emitters, `test/behavioral/schemathesis-waivers.json`, `docs/audits/schemathesis-findings-2026-08.md` | S each; the two missions L |
| | **Mutation proof:** the leg must **fail** with the fix reverted and the rule already deleted — proving the deletion is the ratchet firing, not the fuzzer having stopped reaching the case (the register's own W10 story). | | |
| **2.5 register the migration-default residual** *(Sonnet-capable)* | `diffSchema` compares only `nullable` and `type`; `ColumnShape.default` is never diffed and no `alterColumnDefault` op exists. One T2 mission row + a unit witness in `test/ir/migrations-builder.test.ts` asserting the current (wrong) behaviour is pinned as a known gap, or the op if the agent judges it S. | `docs/new-plan/T2-data-evolution.md`, `src/system/migrations-builder.ts`, `src/ir/types/migrations-ir.ts`, `src/generator/sql-pg.ts` + five consumers if built | S (register) / M (build) |

Exit: `generateHono` asserts every phase `generateSystemFiles` asserts; every corpus authz gate has a refused caller or a reasoned pin; the register test can fail on a moved raiser; six Schemathesis waivers deleted with their fixes.

### Wave G3 — direct tests for the shared cores (Opus ×4 + Sonnet ×6 + coordinator; **one PR**, all packets file-disjoint and test-only)

The measurement behind this wave: 474 of 851 `src/**` modules are never referenced by path from any test; the shared frontend seam that feeds six frontends sits at a 0.07 test-to-source ratio, `src/util` at 0.19. Every packet ADDs test files only; the one exception (FUZZ-1 grows `test/_helpers/ddd-model-generator.ts`) owns that file exclusively. **No packet edits `src/`** — a defect found is reported in the hand-off note and fixed in its owner's tree, never raced.

| packet | ADDs | pins | mutation proof |
|---|---|---|---|
| **FE-1 routing & menu identity** | `test/generator/_frontend/{page-identity,menu-emitter,nav-labels,smoke-spec}.test.ts` | every entry `deriveSidebarFromUi` puts in the menu resolves to a page `buildPageModuleIndex` emitted (hidden page, area-qualified page, duplicate slot first-wins); `pageModuleSpecifier` round-trips `pageEmitPath` for `.tsx`/`.vue`/`.dart`; `withNavLabelTokens` under all three spellings | flip the `hidden` filter in `menu-emitter.ts:130` — a hidden page enters the menu |
| **FE-2 wire schemas & form props** | `test/generator/_frontend/{zod-schemas,component-prop-type,form-helpers,extern-functions}.test.ts` | `zodForRequest` ≠ `zodForResponse` on `money` (the one wire type where input ≠ output); `provenancedZod` wrapping; `emitUnionSchema` discriminator; `needsController` exactly on the non-primitive-like set; `unwrapOpt` idempotent; `initialValuesTs` emits a value for every field | make `zodForResponse` return the request shape for `money` |
| **FE-3 chrome, i18n, gates, embedding** | `test/generator/_frontend/{shell-chrome,i18n-runtime,gate-expr,embedded-spa,projections-module}.test.ts` | every chrome key the shell emits under `i18nEnabled` exists in `renderLocaleCatalog`'s output (the drift `menu-emitter.ts:112` names); `tryRenderGate` returns `null`, never a broken string, for every unsupported kind; `embedSpaInto` re-roots each path exactly once | change one `messageKey("menu", …)` namespace — the key-agreement assertion fails |
| **UTIL-1 constant agreement** *(Sonnet-capable)* | `test/util/shared-constants-agreement.test.ts` | `RENDERABLE_FILTER_PRIMITIVES` ⊆ what `filterParamKind` renders, with the held-back names absent; `PLATFORM_SAVING_SHAPES` keys are real `Platform` values; `AUTH_BASE_PATH === API_BASE_PATH + "/auth"`; `KEYCLOAK_HOST_PORT` collides with no compose default | add `"money"` to `RENDERABLE_FILTER_PRIMITIVES` |
| **UTIL-2 pure leaves** *(Sonnet-capable)* | `test/util/{dedupe,content-hash,intrinsic-matchers,auth-providers}.test.ts` | `dedupeByName` first-wins and order-preserving; `contentHash` stable/length-fixed/one-byte-sensitive; `isIntrinsicMatcher(n) ⟺ intrinsicMatcherSig(n) !== undefined`; `lookupPreset` defined exactly on `KNOWN_PROVIDERS` | flip `dedupeByName` to last-wins |
| **UTIL-3 naming edges** *(Sonnet-capable)* | `test/util/naming-edges.test.ts` (do not touch `naming.test.ts`) | already-plural input (`plural("Statuses")` → decide and pin), acronyms, digits, empty string; `workflowFnCamel/Pascal/Snake` mutually derivable and collision-free over a `(wf, fn)` table; `elixirString`/`elixirRegexBody` escaping | drop the `!/[aeiou]y$/` guard |
| **DIAG-1 message hygiene** | `test/system/diagnostic-message-hygiene.test.ts` | (a) for every `diagMessage` call with an object-literal arg, the literal's keys equal the params the template reads (Proxy-recorded); the ~9 variable-arg sites (`migration-checks.ts:251` and siblings) go on an explicit waiver with a reason; (b) no rendered entry contains `undefined` or `[object Object]`; (c) rendered texts unique across keys modulo a seeded waiver for the `*-deployable-missing-ui` family | delete a property from a builder's destructuring while a call site still passes it |
| **VERIFY-1 the render half** *(Sonnet-capable)* | `test/verify/render.test.ts` | `GLYPH` / `MMD_CLASS` total over `RequirementVerdict`; `pct(n, 0)` is `"n/a"`; every requirement id appears once in the Markdown and once as a Mermaid node, every `childrenOf` edge as an edge; JSON round-trips; a Mermaid-hostile id does not corrupt the graph | delete the `UNTESTED` row from `GLYPH` |
| **MACRO-1 registry + expander (M-T9.18)** | `test/macro/{registry-unit,expander-unit}.test.ts` | registration order; duplicate `registerMacro` throws naming both targets; `lookupMacro` on unknown returns `undefined`; `_resetRegistryForTests` empties the registry (save/restore the stdlib around it) — **or, if it cannot be exercised safely under the shared-process runner, delete it and its `index.ts` re-export**; `resolveMacroArgs` positional/named/defaulted/unresolvable-returns-`undefined`; `drainMacroDiagnostics` drains (second call is `[]`); `collectUnresolvedMacroRefs` once per site; macro-origin span points at the call site | make `drainMacroDiagnostics` return without clearing |
| **FUZZ-1 M-T9.22 slice 2** | `test/system/pipeline-fuzz-deep.test.ts`, `test/_helpers/ddd-model-shrink.ts`; grows `test/_helpers/ddd-model-generator.ts` (exclusive owner) | structure-aware shrinker (remove whole declarations, re-emit, keep the smallest reproducer — no `fast-check`: generic shrinkers do not preserve `.ddd` validity); grammar growth to UI pages + `menu {}`, value objects, workflows, `find` variants; oracle tiers: parse+validate accepts → `generateSystemFiles` on **all five** backends per seed → emitted map passes `generated-output-sentinels` and `src/ir/verify/verify-ir.ts`; `LOOM_FUZZ_DEEP=1` nightly, 2,000–5,000 seeds, `LOOM_FUZZ_SEEDS="…"` replay. The 250-seed fast leg in `pipeline-fuzz.test.ts` is untouched. | seed a defect reachable only through a new grammar arm (a VO with one field emits no schema) — fast leg stays green, deep leg fails and shrinks to two declarations |

Exit: the ten packets green in one folded run; `src/generator/_frontend` modules with zero test import 18 → ≤ 5; the untested-module count (474) re-measured and recorded in the hand-off, not in prose.

---

## 5. Kickoff prompts

Coordinator (one per wave):

> Coordinate wave **[G1]** from `docs/new-plan/verification-waves-2026-09.md` per §3a of `improvement-waves-2026-09.md`: branch `verif-1` off fresh `main`, open ONE draft PR whose body lists every packet, row and tree fence, fold each `verif-1/<packet>` sub-branch as it is handed over, re-running the §3 local proof set (and `npm test` for G2/G3) on the folded tree before each push, at most one push per day. G1 lands before #2751's W3.7; if W3.7 merges first, re-target onto the collapsed workflows. Flip to ready once, when the whole wave is green locally.

Packet (copy, replace the bracketed parts):

> Implement packet **[1.1 obs ×5]** of wave **[G1]** from `docs/new-plan/verification-waves-2026-09.md` — workflows **[hono/python/java/dotnet/elixir-vanilla obs-e2e]**. Follow `docs/new-plan/RUNBOOK.md` and §3 of the plan exactly (duplicated `paths:` lists, the literal draft guard, the PR-aware concurrency group, header prose rewritten, no `pr-gate.yml` or manifest edits). Branch `verif-1/obs` off `verif-1`; add your row table to the wave PR body as the claim; run the §3.6 local proof set and state in the hand-off note that trigger matching is proven only by the first PR that touches a listed path.

For a G2/G3 packet, replace the workflow list with the packet's rows and ADD set, and add: *"Every assertion is mutation-proved against the seeded defect the packet names; the failing assertion is quoted in the hand-off note. No `src/` file outside the packet's tree is edited — a defect found is handed off, not raced."*

## 6. Success metrics (measured, not asserted)

| metric | now | after G1 | after G3 |
|---|---|---|---|
| runtime legs producing a per-PR check run on their surface (of 23 post-merge/label workflows) | 0 | **14 landed** (obs 5, oidc-native 4, SPA 4, VO 1) — the 6 tenancy-flat legs were deferred to G1's second batch, so the "20" this row first promised was the plan's, not the wave's | 14 |
| gate-discovered share of fixes (#2580 R11; audit origin 16% gate / 58% audit) | 40% → 0% (last two windows) | above the audit share in ≥1 of the next 4 windows | sustained |
| open `flaky-gate` issues | 3 | 0 | 0 |
| `generateHono` phase coverage | ①/④ on 12 of 37 files; ⑤⑥⑦ on none | — | ①④⑤⑥⑦ on all, ratcheted |
| corpus authz gates with a refused caller | 4 fixtures | — | every gate, or a reasoned pin |
| `src/generator/_frontend` modules with no test import | 18 of 29 | — | ≤ 5 |
| Schemathesis waivers | 19 rules | — | ≤ 13, each deletion paired with its fix |

The weekly delta on #2580 stays the pinned metric. If G1 lands and the gate share does not move within four windows, the promoted paths are too narrow — widen toward the sibling `behavioral-e2e-<backend>` block, one packet at a time.

---

## 7. Findings the waves surfaced, measured before they were sized

Each row was found by a packet, handed off rather than raced, and then **measured by the coordinator** before being called small. The measurement is the point: three of these were reported as "a small follow-up" and one of them is not.

### 7.1 `test/` is excluded from `tsconfig.json` and nothing else typechecks it — **mission-sized, not a follow-up**

`tsconfig.json` carries `"exclude": ["node_modules", "out", "test"]`, and no other config covers `test/`. So none of the 1,993 `.ts` files under `test/` are typechecked by any gate: `npm run build` compiles `src/**` only, and `biome ci .` is a linter, not a type checker. Three Wave G3 packets discovered the consequence independently — a `Record<Union, …>` written in a test to prove exhaustiveness proves nothing, because the compiler never reads it.

Measured, not estimated. A `tsconfig.test.json` extending the root config with `noEmit`, `rootDir: "."` and `include: ["test/**/*.ts", "src/**/*"]`:

| config shape | errors | files |
|---|---|---|
| root config's `module`/`moduleResolution` (`Node16`) | 1,009 | — |
| vitest-shaped (`module: ESNext`, `moduleResolution: bundler`, `lib: [ES2022, DOM]`), excluding `test/fixtures/**`, `test/e2e/fixtures/**`, `test/__snapshots__/**`, `test/**/*.pw.ts` | **811** | **327** |

The first row is mostly config mismatch — 87 × TS2835 (`Node16` wants explicit `.js` on relative imports; vitest does not), 83 × TS2304/36 × TS2584 (no `DOM` lib, reached through `packages/ui-test-driver/dom-page.ts`), and TS2307 for `@playwright/test` and `@mantine/core` in files that are not part of the vitest surface. Those are exclusions and compiler options, not defects.

The second row is the honest number, and its shape says what the mission is: **384 × TS2345 and 114 × TS2322** — argument- and assignment-type mismatches, i.e. partial fixture objects handed to full IR types through loose casts. That is exactly the class the G3 packets tripped over, and it is 61% of the total.

**Why it is not landable as one change.** 811 errors over 327 files is a wave, not a commit, and a `--noEmit` step added to the fast lane before they are fixed makes every PR red. The landable shape is the one this repo already uses for waivers: a `tsconfig.test.json` plus a **per-file baseline that can only shrink**, gated like `test/system/unsupported-register.test.ts` — a file that drops to zero errors gets deleted from the baseline in the same PR, and a file that gains one fails the gate. That buys the invariant immediately (no *new* untypechecked test file, no new error in a clean one) and lets the 327 drain packet by packet.

Mint as a T9 row when the wave has a coordinator free; the numbers above are the denominator, so it does not need re-measuring first. Do not re-open it as "add `--noEmit` to the lint lane" — that was the original framing and it is wrong by 811.

### 7.2 `pull_request` path filters see the PR's cumulative diff, not the push — the §4 cost budget is written for the wrong denominator

§4's budget sizes packets 1.1–1.4 as "**19 jobs** on a maximally broad PR", reasoning per push: a PR that touches one backend's emitters fires that backend's leg. That is right for the *first* push and wrong for every one after it.

Observed on this wave's own PR. Commit `a3424bc` changed exactly one file, `docs/new-plan/verification-waves-2026-09.md` — and `java-obs-e2e` queued on it, along with the other thirteen promoted legs. `java-obs-e2e`'s `pull_request` block lists `src/ir/**`, `src/generator/java/**`, `src/platform/java.ts`, its e2e test, and `.github/workflows/java-obs-e2e.yml`. The docs file matches none of them. The leg fired because the **PR's diff against base** still contains that last entry — the workflow file this wave edited eight pushes earlier.

So the rule is: once a PR's cumulative diff touches a listed path, **every subsequent push re-fires that leg**, whatever the push itself changed. A promoted gate is therefore priced per *PR*, not per push: a PR that touches `src/ir/**` once pays all five obs legs, all four native oidc legs and the VO leg on each of its remaining pushes, docs-only follow-ups included.

**This does not change the promotion decision**, and it is not a defect in the packets — the PR-aware concurrency group every packet added (`group: …-${{ github.event.pull_request.number || github.ref }}`, `cancel-in-progress` on `pull_request`) is exactly the mitigation, and it worked: each superseded push cancelled its own in-flight legs rather than stacking them. What it changes is the budget's shape and one piece of coordinator discipline:

- Re-price the budget as *19 jobs per push on any PR whose diff has ever touched a listed path*, not per matching push. The narrow `paths:` still buy the thing that matters — a PR that never touches a listed path never pays — but they do not decay over a PR's life.
- **Batch prose-only follow-ups.** A one-line doc fix on a wave PR costs a full promoted fan-out. Fold corrections into the next code push instead of pushing them alone; this section was itself held back for that reason and rode in with the next commit.

The `push: main` blocks are unaffected — those are per-commit, so the post-merge net keeps its original cost.
