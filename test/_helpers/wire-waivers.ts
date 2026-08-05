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
// found three java divergences no gate had reached.  Two of them share one
// mechanism and are waived below; the third (RS-19, a declared `error` variant's
// fields dropped from the problem body) was FIXED in the same change, which is
// the disposition to prefer.  Empty is still the target state.
// ---------------------------------------------------------------------------

import type { WireWaiver } from "./wire-record.js";

export const WIRE_WAIVERS: readonly WireWaiver[] = [
  // RS-20 — java maps `version` to JPA `@Version`, so Hibernate bumps it from
  // the dirtiness of the ROOT entity rather than counting persisted mutations
  // the way the `versioned` capability declares.  The two shapes below are the
  // two directions that error runs in, and they are ONE bug:
  //
  //   * a mutation confined to a single `contains` child never marks the root
  //     dirty, so the bump is MISSED (golden 2, java 1);
  //   * a create that also writes a value-object collection flushes twice, so
  //     the root is bumped TWICE (golden 1, java 2).
  //
  // Waived rather than fixed because the repair is Hibernate-semantics work
  // needing a container build + boot per iteration — a different unit from the
  // coverage expansion that found it.  Scoped to the exact case + path so any
  // OTHER version divergence, on java or elsewhere, still fails the gate.
  {
    backends: ["java"],
    cases: ["single-containment"],
    path: "$.version",
    kinds: ["value"],
    reason: "RS-20 — java misses the version bump when only a contained child mutates",
  },
  {
    backends: ["java"],
    cases: ["value-collections"],
    path: "$.version",
    kinds: ["value"],
    reason: "RS-20 — java double-bumps version when a create also writes a value collection",
  },
  // The SAME two RS-20 divergences, seen through a SECOND window.  The RS-27
  // work added an `api.<aggs>.all()` caller to both fixtures, so each case now
  // also reads the row through the root LIST route — and a wrong `version` on
  // the entity is a wrong `version` on that row too.  Nothing new is wrong: the
  // value, the direction and the cause are identical to the two waivers above
  // (`golden 2 ≠ java 1` on single-containment, `golden 1 ≠ java 2` on
  // value-collections), only the JSON path differs (`$.items[*].version`).
  //
  // Written as SEPARATE waivers rather than widening the existing pair to
  // `**.version`, for the ratchet: the registry flags a waiver that stops
  // matching, so four narrow entries record which windows are still affected
  // and each disappears independently as RS-20 is fixed.  One broad pattern
  // would go stale only when the LAST of them was fixed, and would also swallow
  // a genuinely new `version` divergence at some other depth.
  {
    backends: ["java"],
    cases: ["single-containment"],
    path: "$.items[*].version",
    kinds: ["value"],
    reason:
      "RS-20 — java misses the version bump when only a contained child mutates (same bug as $.version, via the root list read)",
  },
  {
    backends: ["java"],
    cases: ["value-collections"],
    path: "$.items[*].version",
    kinds: ["value"],
    reason:
      "RS-20 — java double-bumps version when a create also writes a value collection (same bug as $.version, via the root list read)",
  },
];
