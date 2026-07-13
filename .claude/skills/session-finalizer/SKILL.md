---
name: session-finalizer
description: >-
  End-of-session retrospective that turns what THIS session just learned into
  durable repo memory — and PROPOSES (never silently applies) improvements to the
  skill catalog. Use this at the close of a working session, or whenever the task
  is about the skills/memory layer itself: "finalize the session", "session
  retrospective", "what did we learn", "capture this gotcha", "should this be a
  skill?", "propose a new skill", "improve / refresh the skills", "are the skills
  stale", "skill-doctor", "audit `.claude/skills/`", or picking up
  `.claude/skills/PROPOSALS.md`. It has three jobs, in order of frequency:
  (1) HARVEST gotchas the session rediscovered into `experience_gathered.md`;
  (2) DETECT skill misfire/friction — a skill that fired wrongly, one that should
  have fired and didn't, or multi-file recipe work done by hand that a skill does
  (or should) cover — and propose a trigger/reference PATCH; (3) PROPOSE a new
  skill into `PROPOSALS.md` when a recurring, costly, multi-file unit of work has
  no skill. HARD RULE: it is PROPOSE-ONLY for the skill bodies — it emits diffs a
  human reviews; it never rewrites a skill's own instructions unsupervised, and
  never invents a recurrence from a single session. Boundary: this audits the
  `.claude/skills/` META layer (skills, their triggers, `PROPOSALS.md`,
  `experience_gathered.md`); `status-refresh` audits `docs/` truthfulness and
  `parity-auditor` audits emitter feature support — hand those their own scope.
  Not for doing the session's actual work — it runs AFTER the work, on the record
  of it.
---

# Session finalizer

Every other skill in this repo is a **doer** — it executes one recurring unit of
work. This one closes the loop that *produced* those skills. `PROPOSALS.md` is the
artifact of a manual process — "review weeks of merged PRs → find the work that
recurred and the work that caused problems → propose a skill." That process is
high-leverage and it only runs when a human decides to do a sweep. The finalizer
runs the same reflection at the granularity of **one session, while the evidence is
still in the transcript** — and feeds the same three memory surfaces the manual
sweep does.

The cost it fights is **lossy memory**. A session rediscovers a landmine (the
`experience_gathered.md` §14 Erlang-TLS-fingerprint class, the §15 stamped-field
class), thrashes against a stale base, or does a five-file recipe by hand that a
skill already encodes — and then the session ends and none of it is written down.
The next agent pays the same cost from zero. The finalizer is the deliberate
write-back step that makes a session's friction *cumulative* instead of repeated.

## The one hard rule: PROPOSE, don't mutate

The skill bodies (`SKILL.md` instructions, the `agents/` role prompts) are
**propose-only**. The finalizer emits a **diff or a `PROPOSALS.md` entry** for a
human to approve; it does **not** rewrite a skill's own guidance unsupervised. Two
reasons, both load-bearing:

