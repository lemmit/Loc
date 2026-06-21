# Agent skill proposals

A backlog of Claude Code **skills** worth building for this repo, drawn from a
review of the last ~6 weeks of merged PRs (#1417–#1492) — with a bias toward the
work that *recurred* and the work that *caused problems* (regressions on `main`,
late-caught fallout, half-landed features).

## What already exists (don't re-propose)

- **`language-feature-developer`** (`.claude/skills/language-feature-developer/`,
  shipped #1472) — the conductor-over-roles workflow for landing a *new* Loom
  language feature across all nine targets. Covers: state audit → review →
  paper-simulation sign-off → implement → tests. The skills below are
  deliberately scoped to the work it *doesn't* cover.
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
standing debt register (`docs/proposals/platform-parity-debt.md`) and audit
(`docs/audits/gated-features-inventory.md`) that want a repeatable refresh.

**What it does.**
1. Enumerate the target matrix from `src/platform/registry.ts` (5 backends, 4
   frontends, + elixir vanilla/ash foundations + HEEx).
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
`docs/proposals/dependency-upgrades.md`, an `npm audit` finding, a Dependabot-shaped
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
