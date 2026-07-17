# Loom — the global implementation plan

*Created 2026-07-13 from a full re-classification of the design corpus: all 118 `docs/proposals/*`, all 71 `docs/plans/*`, the DEBT backlog, the parity registers, the audit findings, and the 2026-07 architecture weak-spot review. This document — plus the track files beside it — **supersedes** `docs/old/proposals/global-implementation-plan.md`, the `docs/old/proposals/README.md` status table, and `docs/old/plans/debt-prioritized-backlog.md` as the single source of ordering and open work. The archived corpus under [`../old/`](../old/) remains the design record (grammar sketches, semantics, rationale) — missions link into it; nothing was deleted.*

*Last refreshed: **2026-07-14** — a focused, code-verified status pass (not a full re-classification). Flipped **M-T5.6** (strict decimal/money bounds) `open → done` and reconciled the Priority shortlist annotations against fresh `main` + open PRs (see the dated note under §Priority shortlist). Per-track P1 rows were spot-checked, not exhaustively re-audited — treat every status as verify-first per the rule below.*

## What Loom is building toward

Loom lets you program architecturally correct business apps concisely, with a no-code feel: the `.ddd` model is the single source of truth; UI can be scaffolded from the domain and customized through escape hatches (`extern`, unfold); the model is editable as text, visually (builder), or by an AI agent through the compiler's tool surface; and backend/frontend targets are a config choice. The plan below is organized so that every open thread in the old corpus lands in exactly one **mission** — a self-contained, agent-pickable unit of work.

## How to use this plan (for agents)

**Starting a mission?** The full execution protocol lives in [`RUNBOOK.md`](RUNBOOK.md) — the kickoff prompt for any mission is two lines (mission ID + "follow the runbook"). The rules below are the summary; the runbook is the contract.

1. **Pick a mission** from a track file (`T1`–`T10`). Missions are sized S (≤1 PR, hours), M (1–3 PRs), L (a PR stack / multi-session), XL (an epic with its own sub-plan).
2. **Re-verify before building.** Statuses here were classified 2026-07-13, and `main` moves fast. A mission's first step is always: check fresh `main` (and open PRs) that the gap still exists. Missions carrying a ⚠ *verify-first* flag have known doubt.
3. **Claim with a draft PR** naming the mission ID (e.g. `M-T1.1`) before implementing — see CLAUDE.md's claiming protocol.
4. **Honor the D-tags.** Pinned decisions in [`../decisions.md`](../decisions.md) constrain design; a mission that contradicts one needs the decision re-opened first, not silently ignored.
5. **When a mission completes**, update its status line here (and the coverage row if the source doc is now fully drained). This plan is the only status table now — don't resurrect the old ones.

## Status legend

`open` (no code yet) · `in-flight` (claimed/branch exists) · `partial` (some slices landed; mission covers the remainder) · `blocked(X)` (waiting on mission/decision X) · `done` (kept briefly for context, then delete the entry).

## The tracks

| Track | Theme | Weight |
|---|---|---|
| [T1 — UI & frontend ceiling](T1-ui-frontend.md) | Data-heavy tables, upload, forms tail, state/async, i18n, a11y, extern parity, navigation | **P1 — highest product ROI** |
| [T2 — Data & schema evolution](T2-data-evolution.md) | Rename intent, data migrations, baseline safety, seeding/uniqueness tails, storage config tail | **P1 — the "silent data loss" class** |
| [T3 — Security, tenancy & governance](T3-security-governance.md) | Deny-by-default, find gating, authorization items 3–7, org-context, OIDC depth, sensitivity, versioned-on | **P1 — secure-by-default** |
| [T4 — Eventing, workflow & temporal](T4-eventing-temporal.md) | Timers/jobs ⭐, projections, channels/brokers, outbox completion, saga hardening, email/storage batteries | P2 (temporal hole is the biggest single gap) |
| [T5 — Language core & type system](T5-language-core.md) | Exception-less A4–A6, criterion/retrieval tails, payload P3/P5, stdlib tail, inheritance I4, lifecycle 3–5, surface hygiene | P2 |
| [T6 — Backend parity & generated-code quality](T6-backend-parity.md) | Phoenix gaps register, Java crash gates, SPA-embed under Phoenix, adapter subsets, live review-remediation slices, SYS-1 | P1/P2 (small missions, wrong failure modes today) |
| [T7 — Deployment & operations](T7-deployment-ops.md) | Metrics/OTel, k8s hardening, proxy/networking, terraform, PaaS deploy | P2 |
| [T8 — DX, tooling & the AI platform](T8-dx-tooling-ai.md) | Debugger frontier, sourcemaps, LSP tail, playground chat/agent loop, builder, packaging split, mutation testing | P2/P3 |
| [T9 — Toolchain & process health](T9-toolchain-health.md) | Langium 4 ⭐, persistence-emit seam ⭐, per-PR boot gates, test-coverage phases, doc hygiene | **P1 — prerequisite to growing the matrix** |
| [T10 — New targets](T10-new-targets.md) | Feliz completion only; Go/PHP/NestJS/Blazor/HTMX/Next.js studies **retired to design-record**; **matrix frozen — decided 2026-07-17, no more targets** | — (closed) |

