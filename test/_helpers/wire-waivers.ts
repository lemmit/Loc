// ---------------------------------------------------------------------------
// The wire-differential waiver registry (M-T9.11 slice c).
//
// Every entry is a KNOWN, REVIEWED divergence between a backend and the
// canonical wire golden — the exact shape of the corpus `COMPILE_SKIP` maps and
// the M-T9.8 allowlist ratchet: a gap is a line of code someone signed, with a
// reason and a named exit, never a silent filter.
//
// Rules for adding one:
//   1. First decide WHO IS RIGHT — the golden is an oracle, not a vote.  If the
//      GOLDEN is wrong, fix the golden (rebaseline with LOOM_WIRE_UPDATE=1) and
//      open a bug on the backend that was accidentally the reference.
//   2. `reason` MUST name the RS-rule (`RS-n`, docs/conformance-semantics.md)
//      or the mission/PR that closes it.  `wire-record.test.ts` enforces this.
//   3. Scope as narrowly as the divergence: list the exact backends, add
//      `cases`/`request`/`kinds` when you know them, and prefer an exact `path`
//      over `**.` or `**`.
//
// The registry RATCHETS DOWN: a waiver that stops matching fails the gate as
// stale (see `staleWaivers`), so a fixed backend must delete its waiver in the
// same PR.  The list is meant to shrink to nothing.
//
// HISTORY — and the current state.  The list was empty from the RS-13/RS-14
// fixes until 2026-07-30, when the M-T9.11 coverage expansion (5 shared systems
// -> the corpus feature cases) found three java divergences no gate had reached.
// The RS-20 pair (java's `version` counting Hibernate ROW DIRTINESS instead of
// persisted commands) held five waivers here until the java repository save was
// made to drive the counter explicitly with a guarded `where version =
// :expected` bump; all five were deleted with that fix.  The last four — one
// RS-18 (elixir's crudish update ran a changeset, so a provenanced field kept
// the PREVIOUS write's lineage) and three M-T6.20 (elixir's messaged
// `precondition` answered the domain-floor 422 instead of the wire-validation
// `errors[]` shape) — went the same way: the elixir repository update now
// re-captures each provenanced write site off the applied changeset, and a
// wire-translatable messaged precondition denies with `{:validation_failed,
// errors}` rendered through the shared `errors[]` 422 sender.
//
// That drain took the registry back to empty on 2026-08-16, except for one
// entry that landed the same day — #2563, .NET backing a wire `decimal` with
// `System.Decimal` and so truncating a projection `avg` to ~15 significant
// digits.  That is now fixed too (the RESPONSE field is a `double`, the
// float64 the other four backends send), so the registry is EMPTY again.
//
// Empty is the target state, not a milestone: a new divergence is a BUG to fix
// on the diverging backend first, and a waiver only when fixing it is a mission
// of its own with a named exit.
// ---------------------------------------------------------------------------

import type { WireWaiver } from "./wire-record.js";

export const WIRE_WAIVERS: readonly WireWaiver[] = [];