- **Single-session evidence is weak.** One session is an *n=1* signal. A skill is
  justified by work that **recurred** — the whole `PROPOSALS.md` evidence bar is
  "the work that recurred *and* caused problems," cited to multiple PRs. A finalizer
  that promotes every one-off into a skill edit bloats the catalog with overfit
  guidance. So a finding from one session is a **candidate** ("seen once this
  session"), not a merge.
- **Self-editing instructions drift.** A skill that rewrites its own triggers each
  session, unsupervised, contradicts itself within a week and no reviewer is in the
  loop to catch it. The safe self-improvement loop is the same one the repo already
  trusts everywhere else: a reviewed diff.

The two **append-only memory files are different** — appending a dated gotcha to
`experience_gathered.md` or a candidate row to `PROPOSALS.md` is additive and
reversible, so the finalizer may write those directly. It still never *rewrites*
existing entries or skill bodies; it appends, and proposes edits.

## Before anything: the input is the transcript, not your memory

The finalizer's raw material is **what actually happened this session** — the
commands that failed and why, the file you grepped three times before finding it,
the gotcha you hit, the skill that did or didn't fire. Reconstruct that from the
session record, not from a general sense of "what would be nice." Every proposal
must **cite the concrete friction it removes** ("spent N tool-calls rediscovering
that PG18 moved PGDATA — already in `experience_gathered.md` §X but not surfaced by
any skill"). A proposal with no cited friction is noise; drop it.

Sync `main` first if you'll check any claim against code (skill descriptions cite
backend counts, file paths, validator codes — all of which rot):

```bash
git fetch origin main -q   # the skill catalog cites code; verify against fresh main
```

## The three jobs

Run them in order. Most sessions yield job 1 and nothing else — that's the expected
shape, not a failure. Jobs 2 and 3 fire only when the evidence clears the bar in
`references/proposal-bar.md`.

### Job 1 — Harvest gotchas → `experience_gathered.md`

Scan the session for a **rediscovered landmine**: a non-obvious fact that cost real
tool-calls and would cost the next agent the same. The existing entries are the
template — numbered §-sections, each "here's the trap, here's why, here's the fix"
(§14 hex-mirror TLS fingerprint, §15 stamped-field/sentinel debt). Candidates:

- A compile-green/runtime-red surprise, a migrate-time failure, a stale-base lie
  (you reasoned from behaviour that no longer existed on `main`).
- An egress/proxy/Docker wrinkle, a tool that needed a non-obvious flag, a CI gate
  that a narrow diff silently skipped.

**Dedup first.** If it's already an `experience_gathered.md` §-section, the lesson
isn't missing — its *discoverability* is. That's a job-2 finding (a skill should
have surfaced it), not a duplicate append. Only append a genuinely new trap, dated,
in the existing numbered shape.

### Job 2 — Detect skill misfire/friction → propose a PATCH

Three failure shapes, each with a targeted fix (propose as a diff):

| Signal in the transcript | Fix to propose |
|---|---|
| A skill **fired and was unhelpful/wrong** — wrong scope, sent you down a path the task didn't need | *Narrow* the trigger / add a boundary clause excluding the misfire case |
| A skill **should have fired and didn't** — you did exactly its work by hand because the trigger didn't match your phrasing | *Widen* the trigger with the phrasing you actually used (the description's whole job is matching real asks) |
| You did a **multi-file recipe by hand** that a skill covers, but never invoked it | Discoverability gap — strengthen the trigger, or note in the report that the skill exists (maybe the human just didn't `/`-invoke it) |
| A skill's **reference is now wrong** — a path it cites moved, a count it states is frozen (the "N-backend-era freeze" from `status-refresh`, applied to skill prose: any skill saying "five backends and five frontends" is a freeze candidate as the target set grows) | Patch the reference to current `main` |

The skill-catalog-drift audit (the "skill-doctor" pass) is the systematic version of
row 4 — **read `references/skill-drift.md`** for the checklist (description-vs-code,
overlapping triggers, dead `references/` links, frozen counts).

### Job 3 — Propose a new skill → `PROPOSALS.md`

Only when a unit of work in this session was **recurring, costly when done wrong, and
a multi-file recipe** with no covering skill. The bar is in
`references/proposal-bar.md` — apply it honestly; the default answer is *no*. If it
clears:

- **Dedup against `PROPOSALS.md` and the shipped skills.** The backlog already lists
  candidates (e.g. `local-gate-selector` — changed-path → which `LOOM_*` gates to run
  locally — is flagged secondary and unbuilt). If yours is already there, **add
  evidence to the existing entry** (another PR/session that hit it) rather than a
  duplicate — strengthening recurrence is exactly what promotes a candidate to built.
- Write it in the `PROPOSALS.md` house shape: **Trigger / Why (with cited evidence) /
  What it does / Shape (`SKILL.md` + which `references/`)**. Mark single-session finds
  "seen once this session — needs a second sighting to build."

## Report

Lead with the counts: gotchas harvested, skill patches proposed, new-skill candidates
raised (and how many were *rejected* by the bar — a finalizer that proposes nothing is
a valid, common outcome and should say so plainly). Then:

- **Appended** (done): the `experience_gathered.md` / `PROPOSALS.md` additions, by file.
- **Proposed** (awaiting review): each skill-body patch as a diff with its cited
  friction. These are *not* applied — they're for the human to approve.
- **Rejected**: candidates that didn't clear the bar, one line each on why (usually
  "n=1, no recurrence"). Showing the rejects is how the bar stays trusted.

Don't open a PR unless asked. Commit the append-only additions in a coherent docs/meta
commit; leave the proposed skill-body patches for review.

## Why this shape

The finalizer fails in exactly two ways, and it's built against both. It fails by
**overfitting** — promoting a single session's one-off into permanent skill guidance,
bloating the catalog until the triggers stop discriminating. The propose-only rule and
the explicit recurrence bar (`references/proposal-bar.md`) are the guard: n=1 is a
candidate, not a merge; the human and the second sighting are the promotion gate. And
it fails by **self-rewriting drift** — a skill mutating its own instructions with no
reviewer, the meta-layer twin of the stale-base lie. The hard propose-only line on
skill bodies keeps the loop reviewed: memory files grow append-only, skill *bodies*
change only through a diff someone approved. That asymmetry — additive memory, reviewed
mutation — is the whole design.