## Sequencing — the load-bearing dependencies

- **The governance spine is mostly built.** execution-context backbone, multi-tenancy Phases 1–2, authorization read/write ladders + named policy fns all ship. What remains, in order: authorization item 3 (operation/view/workflow gates) → P4 `deny` → field rules (item 6) → `organizationContext` (M-T3.6, explicitly sequenced *after* the authorization gate it depends on).
- **Coordinated single-PR moments** (one PR + fixture re-baseline, don't slice): **A4** `Repo.getById` re-shape to `T or NotFound` (M-T5.1); **versioned default-on** (M-T3.4, breaking wire change); **paged-by-default implicit findAll** (M-T2.6, breaking change to every list endpoint).
- **Target freeze — decided (2026-07-17):** the matrix is permanently closed; **there will be no more backends or frontends** (owner decision, see [direction-review-2026-07](../audits/direction-review-2026-07.md)). This supersedes the earlier "don't start before M-T9.2" gating — M-T9.2 concluded the persistence surface can't be abstracted, so a growing matrix would have re-landed it by hand forever; frozen, that cost is bounded ×5 and amortizes. The in-flight Feliz frontend completes as a committed target; the T10 studies are design-record, not backlog. **The breadth budget redirects to depth (T4 temporal, T2 data-evolution) — each capability now lands ×5 once against a closed set, then is done.**
- **Ordering within a track is top-to-bottom** unless a mission states a dependency.

## Priority shortlist (if you only take five things)

**Architecture-risk work outranks feature breadth.** The [weak-spot review](../audits/architecture-weak-spots-2026-07.md) is the ranking authority: anything it names as a structural risk (silent data loss, silent/crash parity failure modes, security defaults, the un-abstracted persistence axis, the nightly-only feedback loop) is P1 by default, ahead of new surface area. We strive for excellence — a smaller platform whose claims all hold beats a wider one with hollow cells.

> **[2026-07-14 refresh — code-verified against `main`]** Most of this list has since shipped; what remains genuinely open is called out per row. Fully done: **row 2** (the correctness set — M-T6.1/6.4/6.7/6.8 all `done`), M-T2.2, M-T9.1, M-T9.2 (concluded), and — not listed here but the same class — **M-T5.6** (strict decimal/money bounds). Partly landed: M-T2.1 (column-rename shipped; **table-rename slice in flight**), M-T9.3 (all five per-PR behavioral gates exist; unit-tier + coverage phases remain), M-T1.1 (**in flight**). Still genuinely open + unclaimed P1: **M-T3.1**, **M-T3.4**. Verify against fresh `main` + open PRs before claiming any of these — the list rots fast.

1. **M-T2.1 + M-T2.2** rename intent + migration-baseline safety — closes the silent-data-loss class. *(M-T2.2 `done` #1895; M-T2.1 column-rename `done`, table-rename slice in flight.)*
2. **M-T6.1 + M-T6.4 + M-T6.7 + M-T6.8** the wrong-failure-mode set — silent SPA-embed hole, Java codegen crashes, node filter leak, update-path wire validation. Small missions, correctness-grade. *(All four `done` — #1886 / #1879 / main / #1883.)*
3. **M-T3.1 + M-T3.4** deny-by-default + versioned-on/409-mapper — the security-default flips. *(Both still open — the highest-value unclaimed P1 pair.)*
4. **M-T9.1 + M-T9.2 + M-T9.3** Langium 4, the persistence-emit seam, per-PR boot gates — the three structural investments everything else compounds on. *(M-T9.1 `done`; M-T9.2 `concluded`; M-T9.3 partial.)*
5. **M-T1.1** paged/sorted/filtered `Table` — the cheapest, highest-visibility product win (the wire already ships `paged`). *(In flight.)*

## Statuses rot — verify, then verify the verifier

Two standing rules beyond the per-mission verify-first step:

- **No status flip without code evidence.** Marking a mission `done` requires the PR link *and* the gate/emitter/test evidence line — the same standard the old corpus failed to keep (its three status tables drifted apart within weeks).
- **Audit for pretended work.** In a repo where parallel agents land PRs continuously, "merged" is not "real": gates get softened, dead code gets left unwired, TODOs get emitted into output. **M-T9.8** is the recurring adversarial sweep for this class; run it after any large multi-agent push.

## Provenance & coverage

Every archived proposal/plan is dispositioned in [`coverage.md`](coverage.md): either *shipped/superseded/historical* (no open work) or mapped to the mission(s) that carry its remaining items. If you find an open thread in an old doc that no mission covers, that's a bug in this plan — add a mission, don't fork a new tracker doc.

Audit findings feed the same way: the open items from `completeness-audit-2026-07`, `architecture-weak-spots-2026-07`, `full-code-review-2026-07` (#6, #22, C-mediums), `generated-code-ddd-review-2026-07` (S5d, S10 tail), `generated-code-review-2026-06-30` (SYS-1), and `showcase-coverage-bugs` (BUG-003/004) are all mission-mapped; see coverage.md §Audits.
