---
name: status-refresh
description: >-
  Re-verify Loom's DOCUMENTATION against fresh `main` and fix the drift —
  docs-only. Use this whenever the task is about whether the prose still matches
  the code: "the docs are stale", "refresh the trackers / the proposals status
  table", "audit the proposals against main", "is this doc still true?", "bump
  the last-refreshed line", or picking up `docs/proposals/README.md` or
  `docs/proposals/global-implementation-plan.md`. ALSO use it after any
  rename/removal/refactor to scrub the references that outlive the deleted thing:
  "scrub the stale references to X", "I removed `origin`/`source`/`⑤c`, find what
  still mentions it", "this concept was renamed, sweep the docs/comments". Two
  modes: a broad scoped doc audit (a doc set: `docs/`, `docs/proposals/`,
  `CLAUDE.md`, code comments) and a post-refactor concept scrub (one renamed/
  removed concept, grepped across `src/`/`test/`/`docs/`). The single highest-yield
  pattern is the "N-backend-era freeze" — prose frozen at "three/four backends"
  that now ship on five, plus frontends (Angular, then Feliz F#/Fable) the docs
  never picked up.
  Boundary: this is documentation TRUTHFULNESS, NOT parity-auditor's emitter
  feature audit (it audits whether a backend EMITS a feature; this audits whether
  the DOCS describe what's true). And it is strictly DOCS-ONLY — never edit code
  to make it match a doc; if the code is the thing that's wrong, flag it and stop,
  that's a different task. Don't reach for it to ADD a feature or fix an emitter —
  that's language-feature-developer.
---

# Loom status refresh

Documentation drift in this repo is a **standing, sizable tax** — not a one-off
cleanup. The proof is in the git log: **#1407** did ~150 code-verified doc-checks
and corrected ~65 docs in one pass, diagnosing a recurring shape it named the
**"3-backend-era freeze"** — features written up as "three/four backends" that now
ship on five, plus frontends (a fourth, Angular; a fifth, Feliz F#/Fable) the docs
never picked up. **#1441 /
#1438 / #1431** were *three separate follow-up PRs* to scrub stale
`source`/`origin`/`⑤c` references after a single removal (#1408) — the code was
clean on the first PR; the docs and comments took three more passes to catch up.
**#1443** had to write *guardrails* (`experience_gathered.md` §15) so the debt
class "doesn't re-accrete." And the proposals `README.md` says of *itself*: "This
README is hand-maintained and was previously stale."

This is the documentation twin of CLAUDE.md's "Sync with `main` constantly — a
stale base lies twice" discipline. There it's about not rebuilding merged work;
here it's about not *teaching the dead model* to the next agent. The docs rot
faster than they're read, so a code-grounded refresh pass pays for itself
immediately. While the sibling skills were being built this session, agents found
~5 doc/code disagreements *in passing* (catalogued in `references/drift-hotspots.md`)
— the surface is that drifty.

## The boundary — read this before starting

Two things this skill is **not**:

- **It is not `parity-auditor`.** That skill audits *emitter feature support* —
  "does backend X actually emit feature Y, or does it silently TODO." This skill
  audits *documentation truthfulness* — "does the prose describe what the code
  does." They share the "fresh `main` wins over prose" discipline and the same
  authoritative-code anchors (the registry, the validator gates), and
  `parity-auditor` can hand a stale parity doc to you. But the deliverable differs:
  parity-auditor's is a who-emits-what matrix; yours is corrected docs.

- **It is DOCS-ONLY. Never edit code to make it match a doc.** The code on fresh
  `main` is the contract; the doc is the thing that's allowed to be wrong. If you
  find a doc and code disagree, the doc is what you fix — *unless* the code is the
  thing that's actually wrong (a real bug, a stale comment describing intended-but-
  broken behaviour). In that case **flag it and stop** — fixing code is a different
  task (`language-feature-developer` or a bug fix), and silently patching code
  under a "refresh the docs" banner hides a real change inside a docs PR where no
  reviewer expects it. Surface it: "code at `X:NN` looks wrong vs the doc's claim —
  not fixing it here; the doc is being left as-is / annotated pending that fix."

These shaped doc-only PRs are the model: #1407, #1431, #1438, #1441, #1428 — every
one "docs-only, no code touched."

## Before anything: orient on fresh `main` — that is the whole point

A status refresh run on a stale base produces *new* drift. Sync first:

```bash
git fetch origin main && git reset --hard origin/main   # or rebase the feature branch
```

Confirm `npm install` has run (the SessionStart hook does it; `src/language/generated/`
and `node_modules/.bin/biome` should exist). Every claim you classify must be
re-derived from the *current* cited line — never carry a "this is how it works"
from memory. The code wins, every time.

## Pick a mode

### Mode A — scoped doc audit

The scope is a doc set: `docs/proposals/README.md` (the status table — the canonical
drift surface), `docs/proposals/global-implementation-plan.md` (the gap inventory),
a reference doc under `docs/`, `CLAUDE.md`, or a `docs/audits/*` snapshot. Walk each
claim, find the code that proves it, classify, fix. The README table and the
global-implementation-plan are **meant to agree** — refresh them together.

### Mode B — concept-removal scrub

The scope is a single concept that was just **renamed or removed** (`origin`,
`source`, phase `⑤c`, `computeExports`→`collectExportedSymbols`, `wireShape`→…).
The code change landed; now sweep everything the *name* of the dead concept still
lives in. This is the #1441/#1438/#1443 arc, and it has its own checklist —
**read `references/concept-removal-checklist.md`** and follow it. The headline rule
(distilled from `experience_gathered.md` §15): *deleting a concept isn't done when
the code compiles — grep the name of the concept across `src/`, `test/`, `docs/`,
`CLAUDE.md`, and `experience_gathered.md`, including comments and test titles, in
one pass.* The symbol the compiler removed for you is the easy 20%; the prose that
still teaches the dead model is the lingering 80%.

## The verification loop (both modes)

For each claim, the loop is the same:

**1. Locate the authoritative code.** A doc claim is checkable iff you can name the
file that proves it. The anchors, by claim kind (full index in
`references/drift-hotspots.md`):

- **Backend/frontend COUNT** ("three backends", "the React frontend") → the platform
  registry `src/platform/registry.ts` (`platforms` map). This is the **#1 drift** —
  see below.
- **"Is feature X gated / honest"** → the validator gate sets in
  `src/ir/validate/checks/*` and `src/language/validators/*` (the `loom.*` codes and
  the `const FOO_BACKENDS = new Set([...])` literals).
- **"Backend X emits feature Y"** → the emitter `src/generator/<platform>/` (grep
  for the construct, not just non-empty output). For deep who-emits-what, this is
  `parity-auditor` territory — don't redo its audit; cite it or hand off.
- **A version/pin** ("net8", "Spring Boot 3.5", "stack v2") → the actual emitter
  pin on disk (`src/generator/<plat>/pins.ts` / `renderCsproj` / `SPRING_BOOT_VERSION`,
  the `stacks/` directory listing). Trust the on-disk pin, not an audit doc.
- **A SHIPPED/PARTIAL/PROPOSED status tag** → the grammar + IR + emitter for that
  feature; "SHIPPED" must mean it's on `origin/main` per the README legend.

**2. Classify the claim** as one of three:

- **true** — leave it (but note you verified it, with the line).
- **stale** — was true, the code moved (a rename, a count grew, a status advanced).
  The common case. Fix the doc to the current reality.
- **wrong** — never matched, or describes broken/intended behaviour. If the *doc* is
  wrong, fix it. If the *code* is wrong, that's the boundary case above — flag, don't
  fix code.

**3. Fix the doc** (docs-only) and move on.

## The highest-yield pattern: the N-backend-era freeze

Backend-count and frontend-count claims are where the most stale text hides, because
the target set *grows* and prose written at "three backends" never self-updates. The
ground truth is the registry: `src/platform/registry.ts` today registers **5 backends**
(`node`/Hono, `dotnet`, `java`, `python`, `elixir` — vanilla Ecto/Phoenix)
and **5 frontends** (`react`, `vue`, `svelte`, `angular`, `feliz` — F#/Fable/Elmish
via `dotnet fable`+vite). Any doc saying "three
backends", "four targets", "the React frontend" (singular), or listing
"node/dotnet/phoenix/react" as if that's the whole set is a freeze artifact.

Live example found this session: `global-implementation-plan.md:39` still opens "The
ten-phase pipeline, **three DB backends** … and **the React frontend** are mature" —
a 2026-06-10 snapshot frozen before java/python landed as DB backends and before
vue/svelte/angular. That's a textbook freeze line.

Grep for the pattern, then check each hit against the registry:

```
rg -n "three (DB )?backends|four (backends|frontends|targets)|the React frontend\b|node/dotnet/phoenix" docs/ CLAUDE.md
```

`references/drift-hotspots.md` has the worked examples and the other recurring claim
shapes (status tags, per-feature target lists).

## Refresh the trackers together, bump the date

The README status table and `global-implementation-plan.md` are a matched pair — the
README owns per-proposal status, the plan owns ordering/gap-inventory, and the README
literally says "If you spot drift … update both the entry and `global-implementation-plan.md`."
The plan's own maintenance rule says: when work lands, update *three* places in one PR
— the plan item, the proposal's own status header, and the README row. So when you flip
a status:

- Update the README table row **and** the matching plan entry **and** the proposal
  doc's own status header. A header that says "not yet started" while the emitter
  exists costs the next agent hours — that asymmetry is exactly the failure mode this
  skill exists to kill.
- **Bump the "Last refreshed: YYYY-MM-DD" line** in the README (and note the audit was
  code-verified, matching the existing `**Last refreshed: 2026-06-10**` block's shape).
  An un-bumped date makes the next reader trust stale rows.
- Where a doc has dated annotation blocks (the audits' `[2026-06-20 audit]` style),
  add one saying what moved rather than silently overwriting — the history is useful.

## Report

Lead with the count: claims checked, and how many were true / stale / wrong. List
the fixes by file. Surface any **code/doc disagreements where the code looked wrong**
separately and prominently — those are the boundary cases you did *not* fix, and
they're the most useful thing a refresh turns up (this session's passing finds are
the evidence the surface is worth watching). Don't open a PR unless asked; commit
docs-only in coherent commits.

## Why this shape

The refresh fails in exactly two ways, and the skill is built against both. It fails
by **running on a stale base** — so step zero is `git fetch` and every claim is
re-derived from the cited line, never memory. And it fails by **drifting into code
edits** — an agent "fixing drift" is one keystroke from patching the code to match a
convenient doc, which buries a behaviour change in a docs PR. The docs-only rule and
the flag-don't-fix boundary keep the two activities cleanly separated: docs bend to
the code, never the reverse. The N-backend-freeze heuristic exists because that's the
empirically highest-yield class — counting columns against the registry catches more
stale prose per minute than reading any single proposal end to end.
