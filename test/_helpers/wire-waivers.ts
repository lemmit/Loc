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
// The list was empty from the RS-13/RS-14 fixes until 2026-07-30, when the
// M-T9.11 coverage expansion (5 shared systems -> the corpus feature cases)
// found three java divergences no gate had reached.  The RS-20 pair (java's
// `version` counting Hibernate ROW DIRTINESS instead of persisted commands) held
// five waivers here until the java repository save was made to drive the counter
// explicitly with a guarded `where version = :expected` bump; all five were
// deleted with that fix, which is the disposition the ratchet is built for.
// Empty is still the target state.
// ---------------------------------------------------------------------------

import type { WireWaiver } from "./wire-record.js";

export const WIRE_WAIVERS: readonly WireWaiver[] = [
  // RS-18 / docs/provenance.md — elixir does not re-capture a provenanced
  // field's lineage when the CRUDISH UPDATE writes it, so the row keeps the
  // lineage of the previous write.  On `corpus/provenance` the update sets
  // `total: 120` directly and the read-back still reports `reprice`'s leaves:
  //
  //   golden  [{path: "total",  value: 120}]
  //   elixir  [{path: "qty", value: 3}, {path: "price", value: 40},
  //            {path: "discount", value: 0}]
  //
  // node/python/java/dotnet all match the golden, and `docs/provenance.md` is
  // explicit — "inline trace capture at EVERY provenanced write site" — so
  // elixir is the outlier against a declared contract, not a disagreement about
  // semantics.
  //
  // WAIVED rather than fixed because the cause is not a missing capture line,
  // it is a different WRITE PATH.  Every other backend runs the synthesized
  // `operation update(...)` body (node emits a real `update()` domain method
  // with the capture inlined — `snapshotId "3a1011f0"`, `inputs [{path:
  // "total"}]`); elixir instead delegates `update_order/3` straight to
  // `OrderRepository.update` → `OrderChangeset.update_changeset(attrs)`
  // (`repository-emit.ts` §433), so the operation body never executes at all.
  // Provenance is the observable symptom; ANY body semantics on a synthesized
  // update is in the same blast radius, and the changeset path was chosen
  // deliberately (it is what makes the RS-26 default/relax rules work there).
  //
  // Exit: give the elixir crudish update the operation-body path (or capture
  // provenance on the changeset path with the write-site snapshot ids the IR
  // already carries) — a mission of its own, not a coverage-drain edit.  This
  // waiver ratchets: it fails as stale the moment that lands.
  {
    backends: ["elixir"],
    cases: ["provenance"],
    path: "$.total_provenance.inputs",
    kinds: ["value"],
    reason:
      "RS-18 — elixir's crudish update runs a changeset, not the operation body, so a provenanced field keeps its previous lineage",
  },
  // M-T6.20 — a messaged `precondition` denies through a DIFFERENT PATH on
  // elixir, and the three entries below are the one divergence that causes.
  //
  // On the other four backends an op precondition is lifted by
  // `preconditionsAsInvariants(op)` into the SAME wire validator the invariants
  // use, so a trip answers the WIRE-VALIDATION rung: title "Validation failed",
  // detail "One or more fields are invalid.", and an `errors[]` entry carrying
  // the pointer + the `msg.<hash>` code.  Elixir's preconditions never reach the
  // changeset validator — they lower to the `ensure/2` control-flow chain — so a
  // trip answers the DOMAIN-FLOOR rung instead: the authored message as `detail`
  // (that half works, #2300's `denialMessage`), the status reason phrase as
  // `title`, and NO `errors[]` at all, hence no pointer and no code.
  //
  // Waived, not fixed: M-T6.20 §"Wire `code` — the extra reshape" is exactly this
  // item and states the two options (reshape the precondition 422 into an
  // `errors[]`-with-pointer body, or hang `code` off the top level).  Choosing
  // between them and reshaping the ensure-path denial protocol is that mission,
  // not the message-catalog slice that first compiled a messaged precondition
  // here.  The three narrow entries ratchet independently as it lands.
  {
    backends: ["elixir"],
    cases: ["validation-messages"],
    path: "$.errors",
    kinds: ["key-set"],
    reason:
      "M-T6.20 — elixir's precondition denial is the domain-floor 422, which carries no errors[] (so no pointer and no wire code)",
  },
  {
    backends: ["elixir"],
    cases: ["validation-messages"],
    path: "$.title",
    kinds: ["value"],
    reason:
      'M-T6.20 — elixir\'s precondition denial answers the domain-floor rung, so the title is the status reason phrase, not "Validation failed"',
  },
  {
    backends: ["elixir"],
    cases: ["validation-messages"],
    path: "$.detail",
    kinds: ["value"],
    reason:
      "M-T6.20 — elixir's precondition denial puts the authored message in detail (the domain-floor shape) instead of the wire-validation sentence",
  },
  // #2563 — a wire `decimal` is a float64 on four backends and a
  // `System.Decimal` on .NET, so a value needing more than ~15 significant
  // digits truncates.  `avg(o.lineCount)` over lineCounts 2/4/1 is 7/3:
  // node/python/java/elixir all send the double's shortest round-trip
  // spelling `2.3333333333333335`, .NET sends `2.33333333333333`.
  //
  // Found while fixing the money-scale divergence on this same path (#2549)
  // and NOT folded into it: that was `money` losing its fixed wire SCALE and
  // was fixable in each projection emitter's coercion, which is why all 22 of
  // those divergences are gone and this one is not.  This is the numeric TYPE
  // backing a wire `decimal` on .NET — the value cannot be recovered inside a
  // `System.Decimal`, so closing it means deciding that representation
  // globally (response records + OpenAPI schema), which is its own unit.
  //
  // Scoped to the one case and field that can reach it: `sum`/`min`/`max` over
  // a decimal stay exact, and the singleton case's own `avgLines` is (2+4)/2 =
  // 3, which both representations spell identically.
  {
    backends: ["dotnet"],
    cases: ["projection-groupby"],
    path: "$[*].avgLines",
    kinds: ["value"],
    reason:
      "#2563 — .NET backs a wire `decimal` with System.Decimal, truncating a projection `avg` to ~15 significant digits where the other four send the float64 (RS-24 fixes the JSON type, not the precision)",
  },
];
