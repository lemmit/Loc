# Test-coverage audit — what the 16,000 tests actually reach (2026-08-13)

*Scope: the fast vitest suite on `main` @ `def706a` (1,628 test files / 16,584 cases / 25 min wall on 4 cores) over 825 `src` modules, the opt-in `LOOM_*` runtime tiers, the 65-workflow CI inventory, and the 19 open PRs. Method: **measured, not grepped** — one instrumented full-suite run carrying two censuses (diagnostic-firing and model-validity), an AST sweep for assertion-free cases, an import-graph census, and direct probes through `src/api`'s `validate()`. Snapshot-in-time; §7 reproduces every number.*

*Companion to [`quality-audit-2026-08.md`](quality-audit-2026-08.md) (2026-08-02), which asked **where the bugs come from**. This one asks the narrower question: **what does the suite actually touch, and where is it lying to us?** §6 records which of that audit's R1–R12 have since shipped, so none of them are re-litigated here.*

---

## 1. Headline

Three measurements, each independent, each surprising in a different direction.

1. **The diagnostic catalogue is in better shape than any grep says, and the grep is the problem.** A static census reports 131 of 413 `loom.*` codes as uncovered; a *dynamic* one — recording every code actually constructed during a full suite run — reports **49**. The static number over-reports by 2.7×, because the suite's real coverage style includes split message assertions (`e.includes("self-hosted") && e.includes("issuer")`) that no text search can see. Both static forms were measured here; both are wrong, in both directions. **Nothing in the repo runs the dynamic one**, so the recurring manual sweep this replaces (M-T9.8 item (d)) has been reasoning from the bad number for a month.

2. **19% of generator-test generations run on a model the product refuses.** Of 4,139 `generateSystemFiles` calls, **776** emit from a model carrying error-severity diagnostics, across **174 of the 607** test files that use the helper. `ddd generate` would exit non-zero on those fixtures. This is the general case of the two instances already found by hand — #2489 (a gate "green on approximately nothing" because its Phoenix leg generated from a rejected system) and #2512 (a harness that ran fewer phases than the product, inventing one finding and hiding another).

3. **72% of `src` has no test seam at all** — 591 of 825 modules, ~181k LOC, imported by no test file and reached only transitively through `generateSystems`. That is the structural cause of the 08-02 audit's "assertion-style ceiling": with no seam, `expect(emitted).toContain(…)` is the only assertion available, and the suite makes 14,559 of them.

The good news is equally measured, and it should *retire* work rather than add it: the assertion-free-test class is **drained** (35 of 16,584 cases, all reviewed-benign), and the api-caller census is down to 13 pins. Two recurring manual sweeps can be closed and replaced by ratchets.

---

## 2. Suite shape

| | `src` LOC | test LOC | ratio |
|---|---:|---:|---:|
| `generator/elixir` | 36,569 | 24,272 | 0.66 |
| `generator/dotnet` | 30,973 | 13,319 | 0.43 |
| `generator/java` | 24,733 | 10,791 | 0.44 |
| `generator/python` | 20,276 | 9,615 | 0.47 |
| `generator/typescript` | 13,446 | 9,614 | 0.71 |
| `generator/_walker` | 12,060 | 4,795 | 0.40 |
| `generator/feliz` | 8,905 | 5,795 | 0.65 |
| `generator/angular` | 6,761 | 4,892 | 0.72 |
| `generator/flutter` | 6,643 | 3,963 | 0.60 |
| `generator/svelte` | 4,382 | 2,783 | 0.63 |
| `generator/vue` | 4,229 | 3,754 | 0.89 |
| `generator/react` | 4,846 | 12,896 | 2.66 |

Assertion style, whole suite: `toContain` **14,559** · `toBe` 6,553 · `toMatch` 3,685 · `toEqual` 2,965 · `not.toContain` 2,279 · `toMatchSnapshot` 8. String containment outnumbers every structural form combined.

