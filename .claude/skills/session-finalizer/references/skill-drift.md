# Skill-catalog drift — the skill-doctor checklist

This is the systematic version of job 2's "a skill's reference is now wrong" row,
pointed at `.claude/skills/` itself. It is `status-refresh`'s discipline applied to
the meta layer: a skill's `description` and `references/` make **claims about the
code** (file paths, backend counts, validator codes, gate names), and those claims
rot exactly like docs do. Run this pass when asked to "audit the skills / skill-doctor
/ are the skills stale," or opportunistically during a finalize.

It is **propose-only** for skill bodies — every fix here is a diff for review, except
fixing a literally-dead path which is mechanical and safe.

## Orient on fresh `main` first

Every claim is checked against current code. `git fetch origin main -q` and verify
from the cited line, never memory — the meta layer lies the same way the docs do.

## The four drift classes

### 1. Description ↔ code drift (highest yield)

A skill's `description` cites concrete anchors. Check each against `main`:

- **Backend/frontend COUNT** — the **N-backend-era freeze**, the single highest-yield
  pattern (`status-refresh`). The ground truth is `src/platform/registry.ts`: today
  **5 backends** (`node`/Hono, `dotnet`, `java`, `python`, `elixir` — vanilla Ecto/
  Phoenix; the Ash foundation was removed, #1568) and **5 frontends** (`react`, `vue`,
  `svelte`, `angular`, `feliz` — F#/Fable/Elmish, added after the `angular` era). Any
  skill description saying "five backends and five frontends" is correct *today* but is
  a freeze candidate the moment the set grows — and any that enumerates a *subset* as if
  complete ("node/dotnet/phoenix", or "four frontends" now that `feliz` shipped) is
  already stale. Grep:
  ```
  rg -n "backends?|frontends?|targets?" .claude/skills/*/SKILL.md | rg -n "three|four|five|node/dotnet"
  ```
  then reconcile each hit against the registry count.
- **A cited file path** — does it still exist? Renames (`origin`/`source` removal,
  phase `⑤c` removal, `lower.ts` leaf-splits) leave skill prose pointing at moved or
  deleted files. Spot-check the paths a skill names.
- **A validator code / gate name** (`loom.*`, a `LOOM_*` env gate, a CI workflow) —
  still the real name? Gate renames and split workflows orphan the reference.

### 2. Trigger drift — too narrow, too broad, or overlapping

The `description` is the **routing surface** — its only job is matching a real ask to
the right skill. Two failure modes, plus overlap:

- **Too narrow** — a session did a skill's work by hand because the user's phrasing
  wasn't in the trigger list. Fix: add the actual phrasing used (job 2, "widen").
- **Too broad** — a skill fired on a task it doesn't serve. Fix: add a boundary clause
  excluding the misfire (the existing skills all carry explicit "this is NOT…/Boundary"
  clauses — match that shape).
- **Overlapping triggers** — two skills both plausibly match the same ask with no
  boundary disambiguating them. The catalog already disambiguates the close pairs in
  prose (`parity-auditor` "audits emitter support, hands off to language-feature-
  developer"; `status-refresh` "audits docs truthfulness, NOT emitter support"). A new
  overlap with no such clause is the drift — propose the disambiguating boundary line
  on *both* sides.

### 3. Dead `references/` links

Each `SKILL.md` points into its own `references/*.md`. Verify every referenced file
exists and every `references/` file is still pointed at by its `SKILL.md` (an orphan
reference is dead weight). Mechanical:
```
for d in .claude/skills/*/; do
  for r in "$d"references/*.md; do [ -e "$r" ] || echo "MISSING: $r"; done
done
```
A `SKILL.md` that says "read `references/foo.md`" where `foo.md` doesn't exist is a
hard break — fixable directly (it's not a guidance rewrite).

### 4. `PROPOSALS.md` ↔ reality drift

`PROPOSALS.md` has a "What already exists (don't re-propose)" list and numbered
candidates. Drift to fix:
- A candidate that **got built** is still listed as a proposal → move it to the
  "exists" list (this is the meta-layer twin of `status-refresh` flipping a status tag).
- The "exists" list **missing a shipped skill** → add it, so the next finalize dedups
  against a complete set.

## Output

Same as the finalizer's report: lead with counts (claims checked / true / stale /
dead), list mechanical fixes done (dead paths/links), and list description/trigger
patches as **proposed diffs** for review. Don't rewrite a skill's guidance under a
"refresh" banner — that buries a behaviour change where no reviewer expects it, the
exact failure `status-refresh` guards against in docs.
