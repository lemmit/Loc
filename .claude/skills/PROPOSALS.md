# Agent skill proposals

A backlog of Claude Code **skills** worth building for this repo, drawn from a
review of the last ~6 weeks of merged PRs (#1417–#1492) — with a bias toward the
work that *recurred* and the work that *caused problems* (regressions on `main`,
late-caught fallout, half-landed features).

## What already exists (don't re-propose)

- **`language-feature-developer`** (`.claude/skills/language-feature-developer/`,
  shipped #1472) — the conductor-over-roles workflow for landing a *new* Loom
  language feature across all ten targets. Covers: state audit → review →
  paper-simulation sign-off → implement → tests. The skills below are
  deliberately scoped to the work it *doesn't* cover.
- **`session-finalizer`** (`.claude/skills/session-finalizer/`) — the META skill:
  the end-of-session retrospective that feeds *this* backlog. It harvests session
  gotchas into `experience_gathered.md`, proposes trigger/reference patches to the
  skills above, and raises new-skill candidates here — **propose-only** (n=1 is a
  candidate needing a second sighting, never an auto-merge). When a skill below is
  built, it moves it into this "exists" list. The skill the user's "session
  finalizer / self-improvement" idea became.
- **Generic built-ins** — `code-review`, `simplify`, `verify`, `run`, `loop`,
  `security-review`, `update-config`, `session-start-hook`. These are
  language-neutral; the proposals below are Loom-specific where the leverage is.

## The recurring failure modes (the evidence)

| Failure mode | Representative PRs | Cost |
|---|---|---|
| **A feature works on one backend/frontend, silently TODOs/crashes on the others** | #1477, #1478, #1467, #1469, #1455, #1453, #1456, #1457, #1481, #1490, #1484 | Re-audited by hand every few weeks; gaps ship invisibly because no per-PR gate sees them. |
| **Compile-green but migrate/runtime-red** — a per-PR gate (`mix compile`, `tsc --noEmit`) passes, but the bug only fires when migrations run or the stack boots | #1475 (dup `updated_at` at `ecto.migrate`), #1464/#1465 (PG18 PGDATA → db never boots), #1459 (LiveView 302→/login at runtime) | Caught by the *nightly* / heavy gates (`conformance-parity`, `k8s-e2e`) days late, on red `main`. |
| **Version/runtime upgrade fallout** — a "narrow diff" bump slips past the heavy gate that would catch it | #1422–#1430 batch (left `main` red on 4 jobs → #1464), #1463 (TS 6), #1430 (Langium 4), #1427 (Spring Boot 4.1), #1423 (PG 18), #1424 (Py 3.13) | Each upgrade touches *two* surfaces (toolchain + generated `stacks/`); fallout lands on whoever bases off the red commit. |
| **Adding a design pack is a repeated multi-file recipe** that's easy to half-do | #1491 (spartanNg), #1485 (primeng); plus #1478 F1 (Section/Sticky crash on packs missing them) | Required-emit set + walker dispatch + stack manifest + registry + build gate must all line up. |

These map to four proposed skills, ranked by leverage.

---

## 1. `parity-auditor` — cross-target parity audit + gap-drain  ⭐ highest leverage

**Trigger.** "Audit parity across backends/frontends", "which backends support X?",
"drain the compile-tier skip-list", "refresh the parity audit", "feature Y works on
node but not java/python/elixir", picking up `platform-parity-debt.md` or a
`docs/audits/*-parity-*.md`.

**Why.** The single most repeated category of work in the review window. The
`language-feature-developer` skill lands a *new* feature across targets; this skill
owns the *inverse* — taking the existing emitters as ground truth, building the
validator-grounded matrix of who-emits-what, and separating **silent gaps** (a
backend `# TODO`s or crashes on valid `.ddd`) from **honest feature gaps** (gated
by a validator). #1477 and #1478 are exactly this, done by hand; #1467 re-checked a
skip-list against fresh `main` and found half the entries already stale. There's a
standing debt register (`docs/old/proposals/platform-parity-debt.md`) and audit
(`docs/audits/gated-features-inventory.md`) that want a repeatable refresh.

**What it does.**
1. Enumerate the target matrix from `src/platform/registry.ts` (5 backends, 4
   frontends, + elixir vanilla Ecto foundation + HEEx).
2. For each feature axis, find the *authoritative validator gate set* (so the
   matrix cites `loom.*` codes, not prose) and grep each backend's emitter for
   `TODO`/`throw`/stub markers on that axis.
3. Generate a representative `.ddd` per axis, run `generate system` across every
   target, and diff: emitted vs TODO vs validator-rejected. The "compile-tier
   corpus" (#1417) is the existing machinery to reuse — one canonical `.ddd` per
   feature, `platform: __PLATFORM__` token.
4. Produce/refresh the audit doc + drive the **disjoint-bucket fan-out** (one
   developer per backend, since the gaps live in disjoint file trees — the pattern
   #1467 used) handing off to `language-feature-developer` for each real gap.

**Shape.** `SKILL.md` + `references/target-matrix.md` (the registry → matrix map,
the per-axis validator-gate index) + `references/silent-vs-honest-gap.md` (how to
tell a TODO from a deliberate gate). Reuses the corpus tier rather than inventing a
new harness.

---

## 2. `generated-stack-verifier` — boot the generated app locally before trusting nightly  ⭐

**Trigger.** "Does the generated stack actually run?", "verify migrations apply",
"the conformance/obs/k8s-e2e gate is red", "boot backend X and hit it", any change
to migrations / compose / db / auth wiring.

**Why.** Three of the window's regressions (#1475, #1464/#1465, #1459) were
*invisible to the per-PR compile gates* and only surfaced when the stack actually
ran — at migrate time or at HTTP time — caught by nightly/heavy jobs on already-red
`main`. CLAUDE.md documents the full local Docker recipe (dockerd bring-up, the
`LOOM_HEX_MIRROR` Erlang-TLS-fingerprint gotcha, per-backend compile commands), but
it's prose an agent has to rediscover each time. A skill turns "wait for
`conformance-parity` to tell me the db won't boot" into a 3-minute local check.

**What it does.**
1. Bring up `dockerd` (the CLAUDE.md recipe + readiness gate), or use the host
   compiler where one exists (Java/Gradle, Python/uv).
2. `generate system <f.ddd>` for the touched feature, then for the target backend:
   boot the compose stack (or the per-backend container), **run migrations**, hit
   `/ready`, and do a real **read + write round-trip** (the `k8s-e2e` assertion
   shape: `POST` fixture → 201 → read back). This is the exact gap that compile
   gates miss.
3. Know the landmines: PG18 `PGDATA`/volume path (#1465), Flyway on Spring Boot 4
   (#1464), `timestamps()` vs audit columns at migrate (#1475), LiveView dev-auth
   session seeding (#1459), and `LOOM_HEX_MIRROR=1` for Elixir behind the egress
   proxy.

**Shape.** `SKILL.md` + `references/docker-recipes.md` (per-backend bring-up +
compile + boot commands, distilled from CLAUDE.md §Docker and `docs/tools.md`) +
`references/runtime-landmines.md` (the migrate/boot failure catalogue with the PR
that found each). Complements the generic `verify`/`run` skills, which don't know
the multi-backend Docker topology.

---

## 3. `dependency-upgrade` — walk both surfaces, gate both  ⭐

**Trigger.** "Bump <dep>", "upgrade to <runtime> N", "currency batch", picking up
`docs/old/proposals/dependency-upgrades.md`, an `npm audit` finding, a Dependabot-shaped
task.

**Why.** The #1422–#1430 currency batch left `main` red on four jobs (#1464) because
each bump has a footprint the author didn't gate: a runtime version moves a path
(PG18 PGDATA), a framework bump changes a build step (Spring Boot 4 Flyway), a
toolchain bump (Langium 4 → TS 5.9 → TS 6, #1430/#1463) cascades through the
Node-only islands. The recurring root cause is structural: **an upgrade touches two
surfaces** — the *toolchain's* own deps and the *generated projects'* stack
templates (`stacks/v*/`, `docker/`, per-backend `package.json`/`build.gradle`
emitters) — and the heavy gate that would catch the second surface doesn't run on a
"narrow" diff.

**What it does.**
1. Classify the bump: toolchain-only, generated-stack-only, or both — and for
   "both", enumerate the `stacks/` manifest + per-backend template that pins it.
2. Sequence stacked upgrades (the #1427→#1430 "stacked PR" pattern) when one bump
   gates another (Langium 4 needs TS ≥ 5.8; TS 6 deferred to its own PR).
3. Force-run the *right* heavy gate locally via `generated-stack-verifier` (#2) —
   specifically the compose-boot / migrate gate that a narrow image-tag diff skips.
4. Carry the known landmine list (PGDATA, Flyway, hex fingerprint, `@types/node`
   global resolution on TS 6) so each is checked, not rediscovered.

**Shape.** `SKILL.md` + `references/upgrade-footprint.md` (the two-surface map:
which toolchain dep ↔ which generated-stack template ↔ which CI gate) +
`references/known-landmines.md`. Cross-links #2 for the boot gate.

---

## 4. `design-pack-author` — scaffold a pack/version, satisfy the required-set gate

**Trigger.** "Add a <library> design pack", "new pack version", "port pack X to
Vue/Svelte/Angular", picking up `docs/design-packs.md`.

**Why.** Five+ packs landed or were extended in the window (#1491 spartanNg, #1485
primeng, plus the Angular/Vue/Svelte pack families), each a multi-file recipe:
manifest + stack version + the required-emit set + walker dispatch wiring +
registry + the per-pack `generated-*-build` gate. #1478's HIGH finding was a
pack-completeness gap exactly here — `Section`/`Sticky` dispatched via `pack.render`
with no presence guard, crashing codegen on packs that didn't implement them. A
skill encodes the required-set and runs the build gate so a new pack lands complete.

**What it does.** Walk `docs/design-packs.md`'s "recipe for a new version": copy the
closest existing pack, fill the `RequiredSet`, wire the stack manifest
(`stacks/v*/stack.json`), register, then run the matching
`generated-{react,vue,svelte}-build` gate (`LOOM_*_BUILD_CASE=<ddd>:<pack>`) across
the example × pack matrix until green. Flags any primitive in `WALKER_PRIMITIVES`
the new pack doesn't cover (the #1478 class of bug).

**Shape.** `SKILL.md` + `references/required-emit-set.md` + a pointer to the closest
analog pack per framework. Smaller than the three above; high "without hassle"
value because the failure mode is a forgotten file, not a design question.

---

## Secondary / lighter ideas

- **`local-gate-selector`** — map a diff to the exact CI workflows + `LOOM_*` gates
  that cover it, and run just those locally. The suite is sharded 4 ways with ~20
  opt-in gates and ~10 per-backend build workflows; today an agent either runs
  everything or guesses. Could fold into #1–#4 as a shared `references/` table
  (changed-path → gate) rather than a standalone skill.
- **PR sync/deconflict** — already well-covered by CLAUDE.md discipline + the
  `pre-push-merge-check` hook + the built-in babysit/`loop` flow; not worth a skill.

## Suggested order

1. `parity-auditor` and 2. `generated-stack-verifier` first — they target the two
biggest cost centers (recurring parity audits; runtime regressions on `main`) and
3. `dependency-upgrade` reuses #2's boot gate. 4. `design-pack-author` is the
cheapest to build and immediately removes a papercut. The `references/` tables
(target matrix, docker recipes, upgrade footprint) are shared assets worth writing
once even before the skills wrap them.

---

# Round 2 — a deeper PR sweep (#1388–#1449)

A second pass over the prior ~50 PRs surfaced one more skill worth building and
sharpened the case for the first four.

## 5. `status-refresh` — re-verify docs/old/proposals/comments against fresh `main`  ⭐ new

**Trigger.** "The docs are stale", "refresh the trackers", "audit the proposals
against `main`", after any rename/removal/refactor ("scrub the stale references to
X"), "is this doc still true?", picking up `global-implementation-plan.md` or the
proposals `README.md` status table.

**Why.** Documentation drift is a *standing, sizable* tax here — not a one-off. The
evidence is unusually direct:
- **#1407** — a single PR did ~150 code-verified doc-checks and corrected ~65 docs.
  Its diagnosis names the recurring shape exactly: a **"3-backend-era freeze"** —
  features written up as "three/four backends" that now ship on five, plus a fourth
  frontend (Angular) the docs never picked up.
- **#1441 / #1438 / #1431** — three separate *follow-up* PRs to scrub stale
  `source`/`origin`/`⑤c` references after one removal (#1408). The removal was clean
  in code on the first PR; the docs/comments took three more passes to catch up.
- **#1443** — had to write *guardrails* (`experience_gathered.md` §15) so the
  stamped-field/sentinel debt class "doesn't re-accrete".
- **The proposals `README.md` says of itself**: "This README is hand-maintained and
  was previously stale." CLAUDE.md's whole "Sync with `main` constantly — it moves
  under you / a stale base lies twice" section is the same lesson at the code level.
- **Live proof:** while building skill #1, the `parity-auditor` agent found *five*
  doc/code disagreements in passing — including that the backend-parity audit's
  flagship Finding F1 (Python capability-filter "silent gap") is already fixed in
  code (`system-checks.ts:1004` gates Python), and that
  `platform-parity-debt.md`'s matrix still has only node/dotnet/phoenix/react
  columns. The docs rot faster than they're read.

This is distinct from `parity-auditor` (which audits *emitter feature support* and
may refresh one parity doc) — `status-refresh` audits *documentation truthfulness*
broadly (proposals, reference docs, CLAUDE.md, code comments, trackers) against the
code. `parity-auditor` can hand off to it; they share the "fresh `main` wins over
prose" discipline.

**What it does.**
1. Take a scope: a doc set (`docs/`, `docs/old/proposals/`, `CLAUDE.md`) or a *concept*
   just renamed/removed (then grep the concept name across `src/`/`test/`/`docs/`,
   per the #1443 guardrail).
2. For each claim, find the authoritative code (the validator gate, the emitter, the
   registry) and classify: true / stale / wrong. Backend-count and frontend-count
   claims are the highest-yield (the "N-backend-era freeze").
3. Fix the docs (docs-only — never edit code to match a doc), and refresh the status
   tables in `README.md` + `global-implementation-plan.md` together (they're meant
   to agree).

**Shape.** `SKILL.md` + `references/drift-hotspots.md` (the claims that rot fastest:
backend/frontend counts, "shipped/partial/proposed" status tags, the per-feature
target lists; the authoritative code location to check each against) +
`references/concept-removal-checklist.md` (the grep-the-concept-name sweep for after
a rename/removal, distilled from #1441/#1438/#1443).

## What Round 2 reinforced (no new skill — evidence for the first four)

- **Per-backend codegen that compiles in isolation but is never *exercised*** →
  `generated-stack-verifier` + `parity-auditor`. #1419: the .NET `AuditableInterceptor`
  "emitted uncompilable code that **no build matrix ever exercised**" — stamped
  fields were `private set`, unwritable from the interceptor — "unlike Java, which
  has a tested cell". #1445: generate-time string-asserts + compile-time `tsc`/`vue-tsc`
  both passed, but the **runtime** smoke caught a ship-blocking React/Vue op-button
  crash. Compile-green ≠ correct, repeatedly.
- **Feature fan-outs across N targets, each with its own breakage** →
  `parity-auditor`'s disjoint-bucket workflow is the right shape. Two large waves in
  this window: lifecycle stamping (#1444 hono, #1446/#1449 python "re-land", #1447
  elixir, #1419 dotnet, #1442 validate gate) and the auth UI-gate
  (#1397/#1401/#1404/#1409/#1411/#1418/#1420/#1429/#1432/#1433/#1445 — every
  frontend + Phoenix). The same feature, ported one target at a time, is the dominant
  delivery unit here.

---

# Round 3 — single-session finds (2026-06-28, tenancy docs-refresh + parity-verify session)

No new skill cleared the bar this session. Two **skill-body patch** candidates
(propose-only — diffs for human review) and one rejected new-skill idea. Both
patches are *n=1* (one session) but each removes a concretely-cited friction and is
low-risk/additive to the skill prose.

## Patch A — `status-refresh`: re-verify cited code *right before commit*, not only at start

**Cited friction (this session).** A tenancy/capability-filter status-refresh synced
`main` at start (`740b823`), read `system-checks.ts`, and wrote edits asserting
*"python wires relational filters only."* By push time `main` was `d2b8e70` and
**#1571 had landed python `shape(embedded)` filters mid-session** — the edits were
now false, caught only by a lucky rebase conflict (full write-up:
`experience_gathered.md` §17). The skill's "orient on fresh `main`" section frames
the sync as a **step-zero** action; it doesn't say to re-derive the cited lines
again at commit time, which is exactly when a long audit's base has drifted.

**Proposed diff (`status-refresh/SKILL.md`, "Before anything: orient on fresh main" section):**
add a closing sentence —
> **Re-verify at commit time, not just at start.** For a long audit, `git fetch
> origin main -q` and re-read the *cited lines* again right before you commit — the
> deliverable is prose about code, and a busy `main` can move the code under you
> mid-session (a claim verified against an hour-old base is a claim about behaviour
> that may no longer exist). Also `git log origin/main -- <target docs>` first:
> parallel agents refresh the same trackers, and `main` may have already done your
> sweep.

**Status:** seen once this session — needs a second sighting to build, but the patch
is safe to land now (additive caution, matches CLAUDE.md's "stale base lies twice").

## Patch B — orient step `git reset --hard origin/main` is destructive on a feature branch

**Cited friction (this session).** Following the literal orient command `git fetch
origin main && git reset --hard origin/main` **while on a feature branch carrying
pushed commits** (`af888fa`/`e215079`) dropped them from the local branch + working
tree at finalize time. Recoverable (`git reset --hard origin/<feature-branch>`; the
reflog pinned the tip), but a sharp edge. This command appears in **`status-refresh`,
`parity-auditor`, and `session-finalizer`** orient sections. `session-finalizer` is
the worst case: it runs at *session end*, when feature-branch commits always exist.

**Proposed diff (all three skills' orient blocks):** qualify the command —
> ```bash
> git fetch origin main -q       # fetch only
> # On a throwaway/clean checkout you can `git reset --hard origin/main`.
> # On a feature branch with commits you want to KEEP, do NOT reset to origin/main —
> # it discards them. Compare instead: `git log/diff origin/main`, or rebase the
> # branch onto it (`git rebase origin/main`).
> ```

**Status:** n=1 but a genuine foot-gun in shipped skill prose; the fix is a
clarifying comment, no behaviour change. Recommend landing.

## Rejected new-skill idea

- **"parity-verdict-via-fixture+CLI-repro" helper** — the method that resolved the
  document-principal HONEST/silent question (find a compile-gated `*-tenancy.ddd`
  build fixture → `node bin/cli.js generate system <fixture> -o /tmp/out` → grep the
  emitted repo for the woven construct). **Rejected:** this *is* `parity-auditor`
  Step 3 already, verbatim. The session confirms the skill works; no new skill, no
  patch. (Positive signal worth recording: `status-refresh` correctly refused to fix
  the stale *code* comment it found — flagged it, stayed docs-only — and handed it to
  `parity-auditor`, which verified then fixed. The docs-only / flag-don't-fix
  boundary worked exactly as designed.)