Read the ratios as a *skew*, not a target. `react` looks over-tested only because most React emission moved into the shared `_walker` — which has the lowest ratio in the table (0.40) and is the module every JSX/markup frontend depends on. .NET, Java and Python are the three largest emitters with the thinnest per-LOC pinning, and all three are where the 08-02 audit's dominant bug class (silently divergent on one backend) lands.

---

## 3. Findings

### 3.1 The diagnostic-firing gap is 49 codes — and only a dynamic census can find them (P1)

`src/diagnostics/messages.ts` holds **413** distinct `loom.*` codes, every one raised from a live call site. Three ways of asking "which are covered?" give three different answers:

| method | uncovered |
|---|---:|
| code named nowhere under `test/` | 131 |
| …and no ≥14-char fragment of its message text either | 111 |
| **never constructed during a full suite run** (instrumented `diagMessage`) | **49** |

The first two are wrong in *both* directions. They over-report: `test/language/auth-block.test.ts` covers all five `auth.ts` codes through split message fragments no search can reconstruct — the exact trap `docs/new-plan/testing-quality-improvement-plan.md` §C already records ("an initial sweep flagged ~23 uncovered; on re-check, most were false gaps"). And they under-report: **23 of the 49 never-fired codes ARE named somewhere under `test/`** — in a register table that asserts the code is *listed*, or in a comment. A grep counts those as covered.

Where the 49 live, by raising site:

| # | site | character of the cluster |
|---:|---|---|
| 19 | `ir/validate/checks/system-checks.ts` | almost entirely the backend-capability `*-unsupported` rejections |
| 9 | `ir/validate/checks/structural-checks.ts` | `match-*` (3), `duplicate-find`, `when-`/`union-`/`operation-return-unsupported`, `applier-impure-call`, `generic-carrier-unsupported` |
| 8 | `ir/validate/checks/workflow-checks.ts` | the 4 M-T9.19 already declared structurally unreachable, plus `duplicate-workflow`, `isolation-requires-transactional`, `workflow-emit-unknown-field`, `workflow-run-unknown-retrieval` |
| 7 | `macros/expander.ts` | the **entire** macro-authoring error surface — `macro-arg-{missing,duplicate,kind-mismatch}`, `macro-threw`, `macro-non-ast-result`, `macro-escapes-host`, `capability-host-invalid` |
| 2 | `ir/validate/checks/query-checks.ts` | `retrieval-where-{unknown-field,column-column}` |
| 4 | `language/validators/{structural,match,deployable}.ts`, `api/index.ts` | one apiece |

Three of these clusters are worth naming individually.

**The `*-unsupported` cluster is the sharpest.** M-T9.27's entire thesis is that a *named* rejection beats a silent gap — that is what makes a gap honest. Nineteen of those named rejections are asserted only as **entries in a register table**; nothing asserts any of them actually fires. The mechanism that converts silent gaps into honest ones is itself unverified.

**The macro cluster pairs exactly with M-T9.18** ("`src/macros/expander.ts` has no direct unit test"). This quantifies it: not one of the expander's seven author-facing error paths is exercised by anything.

**One documented-covered claim is stale.** M-T9.19 records `loom.workflow-emit-unknown-field` as covered "by message in `validation.test.ts:2051,2099`". That file no longer exists, no test names the code, and the census says it never fires. The claim survived because nothing could check it — which is the argument for the gate in one sentence.

The 49 are mostly *live*, not dead: nine codes probed directly through `src/api`'s `validate()` (`duplicate-enum`, `duplicate-valueobject`, `enum-shadows-root`, `valueobject-shadows-root`, `duplicate-find`, `duplicate-system`, `duplicate-context`, `auth-missing-issuer`, `auth-missing-client-id`) all fire correctly — `duplicate-find` among them, a gate that works and that nothing in 16,584 tests reaches. So this is a coverage hole first and a dead-code inventory second, though it will surface the dead ones too (M-T9.19 found four by hand; the census finds eight candidates in the same file).

`test/system/diagnostic-catalog.test.ts` is a strong gate but a different one: it pins **wording**, key⇒code agreement, and orphaned entries. A check can be refactored into unreachability with it, the layering test, and 16,000 others all green.

