# Direction review — 2026-07-17

*A snapshot strategic review, not a code audit. Where the [architecture weak-spot review](architecture-weak-spots-2026-07.md) ranks structural **risks**, this one asks the higher-altitude question: **is Loom pointed the right way, and is effort landing where the leverage is?** Findings feed the plan the same way every other audit does (coverage.md §Audits). Verify-first still applies — this is an opinion grounded in the merge log + the docs as of this date, not a status table.*

## Verdict

**Right direction, and one constraint away from staying there — a constraint now taken.** The architecture is sound and the recent merge stream is attacking the project's own P1 risk list, not sprawling. The single largest structural risk was **breadth outrunning depth** across the 5×5 target matrix. The **"no more targets" decision (2026-07-17, owner)** removes that risk at the root: it converts T10 from a *default* freeze "until an owner decides" into a *decided, permanent* one. See [T10](../new-plan/T10-new-targets.md).

## What's healthy

- **The plan reads its own audits and acts.** The flagship secure-by-default flips both landed — deny-by-default find-gating (**M-T3.1**, #1962) and versioned-on-by-default (**M-T3.4**, #1933) — alongside paged/sorted/filtered `Table` (**M-T1.1**, the weak-spot review's "cheapest highest-ROI item") and a genuine wave of language-core hardening (call-arg + record-construction arity/type checking, **M-T6.18**; `paged` queryHandlers across all five backends). `Retire wireShape` (#1937) is healthy debt paydown.
- **The single-dispatch seams paid off.** `ExprTarget` and `WalkerTarget`, byte-identical-gated, are the reason 5 backends × 5 frontends was survivable at all. Expression rendering and page-walking each collapse to one leaf table per target.
- **The roadmap converges rather than treadmills.** `docs/new-plan` is mission-mapped, verify-first, with a recurring adversarial hollow-work sweep (**M-T9.8**). It is a plan aimed at a shippable product, not open-ended research.

## The tension the freeze resolves

Maintaining 5×5 is defensible **only if the marginal target is cheap.** The persistence-emit seam (**M-T9.2**) is the tell: after a full design pass it **concluded as a decline** — every ORM composes too differently (Drizzle combinators vs SQLAlchemy operators vs EF fluent vs JPA annotations vs Ecto changesets) to abstract; only `seed` extracted. So the largest emit surface — entity/schema/repository/routes, ~37–70 files per backend — is hand-written per target and every storage feature re-lands N times.

With the matrix **growing**, that is an unbounded treadmill and a live risk (a new backend also re-mirrors every un-exhaustive authorization-filter sentinel — a silent cross-tenant-leak waiting on target #6). With the matrix **frozen**, the same fact is a *bounded, one-time-per-feature ×5 cost* that amortizes and never grows. The decline stops being a scaling threat and becomes an honest, fixed cost model. **The freeze is what makes the "single LoomModel IR, no target IR" thesis finish clean.**

## What the freeze does *not* fix — the remaining game

Target count is now settled; these are orthogonal and become *the* priorities:

1. **The temporal + data-evolution gaps are now the highest-leverage undone work — and the freeze helps them.** Each capability added to timers/jobs (**M-T4.1**, first Phase-1 Hono slice in flight, #1963) or data-migration intent (**T2**, the "silent data loss" class) lands ×5 once against a closed set and is then done forever. Redirect freed attention here.
2. **Honest-gate discipline matters *more* under a permanent matrix, not less.** A capability that works on 1 of 5 backends with no compiler diagnostic (e.g. the `message "..."` clause draft #1965, silently dropped on four backends) is now a *permanent* per-backend UX crack, not a temporary one. A vertical slice should ship a companion reject/warn validator, not an assumption that "a later PR ports the emit."
3. **The customization cliff and bus factor are untouched by the freeze.** "No more targets" says nothing about what the no-code user hits when they exhaust the closed primitive set (the escape-hatch story: `extern`, unfold), nor that one author maintains a ~221k-src / ~165k-test-LOC surface across ~42 workflows. The recurring doc-rot and hollow-work sweeps are symptoms of surface-per-maintainer. These are the remaining existential questions.

## Where this points in the plan

- **T10** — freeze is now a decided commitment; header updated. Feliz completes as an already-committed target (finishing it is depth, not sprawl); no new backend/frontend starts.
- **README §Sequencing** — the "target freeze gated on M-T9.2" note is superseded: there is no target to gate.
- **T4 / T2** — inherit the redirected priority. **M-T4.1** (temporal) and the T2 data-migration missions are the P1 depth work the freed breadth-budget should fund.
- **Honest-gate** — a standing expectation for every T1/T5 vertical: ship the reject/warn diagnostic alongside the one-backend slice (relates to **M-T9.8** hollow-work discipline).
