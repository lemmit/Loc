# T8 — DX, tooling & the AI platform — completed missions

*Archived 2026-09-02 from [`../T8-dx-tooling-ai.md`](../T8-dx-tooling-ai.md). Every mission below is closed (`done` / `shipped` / `closed` / `concluded` / `withdrawn`); the bodies are moved verbatim (links re-based one level deeper) so the evidence trail stays readable. Nothing here is open work — the live track file lists what remains.*

## M-T8.12 — Playground multi-tab write coordination — `done` · **M** · P2
Two-tab data loss on one workspace closed: per-workspace exclusive Web Lock + read-only loser tab with take-over, BroadcastChannel invalidations through the external-`epoch` machinery; Phase 3 (SharedWorker multi-writer) explicitly rejected. Per-PR gate `web/e2e/multi-tab.spec.ts`. (Body pruned 2026-08-05 per the done-body rule.)
Design: [M-T8.12-multi-tab-coordination-design](missions/M-T8.12-multi-tab-coordination-design.md). Sources: [playground-file-mgmt-review-2026-07](../../audits/playground-file-mgmt-review-2026-07.md) defect #8.

## M-T8.13 — System-builder v1/v2 consolidation — `done` · **L** · P2
One model pane ships: v2 is the single editing surface (owner-gated alternative 4), v1 retired; the shared `usePaneHarness` rails extracted first so both panes rode one source/rev/liveTick/externalTick machinery. (Body pruned 2026-08-05 per the done-body rule.)
Design: [M-T8.13-system-builder-consolidation-design](missions/M-T8.13-system-builder-consolidation-design.md). Sources: [playground-file-mgmt-review-2026-07](../../audits/playground-file-mgmt-review-2026-07.md) §2, [playground-modeller-audit-2026-07](../../audits/playground-modeller-audit-2026-07.md), [playground.md](../../playground.md).