### 3.2 One in five generator-test generations runs on a model the CLI refuses (P1)

`test/_helpers/generate.ts` is explicit about its posture:

> *Runs validation but does not assert it — the canonical setup for walker / generator-output tests, many of which deliberately emit from a model carrying VALIDATION diagnostics (gated features, negative cases).*

Defensible as a default. What was not visible is how often it is load-bearing — and it compounds with a second gap: **`generateSystems` never runs phase ⑦.** `validateLoomModel` is called by `src/cli/main.ts` and `src/api/index.ts`, not by the orchestrator, so a test fixture is checked against strictly fewer phases than `ddd generate` runs it through.

Measured over the full run, re-validating every `generateSystemFiles` call through phases ④ + ⑦:

| | |
|---|---:|
| calls | 4,139 |
| calls whose model carries **error**-severity diagnostics | **776 (19%)** |
| distinct test files using the helper | 607 |
| …of which generate from an invalid model at least once | **174 (29%)** |

By code:

| count | code |
|---:|---|
| 622 | `loom.persistence-mode-unsupported` |
| 161 | `loom.lifecycle-body-dropped` |
| 63 | `loom.effect-in-lambda` |
| 10 | `loom.workflow-load-nullable-unsupported` |
| 10 | `loom.find-gate-not-current-user` |
| ~20 | 10 further codes, ≤6 each |

The concentration is the useful part — this is not 776 scattered accidents but a handful of fixture shapes copied widely. The largest single contributor, 72 cases in `test/generator/user-visible-slot-coverage.test.ts`, is one fixture builder: its Phoenix variant declares `deployable phoenixApp { contexts: [Cat] … }` with no `storage`/`resource` wiring, so every hosted aggregate lacks a dataSource. Confirmed through the real toolkit path (`validate()`, which merges exactly as the CLI does) — a single `loom.persistence-mode-unsupported` error. The test's own subject (does the HEEx page render the slot?) is probably unaffected; the point is that nobody knew the fixture was rejected, which is precisely how #2489's Phoenix leg came to be green on a system the validator refused.

`loom.lifecycle-body-dropped` deserves its own line: it is the diagnostic for the live security bug M-T3.16/#2532 exists to close (a named `create`/`destroy` dropped whole). 161 generations pin emitter output produced from models carrying it.

The fix is not "assert validity everywhere" — some of these tests exist to exercise degraded paths. It is to make the exception **explicit and ratcheting** (§4).

### 3.3 72% of `src` has no direct test seam (P2)

591 of 825 modules (~181k LOC) are imported by no test. The largest:

| LOC | module |
|---:|---|
| 2,937 | `src/generator/typescript/emit/mikroorm.ts` |
| 2,782 | `src/generator/feliz/wire.ts` |
| 2,639 | `src/ir/lower/lower-expr.ts` |
| 2,365 | `src/generator/dotnet/workflow-emit.ts` |
| 2,281 | `src/platform/hono/v4/routes-builder.ts` |
| 2,280 | `src/generator/dotnet/emit/dapper.ts` |
| 2,095 | `src/platform/hono/v4/workflow-builder.ts` |
| 1,919 | `src/ir/validate/checks/structural-checks.ts` |

M-T9.17 slice 1 proved the counter-pattern (mock-target unit tests for the four shared cores); slice 2 names the next set. This table says where the leverage is: `lower-expr.ts` and `structural-checks.ts` are pure functions over IR with no I/O, upstream of every backend — and `structural-checks.ts` is also where 9 of §3.1's unreached gates live.

