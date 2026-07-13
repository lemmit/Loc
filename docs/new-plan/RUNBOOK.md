# Mission runbook — how an agent executes a mission

*This is the standing protocol for implementing any mission from this plan. It exists so the kickoff prompt can be two lines. Follow it in order; every step is load-bearing.*

## 0. Inputs
You were given a mission ID (`M-Tx.y`). Everything else you need is discoverable:
- The mission entry in its track file (`docs/new-plan/T<x>-*.md`) — goal, size, priority, dependencies, acceptance, and links to the archived design docs under `docs/old/` that carry the full design (grammar sketches, semantics, open questions).
- Repo ground rules: `CLAUDE.md` (build/test commands, conventions, the claiming protocol) and `experience_gathered.md` (gotchas — read before non-trivial work).
- Pinned decisions: `docs/decisions.md` — if your mission touches a `D-*` tag, the tag wins; re-open the decision explicitly rather than silently diverging.

## 1. Sync and verify the gap still exists
- `git fetch origin main && git switch -c <branch> origin/main` — never start on a stale base.
- **Code-verify the mission's premise** against fresh `main` (grep the gates/emitters/tests it names; check `git log --oneline -20` and open PRs). Statuses rot; missions carrying ⚠ *verify-first* have known doubt. If the work is already done or claimed by an open draft PR, STOP: update the mission status in the track file instead, and pick nothing else without reporting back.

## 2. Claim
Open a **draft PR** whose title starts with the mission ID (e.g. `M-T2.1: renamed-from field intent`) and whose body states scope + files touched, per CLAUDE.md's claiming protocol. This is the first action after verification, not a wrap-up step.

## 3. Design before code (when the mission says so)
Missions marked *design-first* or touching grammar require the design pass first: read the linked `docs/old/` proposal(s) fully, honor their pinned decisions, and follow the matching repo skill if one exists (`language-feature-developer` for DSL features, `dependency-upgrade` for version bumps, `generated-stack-verifier` before pushing anything in the migrate/boot blast radius, `parity-auditor` for cross-target audits). Resolve the mission's named open questions in the PR description — don't leave them implicit.

## 4. Implement to the repo's bar
- Follow the pipeline recipes in `CLAUDE.md` §Extending (grammar → IR → validators → all backends' emitters → printers → tests). A feature is not done on one backend: it either lands on every target or gets an honest `loom.*` validator gate on the others — **never a silent gap, a crash, or a TODO comment emitted into compiling output**.
- New behavior needs: one parsing test, one negative validator test, one generator test per affected backend, and the matching completeness-pin updates.
- Run the gates locally before pushing: `npm test`, plus the per-backend compile/boot gate matching your blast radius (see CLAUDE.md's test table). The heavy compose-boot gates do NOT run on narrow diffs — run them yourself when you touched migrations/boot/db wiring.

## 5. Close the loop (as important as the code)
- Update the mission's status line in its track file (and its `coverage.md` rows if a source doc is now fully drained). **No status flip without code evidence** — cite the file:line or gate in the commit.
- If you discovered the mission was bigger/smaller/different than written, edit the mission text so the next agent inherits reality.
- If you found adjacent hollow work (claimed-done-but-fake — see M-T9.8's signal list), record it: correct the status, and add a mission if it needs real work.
- Mark the PR ready only when built and green. Merged PR = done; do not stack unrelated follow-ups on the same branch.

## The kickoff prompt (copy-paste, one line to change)

> Implement mission **M-T2.1 and M-T2.2** from `docs/new-plan/` (track file `T2-data-evolution.md`). Follow the protocol in `docs/new-plan/RUNBOOK.md` end to end — including verifying the gap still exists on fresh `main`, claiming with a draft PR titled with the mission ID, and updating the mission status when done.

To start any other mission, replace the mission ID(s) and track file. Missions in one shortlist line (see `README.md` §Priority shortlist) can be taken together when they share files; otherwise one mission per agent.
