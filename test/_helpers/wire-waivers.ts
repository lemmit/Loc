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
  // A THIRD face of the same RS-20 error, and the plainest statement of it yet:
  // an IDEMPOTENT command.  `corpus/saga`'s workflow already ran
  // `ship.markTracked()` in-process, so when the caller-census drain gave that
  // operation its first HTTP caller the route re-assigned `status := "Tracked"`
  // over the value it already held.  A command RAN and answered 204, so the
  // `versioned` capability (`version: int token = 1`, incremented per command)
  // says 3 — which node, python, dotnet and elixir all send.  Java sends 2,
  // because Hibernate's dirty check sees no column change and skips the
  // `@Version` bump: the counter tracks ROW DIRTINESS, not commands, which is
  // exactly what RS-20 already names.
  //
  // Kept as its own narrow entry rather than widening the pair above, for the
  // same ratchet reason: `$.version` on `saga` retires independently of the two
  // list-read faces, and a broad `**.version` pattern would swallow a genuinely
  // new divergence.
  {
    backends: ["java"],
    cases: ["saga"],
    path: "$.version",
    kinds: ["value"],
    reason:
      "RS-20 — java skips the version bump on an IDEMPOTENT command (re-assigning the value a field already holds leaves the row un-dirty, so @Version never increments)",
  },
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
  // M-T9.11 (4xx wire goldens) — the bare-text-401 waivers that lived here for
  // dotnet/dapper and java are GONE, and their own exit condition is why.  They
  // read "ratchets stale the moment #2500 (or any 401 reshape) makes these
  // backends match"; #2500 landed (`a4235ac`), so neither emitter writes a
  // bare-text `unauthorized` any more — `WriteAsync("unauthorized")` and
  // `getWriter().write("unauthorized")` no longer appear in
  // `src/generator/{dotnet,java}/` — and node's golden was rebaselined onto the
  // RFC 9110 problem document.  All five now answer the same shape, so the
  // divergence the waivers excused does not reproduce and the ratchet fails the
  // run until they are deleted.  This is the intended end state, not a
  // regression: a fix deletes its waiver in the same PR.
];