**Side finding — dead re-export shims. Fixed with this audit.** 23 modules were imported by neither `src` nor `test`. Sixteen were `export *` path-stability shims left by moves into `_walker`/`_frontend` (`react/walker/{icons,api-hooks,context}.ts`, `react/walker/primitives/*.ts`, `react/templating/preparers/form-fields.ts`, `typescript/zod-refine.ts`), plus `feliz/projection-read.ts` (its one export is used only by Angular's own copy) and `flutter/projection-read.ts`. `test/platform/dead-generator-exports.test.ts` could not see them: it matches exported `render*/emit*/build*` **names**, and a bare `export *` declares none. All 16 are deleted and the gate now has a second half that resolves import specifiers and fails on any shim with no importer left — with one reviewed pin, `src/mcp/index.ts`, a published package barrel whose consumers are outside this repo by design.

### 3.4 The assertion-free class is drained — close the recurring sweep (P3, cheap)

M-T9.8 item (e) has been a recurring manual sweep for a month. An AST sweep finds **35 assertion-free cases of 16,584**, and all 35 are benign on inspection: 3 type-level contract-shape tests where `tsc` *is* the assertion, 22 opt-in e2e cases delegating to a helper that asserts or throws (`runMigrationEvolutionGate`, `waitFor`), and the rest the same shape.

Nothing to drain — so it is graduated rather than drained. `test/platform/assertion-free-tests.test.ts` pins the exact set (per file, not per line — line numbers churn for unrelated reasons), fails on a new assertion-free case, and fails on a **stale** pin so a case that gains an assertion forces its pin's removal. M-T9.8 item (e) is struck from the recurring list. The gate uses the AST sweep, not a regex: the naive brace-counting version reports 525, a 15× false-positive rate, which is a fair description of why the manual sweep went unrun for a month.

### 3.5 The playground's 46k LOC sit outside the coverage lens (P2)

`web/src` is 198 modules / 46,634 LOC with **zero** test files inside `web/`, and `vitest.config.ts` scopes coverage to `include: ["src/**"]`, so it is absent from the coverage number too. `test/playground/` (86 files, 17k LOC) does cover it — but only the **pure-logic** layer: 59 distinct `web/src` modules, essentially all of `builder/system/*`, `builder/page/*`, `workspace-sources.ts`, `system-v2/view-graph.ts`.

| LOC | module | unit-tested |
|---:|---|---|
| 2,193 | `web/src/App.tsx` | no |
| 1,774 | `builder/system-v2/SystemBuilderV2Pane.tsx` | no |
| 1,461 | `builder/requirements/RequirementsPane.tsx` | no |
| 855 | `builder/system/BodyEditor.tsx` | no |
| **814** | **`workspace/git/git-store.ts`** | **no** — pure logic, no React |
| 736 | `layout/OutputPanel.tsx` | no |
| 706 | `layout/TestsPanel.tsx` | no |

The per-PR gate for that layer is `playground-e2e-no-network.yml` (9 Playwright specs); the full `playground-e2e` is post-merge/label and has already sat red on `main` for days once (#2445). `git-store.ts` is the anomaly worth acting on: 814 lines of pure store logic behind a Playwright-only gate, in a suite that already imports `web/src` modules directly.

### 3.6 Behavioural coverage of the feature corpus (status only — claimed)

10 of 45 corpus features carry no `test`/`test e2e` block, so no backend executes them: `api-call`, `channels-broker`, `extern`, `extern-handlers`, `outbox`, `policy-deny`, `policy-document`, `read-gates`, `resources`, `tenancy-hierarchy`. This is M-T9.13's `E2E_LESS_CORPUS_FIXTURES` register, **claimed by open PR #2517**. Recorded for completeness — see §5.

### 3.7 Two documentation drifts found while measuring (P3)

- **`CLAUDE.md:364` lists `generated-{react,vue,svelte,angular}-e2e.yml` as per-PR gates.** They carry no `pull_request` trigger — `push: [main]` only, and deliberately (the React workflow's own header: *"has caught zero regressions per-PR in practice"*). The decision is sound; the doc is wrong. Fixed in this change.
- **M-T9.28 – M-T9.32 have no mission bodies.** `docs/new-plan/README.md` and `coverage.md` record them as minted (the `.ddd` census, the driven-primitive census, the flake budget, the weekly quality delta, dup-claim automation), and `flake-budget.yml` + `quality-delta.yml` genuinely shipped — but no track file or `docs/new-plan/missions/` entry defines any of the five (#2512 notes the M-T9.29 body sits on an unmerged branch). An agent picking work from the track files cannot see them.

---

## 4. Proposals

Each states the mutation proof its PR must show — per CLAUDE.md, a gate never observed failing proves nothing.

### P1 — **Diagnostic firing census** (`S/M`) → [M-T9.33](../new-plan/T9-toolchain-health.md) — **slice 1 shipped with this audit**

`test/system/diagnostic-firing-census.test.ts`. The design moved during the build, and the move matters: **the instrumentation used to measure §3.1 is the right tool and the wrong gate.** A recorded run is a whole-run property (`test.yml` shards 4 ways → needs a shard-merge in the roll-up) and only ever proves *reached*, not *asserted*. So the gate neither searches nor instruments — it **drives**: each fixture is a minimal `.ddd` that must make its code come out of `validate()`. Deterministic, shard-safe, no CI plumbing, and the drain produces real negative tests instead of a report.

Four buckets, every catalogued code in exactly one — `FIRING_FIXTURES` (11, proven by running them), `UNREACHABLE_PINS` (reason required, ≥20 chars), `UNCOVERED` (38, shrink-only, also registered in `allowlist-ratchet`), `COVERED_ELSEWHERE` (364, **frozen — no new code may join**). The frozen bucket is what makes it a ratchet: a code added tomorrow fails until its author writes a fixture or pins it.

Stated limit, in the gate's header: `COVERED_ELSEWHERE` credits coverage measured once, so a later-deleted test goes unnoticed. It closes "a code arrives with no proof it ever fires", not the general case.

*Mutation-proved four ways* (file-copy reverts): disable the `duplicate-find` check → its fixture test fails naming it; add a catalogue code → "accounted for" fails naming it; drain an `UNCOVERED` entry without lowering the baseline → anti-slack fails; add one → shrink-only fails.

*Do not build the grep version* — both static forms were measured here and both are wrong in both directions (§3.1).

### P1 — **Harness honesty: assert phases ④+⑦ in `generateSystemFiles`** (`M`) → [M-T9.34](../new-plan/T9-toolchain-health.md)

Make the helper assert a clean model by default and take an explicit opt-out that *names* the codes the fixture intends to carry:

```ts
await generateSystemFiles(src, { expectInvalid: ["loom.persistence-mode-unsupported"] });
```

Land it with a ratcheting register of the current 174 files so it is mechanical rather than a flag day, then drain. Two things fall out: fixtures stop drifting into "green on approximately nothing" (#2489), and phase ⑦ starts running in the harness at the depth the CLI runs it (#2512's harness lesson, generalised). Start the drain with the concentrated shapes — the `phoenixSystem` builder in `user-visible-slot-coverage.test.ts` is 72 of the 776 by itself.

*Mutation proof:* an entry whose fixture becomes valid must fail the stale half; a newly-invalid fixture must fail with the code named. Show both.

### P2 — **Unit seams for the two biggest pure upstream modules** (`M`) — M-T9.17 slice 2

`src/ir/lower/lower-expr.ts` (2,639) and `src/ir/validate/checks/structural-checks.ts` (1,919): pure, upstream of every backend, reachable today only through full generation, and home to 9 of §3.1's unreached gates. Slice 2 already names the IR-fixture builder this needs — build that first.

### P2 — **`web/src/workspace/git/git-store.ts` unit tests** (`S`) — §3.5

814 lines of pure store logic whose only gate is Playwright, half of it post-merge. No new infrastructure: `test/playground/` already imports `web/src` directly.

### P3 — ~~Graduate the assertion-free sweep into a ratchet~~ — **shipped** (§3.4)

`test/platform/assertion-free-tests.test.ts`, pinned at 35 across 26 files, both directions ratcheting. M-T9.8 (e) struck.

### P3 — ~~Extend `dead-generator-exports` to bare `export *` shims~~ — **shipped** (§3.3)

16 shims deleted; the gate gained a resolved-specifier half. One reviewed pin (`src/mcp/index.ts`, a published barrel). *Mutation-proved:* restoring one deleted shim fails the gate by name.

**One implementation note worth carrying forward**, because the first version of that half was wrong in a way that reads as working: matching import specifiers by **path suffix** reports live modules as dead, since a sibling imports `"./heex-walker.js"` — a string containing none of its own directory. It named nine live shims on its first run and was caught only because they were hand-checked. The gate resolves specifiers against the importer's directory instead.

---

## 5. Explicitly NOT proposed — claimed in flight

Checked against all 19 open PRs on 2026-08-13:

| Area | Claimed by |
|---|---|
| Repo-wide `.ddd` parse/validate census; generative pipeline fuzzing; dapper × projection gate | **#2498** |
| Pairwise feature-crossing corpus harness (M-T9.29 slice 1) + 5 crossing findings | **#2512** |
| Draining the e2e-less corpus register (§3.6) | **#2517** |
| 401/403 authorization-status census; 4xx wire goldens | **#2540**, **#2541** |
| Optional-context-parameter sweep + ratcheting gate | **#2539** |
| Lifecycle write-gate emission and its `loom.lifecycle-body-dropped` diagnostic | **#2519**, **#2532** |

## 6. Where the 2026-08-02 audit's recommendations landed

Verified against `main`, not against the tracker:

- **R1/R2 (tier inversion)** — substantially addressed by `pr-gate.yml`: an aggregate required check binding every workflow that triggers on the head SHA. The merge queue remains the structural fix and remains inert (org-only feature).
- **R3(b)** (`ddd parse` surfacing IR errors) — shipped, #2447. **R3(a)** (the `.ddd` census) — in flight, #2498.
- **R4** (mutation-proofing as policy) — shipped into `CLAUDE.md`'s conventions and visibly practised.
- **R5** (route-coverage census) — shipped as `test/ir/api-caller-census.test.ts`, 216 → 13 pins. The walker-primitive half is #2512's.
- **R7** (sentinel `ExprIR` → typed nodes) — done, M-T9.9.
- **R10/R11** (flake budget, weekly quality delta) — shipped as `flake-budget.yml`, `quality-delta.yml`.

The ratchet culture that audit described is working. What this one adds is that **two instruments are still not measuring what they are read as measuring** — the diagnostic catalogue (§3.1) and the generator-test harness (§3.2) — and both are cheap to fix.

---

## 7. Reproducing the numbers

```bash
# suite / source shape
find src -name '*.ts' -not -path '*/generated/*' | wc -l     # 825
find test -name '*.test.ts' | wc -l                          # 1,624 (+4 under packages/)

# catalogue size, and the two STATIC censuses (both shown wrong in §3.1)
grep -oE '"loom\.[a-z0-9-]+(#[a-z0-9-]+)?"' src/diagnostics/messages.ts \
  | tr -d '"' | sed 's/#.*//' | sort -u | wc -l              # 413
grep -rhoE 'loom\.[a-z0-9-]+' test --include='*.ts' | sort -u

# the DYNAMIC censuses (§3.1, §3.2) — prototypes of the gates proposed in §4.
#   1. record `String(key)` from `diagMessage` (src/diagnostics/messages.ts)
#      into a file, behind an env flag;
#   2. in `generateSystemFiles` (test/_helpers/generate.ts), re-run
#      lowerModel → enrichLoomModel → validateLoomModel and log the test path
#      plus any error codes;
#   3. `npx vitest run`, then diff the recorded sets against the catalogue.
# Revert both by file copy, never `git checkout -- <path>` (CLAUDE.md).

node scripts/assertion-free-census.mjs        # 35 assertion-free of 11,089 it() sites
node scripts/unimported-census.mjs            # 591 of 825 modules, 23 orphans
```

*Sources: this session's measurements; [`quality-audit-2026-08.md`](quality-audit-2026-08.md); [`testing-quality-improvement-plan.md`](../new-plan/testing-quality-improvement-plan.md); `experience_gathered.md` §§22, 54, 57, 59, 62.*
