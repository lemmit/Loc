# Loom — the global implementation plan

*Created 2026-07-13 from a full re-classification of the design corpus: all 118 `docs/proposals/*`, all 71 `docs/plans/*`, the DEBT backlog, the parity registers, the audit findings, and the 2026-07 architecture weak-spot review. This document — plus the track files beside it — **supersedes** `docs/old/proposals/global-implementation-plan.md`, the `docs/old/proposals/README.md` status table, and `docs/old/plans/debt-prioritized-backlog.md` as the single source of ordering and open work. The archived corpus under [`../old/`](../old/) remains the design record (grammar sketches, semantics, rationale) — missions link into it; nothing was deleted.*

## What Loom is building toward

Loom lets you program architecturally correct business apps concisely, with a no-code feel: the `.ddd` model is the single source of truth; UI can be scaffolded from the domain and customized through escape hatches (`extern`, unfold); the model is editable as text, visually (builder), or by an AI agent through the compiler's tool surface; and backend/frontend targets are a config choice. The plan below is organized so that every open thread in the old corpus lands in exactly one **mission** — a self-contained, agent-pickable unit of work.

## How to use this plan (for agents)

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
| [T10 — New targets](T10-new-targets.md) | Feliz completion; Go/PHP/NestJS/Blazor/HTMX/Next.js studies; **frozen by default** until M-T9.2 | P3 |

## Sequencing — the load-bearing dependencies

- **The governance spine is mostly built.** execution-context backbone, multi-tenancy Phases 1–2, authorization read/write ladders + named policy fns all ship. What remains, in order: authorization item 3 (operation/view/workflow gates) → P4 `deny` → field rules (item 6) → `organizationContext` (M-T3.6, explicitly sequenced *after* the authorization gate it depends on).
- **Coordinated single-PR moments** (one PR + fixture re-baseline, don't slice): **A4** `Repo.getById` re-shape to `T or NotFound` (M-T5.1); **versioned default-on** (M-T3.4, breaking wire change); **paged-by-default implicit findAll** (M-T2.6, breaking change to every list endpoint).
- **Target freeze:** T10 missions (new backends/frontends) should not start before **M-T9.2 (persistence-emit seam)** exists — every new target today re-lands the whole emit surface by hand and multiplies T1–T6 gaps. The in-flight Feliz frontend completes; nothing new starts.
- **Ordering within a track is top-to-bottom** unless a mission states a dependency.

## Priority shortlist (if you only take five things)

1. **M-T1.1** paged/sorted/filtered `Table` — cheapest, highest-visibility product win (the wire already ships `paged`).
2. **M-T2.1 + M-T2.2** rename intent + migration-baseline safety — closes the silent-data-loss class.
3. **M-T3.1** deny-by-default + find gating — the security default flip.
4. **M-T9.1** Langium 3.3→4.2 — unblocks the security-audit findings and the whole dependency chase.
5. **M-T4.1** `timerSource` (scheduling) — the temporal hole; design first, it gets more expensive with every backend added.

## Provenance & coverage

Every archived proposal/plan is dispositioned in [`coverage.md`](coverage.md): either *shipped/superseded/historical* (no open work) or mapped to the mission(s) that carry its remaining items. If you find an open thread in an old doc that no mission covers, that's a bug in this plan — add a mission, don't fork a new tracker doc.

Audit findings feed the same way: the open items from `completeness-audit-2026-07`, `architecture-weak-spots-2026-07`, `full-code-review-2026-07` (#6, #22, C-mediums), `generated-code-ddd-review-2026-07` (S5d, S10 tail), `generated-code-review-2026-06-30` (SYS-1), and `showcase-coverage-bugs` (BUG-003/004) are all mission-mapped; see coverage.md §Audits.
