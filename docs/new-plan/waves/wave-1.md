# Wave 1 — close the P0/P1 silent residue (coordinator log)

*Plan: [`../improvement-waves-2026-09.md`](../improvement-waves-2026-09.md) §Wave 1 and §3a. Base: `main` @ `b826f87` (#2713 merged). One PR for the wave; packets work on `claude/wave-1-<packet>` sub-branches (git refuses `claude/wave-1/<packet>` while `claude/wave-1` exists) and are folded here by the coordinator. This file is the claim: any agent reading the PR list sees every packet, row and tree fence below. Hand-off notes are appended verbatim under §Hand-offs as packets land.*

## Packets

| packet | model | tree fence | rows (in fold order) | state |
|---|---|---|---|---|
| 1a validator + cli | Opus | `src/cli/**`, `src/ir/**`, `src/diagnostics/**`, `src/language/validators/**` | `ir-warnings-invisible-in-cli` → `F2-VAL-1` → `F2-ADP-3` gate → `timer-tz-overlap-inert` gate → `eventlog-shape-silently-ignored` → `M-T5.9-reserved-not-emitted` → `M-T6.18-gap3-criterion-arg-types` → `M-T5.25` → `F2-CB-C9` / `F2-CB-C10` / `F2-EXPR-5` messages → `M-T3.8` diagnostic slice | in progress |
| 1b dotnet-adapters | Opus | `src/generator/dotnet/**` | `F2-ADP-1` (P0) → `F2-ADP-4` → `F2-ADP-2` → `G2667-D3` → `M-T3.9-dotnet-audit-masked-snapshot` (VF) → `G2667-D4` (VF) → `dapper-no-schema-evolution` (decision: honest gate this wave) | **folded** `d449b7e` — 1 fixed (D3 dotnet arm), 5 already-done-verified (#2668/#2708), 2 handed off |
| 1c node-ts | Opus | `src/platform/hono/**`, `src/generator/typescript/**` | `F2-ADP-5` (P0) → `F2-ADP-6` → `F2-CB-C8` → `F2-EXPR-4` → `M-T6.51` → `F2-W-05` (VF) → `F2-CB-C1-paged-nonrelational` (VF) → `G2667-C2-money-array` (VF) → `M-T5.14` → `static-subpath-405-node-only` (node arm; other backends handed off) | in progress |
| 1d elixir | Opus | `src/generator/elixir/**` | `F2-ELX-ESCAPE-FUNNEL` (P0) → `F2-W-01` → `F2-FFE-6` → `M-T6.26-doc-put-presence` → `elixir-grapheme-vs-codepoint-length` → `F2-MT640-SORT-DEAD` → `M-T6.2-s14-audit-wiresnapshot` → `G2667-C7` (decision) | in progress |
| 1e python + macros | Sonnet | `src/generator/python/**`, `src/macros/**`, `src/generator/_walker/primitives/text.ts` | `M-T6.50` (migrate onto `walk.ts`) → `M-T1.15-nonstring-filter-finds-dropped` → `provenanced-bare-read-in-page-body` → `M-T1.26` | in progress |
| 1f frontend-js | Sonnet | react / vue / svelte / angular generators, `designs/**` | `F2-CFE-2` → `F2-CFE-8` → `M-T1.8-error-boundary-five-targets` → `M-T1.12-raw-field-aria` → `G2667-D8` | waits for #2720 to merge; moves to Wave 2 if it lags |
| 1g SSE auth | Opus | `src/generator/_frontend/realtime.ts`, `src/ir/util/realtime-rooms.ts`, per-backend SSE plugs | `M-T4.12` | in progress |
| 0.2 ledger reconciliation | Sonnet | `docs/audits/targets-completeness-2026-08-30.*`, `docs/new-plan/T9-toolchain-health.md` | move W1/W1b/W2/#2719/#2726 rows to `done`; recount the `.md` header from the JSON; `M-T9.36 → open (unblocked)`; record the `F2-ADP-3` handoff | first commit of the wave |

VF = verify-first: a merged PR body mentions the id; re-derive on this base before building.

## Fold protocol (coordinator)

1. Packet hands over `claude/wave-1-<packet>` + a hand-off note (row table: fixed / gated / handed-off / already-done-verified; the mutation-proof assertion per fix; local gate results).
2. Coordinator merges the sub-branch into `claude/wave-1`, runs `npx tsc -b`, `npm test` and the packet's compile leg on the folded tree, appends the note under §Hand-offs, and pushes — at most once a day.
3. Rebase onto `main` only on a real conflict. Flip to ready once, when the whole wave is green locally.

## Hand-offs

*(appended as packets land)*

- **1b dotnet-adapters** — [`handoffs/wave-1-dotnet-adapters.md`](handoffs/wave-1-dotnet-adapters.md). Hand-offs raised: the `G2667-D3` LEFT-JOIN ruling + the four other backend arms; `dapper-no-schema-evolution` needs a phase-⑨ owner (`src/system/migrations-builder.ts`, plus the misdirected M-T2.2 baseline error); `F2-EXPR-7` ruling proposed (`first: T` ⇒ throws on empty; node/elixir are the degraders); `F2-W-14` confirmed, not landed (runtime-only proof).
