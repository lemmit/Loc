# Loom — the global implementation plan

*One roadmap, divided into feature tracks and agent-pickable missions. Created 2026-07-13 from a full re-classification of the design corpus (118 proposals, 71 plans, the DEBT backlog, the parity registers, the audits); it supersedes every earlier status table. The archived corpus under [`../old/`](../old/) is the design record — missions link into it; nothing was deleted.*

*Last refreshed: **2026-09-02**, against `main` @ `36d8516`. This pass was a plan-hygiene audit and a layout change, not a feature pass:*

- *Every one of the 208 mission headings was cross-checked against the merged-PR record on `main` (3,253 commits, 304 of them naming a mission id) and the 12 open PRs. Four statuses were stale in the direction that matters — **three missions marked `open` had their fix merged** (M-T2.14 #2669, M-T6.44 #2670, M-T6.46 #2677; each PR carries the full fix plus witnesses, not a claim stub) — and four numeric-audit missions are `in-flight` on ready-for-review PRs (M-T1.21–M-T1.24). Four `done` headings had no PR citation and now do (M-T1.25 #2673, M-T6.17 #1955, M-T6.24 #2340, M-T6.45 #2676). Everything else the audit checked was current as written: the `partial` bodies are maintained PR-by-PR by their owners and matched the log. One `partial` was closed by owner decision: **M-T4.1 scheduling** — `every:` + durable `cron:` timers ship on all five backends, and the sugar its "Remaining" list named is not open work; agents had been re-proposing "temporal" features on the strength of that heading.*
- ***The track files now list only live missions.*** *The 76 closed missions (`done` / `shipped` / `closed` / `concluded` / `withdrawn`) moved, verbatim, to [`archive/T<n>-done.md`](archive/); the design docs of closed missions moved to [`archive/missions/`](archive/missions/); the ten stacked "Last refreshed" notes and the 08-24 shortlist that used to head this file are preserved in [`archive/refresh-log.md`](archive/refresh-log.md). `coverage.md` rows that pointed at a closed mission now say so and link into the archive.*

## What Loom is building toward

Loom lets you program architecturally correct business apps concisely, with a no-code feel: the `.ddd` model is the single source of truth; UI can be scaffolded from the domain and customized through escape hatches (`extern`, unfold); the model is editable as text, visually (builder), or by an AI agent through the compiler's tool surface; and backend/frontend targets are a config choice. Every open thread in the old corpus lands in exactly one **mission** — a self-contained, agent-pickable unit of work.

## How to use this plan (for agents)

**Starting a mission?** The full execution protocol lives in [`RUNBOOK.md`](RUNBOOK.md) — the kickoff prompt for any mission is two lines (mission ID + "follow the runbook"). The rules below are the summary; the runbook is the contract.

1. **Pick a mission** from a track file (`T1`–`T10`). Missions are sized S (≤1 PR, hours), M (1–3 PRs), L (a PR stack / multi-session), XL (an epic with its own sub-plan).
2. **Re-verify before building.** `main` moves fast. A mission's first step is always: check fresh `main` (and open PRs) that the gap still exists. Missions carrying a ⚠ *verify-first* flag have known doubt.
3. **Claim with a draft PR** naming the mission ID (e.g. `M-T1.1`) before implementing — see CLAUDE.md's claiming protocol.
4. **Honor the D-tags.** Pinned decisions in [`../decisions.md`](../decisions.md) constrain design; a mission that contradicts one needs the decision re-opened first, not silently ignored.
5. **When a mission completes**, flip its status line with the PR link, then **move its section to `archive/T<n>-done.md`** (and update the coverage row if the source doc is now fully drained). This plan is the only status table — don't resurrect the old ones, and don't leave closed missions in the track files.

## Status legend

`open` (no code yet) · `in-flight` (claimed / PR open) · `partial` (some slices landed; mission covers the remainder) · `blocked(X)` (waiting on mission/decision X) · `plan` / `deferred` / `recurring` / `frozen` (as named) · `done` (moved to `archive/` — a track file should never carry one for long).

## Where things live

| Path | What |
|---|---|
| `T1`–`T10-*.md` | The live missions, one file per track. Ordering within a track is top-to-bottom unless a mission states a dependency. |
| [`RUNBOOK.md`](RUNBOOK.md) | The execution protocol every mission follows. |
| [`coverage.md`](coverage.md) | Disposition of every archived proposal / plan / audit (test-enforced: `test/system/coverage-guarantee.test.ts`). |
| [`missions/`](missions/) | Design docs / briefs for live missions (`M-Tx.y-*.md`). |
| [`testing-quality-improvement-plan.md`](testing-quality-improvement-plan.md) | Companion plan for the test-quality missions M-T9.12–M-T9.20 (its `###` entries include three already-done ones, left in place because the sections read as one argument). |
| [`archive/`](archive/) | Closed missions per track (`T<n>-done.md`), their design docs (`missions/`), and the refresh history (`refresh-log.md`). Evidence trail only — nothing open. |

The unsupported-diagnostic register (`src/diagnostics/unsupported-register.ts`) cites mission ids; `test/system/unsupported-register.test.ts` requires each cited id to appear as exactly one `## ` heading somewhere under `docs/new-plan/` (the archive counts), so a mission id is never renumbered or deleted once minted.

## The tracks

| Track | Theme | Live | Archived | Weight |
|---|---|---|---|---|
| [T1 — UI & frontend ceiling](T1-ui-frontend.md) | Data-heavy tables, upload, forms tail, state/async, i18n, a11y, extern parity, navigation, the numeric/money frontend seams | 26 | 5 | **P1 — highest product ROI** |
| [T2 — Data & schema evolution](T2-data-evolution.md) | Rename intent, data migrations, baseline safety, seeding/uniqueness tails, storage config tail | 8 | 6 | **P1 — the "silent data loss" class** |
| [T3 — Security, tenancy & governance](T3-security-governance.md) | `organizationContext`, OIDC depth, sensitivity, versioned-on, the read surface, lifecycle-gate goldens | 12 | 5 | **P1 — secure-by-default** |
| [T4 — Eventing, workflow & temporal](T4-eventing-temporal.md) | Projections, channels/brokers, outbox completion, saga hardening, realtime contract, email/storage batteries — **scheduling is done** (`timerSource` `every:`/`cron:` on all five backends, M-T4.1 archived 2026-09-02; don't re-propose "temporal" features) | 8 | 4 | P2 |
| [T5 — Language core & type system](T5-language-core.md) | Exception-less A4–A6, criterion/retrieval tails, payload P3/P5, stdlib tail, inheritance I4, lifecycle 3–5, surface hygiene, numeric RS-rulings | 23 | 6 | P2 |
| [T6 — Backend parity & generated-code quality](T6-backend-parity.md) | Phoenix gaps register, adapter subsets, numeric ingress, saga/workflow emission holes, ES seeding | 20 | 38 | P1/P2 (small missions, wrong failure modes today) |
| [T7 — Deployment & operations](T7-deployment-ops.md) | k8s hardening, proxy/networking, terraform, PaaS deploy | 8 | 1 | P2 |
| [T8 — DX, tooling & the AI platform](T8-dx-tooling-ai.md) | Debugger frontier, sourcemaps, LSP tail, playground chat/agent loop, builder, packaging split, mutation testing | 13 | 2 | P2/P3 |
| [T9 — Toolchain & process health](T9-toolchain-health.md) | Per-PR boot gates, test-coverage phases, the numeric wire-codec seam, `RouteTarget`, doc hygiene, the recurring sweeps | 28 | 9 | **P1 — prerequisite to trusting the matrix** |
| [T10 — New targets](T10-new-targets.md) | Go/PHP/NestJS/Blazor/HTMX/Next.js studies **retired to design-record**; **matrix frozen — decided 2026-07-17, no more targets** | 7 (all `frozen`) | 0 | — (closed) |

Live = every heading that is not closed (`open` 69 · `partial` 63 · `in-flight` 4 · `blocked` 6 · `plan`/`deferred`/`recurring` 4 · `frozen` 7 — 153 in all, 2026-09-03 count; regenerate with `grep -c '^## M-T' docs/new-plan/T*.md`). *The 2026-09-03 jump is the [language-docs audit](../audits/2026-09-03-language-docs-audit-findings.md): 18 missions minted from its 47 findings — M-T5.26–M-T5.29, M-T1.28–M-T1.31, M-T6.53–M-T6.58, M-T9.44–M-T9.47, one per packet of its [wave plan](../audits/2026-09-03-language-docs-audit-findings.waves.md).*

## Sequencing — the load-bearing dependencies

- **The governance spine is built.** Execution-context backbone, multi-tenancy Phases 1–2, authorization read/write ladders + named policy functions, item 3's operation/view/workflow/find gates, item 6's read half (`mask unless`, all five backends) and P4 `deny` (M-T3.3, all five backends + adapter arms) all ship; item 6's write side is **WON'T DO** (reverted #2254/#2257). What remains is **`organizationContext` (M-T3.6)** and the read-surface plan (M-T3.15).
- **Coordinated single-PR moments** (one PR + fixture re-baseline, don't slice): **A4** `Repo.getById` re-shape to `T or NotFound` (M-T5.1); **versioned default-on** (M-T3.4, breaking wire change). (Paged-by-default implicit `findAll`, M-T2.6, shipped.)
- **Target freeze — decided (2026-07-17):** the matrix is permanently closed; **there will be no more backends or frontends** (owner decision, see [direction-review-2026-07](../audits/direction-review-2026-07.md)). M-T9.2 concluded the persistence surface can't be abstracted, so a growing matrix would have re-landed it by hand forever; frozen, that cost is bounded ×5 and amortizes. **The breadth budget goes to depth (T4 eventing, T2 data-evolution) — each capability lands ×5 once against a closed set, then is done.**
- **The numeric series is the current cluster.** The 2026-08-23 numeric-types audit minted 17 missions; as of this refresh nine are done, four are in-flight (M-T1.21–M-T1.24, the frontend money/decimal seams), and the two seam missions behind them (M-T9.36 wire-codec seam, M-T9.38 Flutter/Feliz runtime leg) are `blocked` on those four. Land the four before opening the seams.

## Priority shortlist (if you only take five things)

**Owner directive (2026-08-10, unchanged):** gaps in implementations (a missing feature per target) and bugs outrank architectural improvements. Rows that restate a defect go stale the week the defect is fixed, so each row points at the register or audit that *owns* its list. Verify against fresh `main` + open PRs before claiming.

1. **The 2026-08-24 generator code review's follow-up register** — `docs/audits/generator-code-review-2026-08-24.md` §"Follow-up register (2026-08-30, post-#2667)", re-verified and landed as #2689. The §A bug register is drained (all 21 in #2667); what is left is that dated table plus the §F architecture queue, each row with an owner: the six missions minted from it (M-T1.26, M-T4.12, M-T5.25, M-T6.50, M-T6.51, M-T9.39) plus rows folded into M-T4.2 / M-T4.3 / M-T9.7. The 251-row `G2667-*` ledger from #2668 is merged — cite ledger ids, don't fork them.
2. **The persistence-adapter axis, down to two survivors:** **M-T6.35** (the remaining `loom.*-unsupported` adapter rows) and the **dapper raw-Npgsql aggregation arm** #2609 left as reported follow-up (M-T6.41's residue — a `tenantOwned` source still counts every tenant's rows on dapper).
3. **M-T3.16's residue is two goldens, not two gaps** — C2 (a guarded create with an invalid body answers 403 on Elixir vs 422 elsewhere) and C4 (no golden covers a remapped `Forbidden`). The enforcement they cover already ships on all five backends.
4. **The frontend feature×target tail is Flutter's four form-field shapes** — pinned in `KNOWN_FLUTTER_GAPS` (`test/generator/flutter/parity-freeze.test.ts`) and owned by M-T1.18's M-A residue. What is left on `loom.auth-ui-unsupported-framework` / `loom.ui-realtime-unsupported` is the seam a future frontend would gate on, not a Flutter gap (M-T1.20).
5. **Coverage that hides gaps:** M-T9.13's drain of `E2E_LESS_CORPUS_FIXTURES` (the array in `test/ir/api-caller-census-pins.ts` — grep it, the count moves weekly). Every drain so far has uncovered a live defect the waiver was hiding (#2696 the `tenantOwned` + `shape: document` create-stamp hole; #2717 the dev-claims classifier that dropped array claims on four backends). Then M-T9.28's repo-wide `.ddd`/clause census, and registering the unwatched ratchets in `allowlist-ratchet` (M-T9.8).

**Architectural improvements queue behind these**, in order: §F2 of the 08-24 review (emission *mode* explicit on the shared renderers), §F4 → **M-T4.12** (the plan-level realtime contract, which also owns the live hole that no generated SPA can authenticate its own SSE stream), §F5 → **M-T9.39** (the i18n round-trip gate), then M-T9.26 `RouteTarget` (unblocked; re-measure post-#2462 first), M-T5.21 callable unification (design signed off in #2444), M-T3.6 `organizationContext` + M-T5.1 A4 re-shape (the two remaining coordinated moments), M-T9.25 round 2.

## Open PRs at this refresh (2026-09-02)

Mission-tagged: #2678 (M-T1.21), #2674 (M-T1.22), #2672 (M-T1.24), #2671 (M-T1.23) — all ready for review since 08-30. Untagged fleet-wave PRs from the targets-completeness drain (#2668's ledger): #2720 (W2 frontend-js), #2721 (W2 feliz), #2723 (W2 flutter), #2728 (W3 pairwise, draft), #2729 (W4 frontend collection ops, draft); plus #2713 (verification architecture / gate ledger), #2730 (`pr-gate` sweep cadence), #2628 (record C3 — nav links to refused routes). None of the untagged ones carries a mission id; when one lands with residue, mint the mission then, not a tracker doc.

## Statuses rot — verify, then verify the verifier

Two standing rules beyond the per-mission verify-first step:

- **No status flip without code evidence.** Marking a mission `done` requires the PR link *and* the gate/emitter/test evidence line — the same standard the old corpus failed to keep (its three status tables drifted apart within weeks). This refresh found three merged fixes whose missions were still `open`: the PR landed, the tracker didn't — the runbook's step 5 exists for exactly that.
- **Audit for pretended work.** In a repo where parallel agents land PRs continuously, "merged" is not "real": gates get softened, dead code gets left unwired, TODOs get emitted into output. **M-T9.8** is the recurring adversarial sweep for this class; run it after any large multi-agent push.

## Provenance & coverage

Every archived proposal/plan is dispositioned in [`coverage.md`](coverage.md): either *shipped/superseded/historical* (no open work) or mapped to the mission(s) that carry its remaining items. If you find an open thread in an old doc that no mission covers, that's a bug in this plan — add a mission, don't fork a new tracker doc.

Audit findings feed the same way: the open items from `completeness-audit-2026-07`, `architecture-weak-spots-2026-07`, `full-code-review-2026-07`, `generated-code-ddd-review-2026-07`, `numeric-types-audit-2026-08-23` and `generator-code-review-2026-08-24` are all mission-mapped; see coverage.md §Audits.
