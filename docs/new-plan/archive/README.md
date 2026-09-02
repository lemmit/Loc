# Plan archive — closed missions and the refresh history

*Created 2026-09-02. Everything here is the evidence trail of work that is finished; nothing is open. The live plan is [`../README.md`](../README.md).*

| File | What |
|---|---|
| `T<n>-done.md` | The closed missions of track `T<n>`, moved verbatim out of the track file (status `done` / `shipped` / `closed` / `concluded` / `withdrawn`), each with its PR citation. Mission bodies keep their original text; relative links were re-based one level deeper. |
| [`missions/`](missions/) | Design docs and briefs of closed missions (the live ones stay in [`../missions/`](../missions/)). |
| [`refresh-log.md`](refresh-log.md) | The plan README as it stood on 2026-08-30 — the ten stacked "Last refreshed" notes since 2026-07-14, the 08-24 priority-shortlist rewrite, and the sequencing notes. The record of which statuses flipped when. |

**Rules.** A mission id is minted once and never reused or deleted: the unsupported-diagnostic register (`src/diagnostics/unsupported-register.ts`) cites ids, and `test/system/unsupported-register.test.ts` requires each cited id to appear as exactly one `## ` heading somewhere under `docs/new-plan/` — the archive counts. When a live mission closes, move its whole `## M-Tx.y` section here (see `../RUNBOOK.md` §5); when a closed mission turns out not to be done, move it back and say why in its status line.

Archived on 2026-09-02 (against `main` @ `5dc8b4e`): 75 missions — T1 5 · T2 6 · T3 5 · T4 3 · T5 6 · T6 38 · T7 1 · T8 2 · T9 9 — and 11 design docs.
