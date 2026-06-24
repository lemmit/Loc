# The proposal bar — where does a finding go, and is it worth a skill?

The finalizer's discipline is *not* generating proposals — it's **rejecting** most of
them. A single session is weak evidence; the catalog stays sharp only if the bar is
real. This file is that bar.

## First: pick the channel (most findings are NOT new skills)

A session finding routes to one of four places. New-skill is the rarest. Route before
you judge worth — a misrouted finding fails the bar that doesn't apply to it.

| The finding is… | Channel | Why there |
|---|---|---|
| A non-obvious trap that cost real tool-calls and would cost the next agent the same | **`experience_gathered.md`** (append, dated, §-numbered) | A fact to remember, not a workflow to run. Additive + reversible → append directly. |
| A skill that mis/under-fired, or a stale reference in a skill | **Patch to that skill** (propose as diff) | The capability exists; its *trigger or reference* is wrong. Reviewed mutation. |
| A workflow *discipline* that generalizes beyond one skill (a sync rule, a claim-the-work rule) | **`CLAUDE.md`** (propose) | CLAUDE.md owns cross-cutting working norms; skills own one unit of work. |
| A recurring, costly, multi-file *unit of work* with no covering skill | **`PROPOSALS.md`** (candidate entry) | Only this is a new-skill proposal. Apply the worth bar below. |

If a finding fits one of the first three, it is **not** a new-skill proposal — stop,
route it, move on. Reaching for "new skill" when "append a gotcha" would do is the
most common overfit.

## The worth bar for a NEW skill — all three, or it's not one

A new skill must clear **all three**. Two-of-three is a `references/` table or a
gotcha, not a skill.

1. **Recurrence.** The work has happened before, or will demonstrably keep happening.
   `PROPOSALS.md` cites *multiple PRs* per skill for exactly this reason. A single
   session is n=1 — record it as a **candidate** ("seen once this session — needs a
   second sighting"), never build on it alone.
2. **Cost when done wrong.** The failure mode is expensive or invisible — it lands on
   red `main`, is caught days late by a nightly gate, or silently ships a gap. Cheap,
   self-evident, immediately-caught work doesn't need a skill; you'll just do it.
3. **Multi-file recipe with a forgettable step.** The work is a sequence across files
   where one omitted step breaks it (the design-pack required-emit set; the
   two-surface dependency bump). Genuinely creative/one-shot work resists a recipe and
   shouldn't be forced into one.

The repo's own anti-pattern, named in `PROPOSALS.md`: **"PR sync/deconflict — already
well-covered by CLAUDE.md discipline + the `pre-push-merge-check` hook + the built-in
`loop` flow; not worth a skill."** A capability already covered by a hook, a built-in,
or a CLAUDE.md norm is **not** a skill candidate no matter how often it recurs. Check
that the gap is real before proposing.

## The dedup gate (run before writing anything)

Overlap is the second-most-common reject. Before adding a `PROPOSALS.md` entry:

- **Already a shipped skill?** Six exist (`dependency-upgrade`, `design-pack-author`,
  `generated-stack-verifier`, `language-feature-developer`, `parity-auditor`,
  `status-refresh`). If your idea is a *slice* of one, it's a job-2 patch to that
  skill, not a new one.
- **Already in `PROPOSALS.md`?** The backlog holds built and unbuilt candidates
  (`local-gate-selector` is the standing unbuilt one). If yours is there, **add your
  session as evidence to that entry** — a second sighting is what promotes a candidate
  from "seen once" to "build it." Strengthening recurrence *is* the contribution.
- **A doc/parity concern in disguise?** "The docs are stale" → `status-refresh`.
  "Backend X doesn't emit Y" → `parity-auditor`. Those audit `docs/` and the emitters;
  the finalizer audits the `.claude/skills/` meta layer. Hand off, don't absorb.

## Worked judgements

- *"I rediscovered that `LOOM_HEX_MIRROR=1` is needed for Elixir behind the proxy."*
  → **`experience_gathered.md`** (it's §14 already — so really a **discoverability**
  job-2 note: which skill should have surfaced it?). Not a new skill.
- *"I hand-walked the design-pack required-emit set and missed `Section`."* →
  `design-pack-author` **exists and covers this**. Job-2 discoverability finding: did
  the trigger not match, or was it just not invoked? Patch the trigger if the former.
- *"Three times this month an agent mapped a diff to the wrong local CI gate."* →
  clears all three bars, not covered by a shipped skill, already named secondary in
  `PROPOSALS.md` → **add the recurrence evidence to the `local-gate-selector` entry**;
  if this is the second concrete sighting, recommend building it.
- *"I wrote a clever one-off script to migrate one example file."* → n=1, no
  recurrence, no forgettable-step recipe → **reject**, one line in the report.
