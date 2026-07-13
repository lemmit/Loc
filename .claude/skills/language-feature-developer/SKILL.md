---
name: language-feature-developer
description: >-
  End-to-end workflow for adding a language feature to the Loom DSL compiler
  (the .ddd toolchain in this repo) — from a proposal through grammar, IR,
  validation, all five backends and five frontends, and tests. Use this
  whenever the task is to implement, design, or scope a Loom language feature:
  picking up a doc from docs/old/proposals/, closing a codegen gap, adding new
  surface syntax, an expression/statement/type, a capability, a UI primitive,
  or a validator gate. Reach for it even when the user just says "add X to the
  DSL", "implement this proposal", "wire feature Y through all backends", or
  "make Loom support Z" — anything that walks the .ddd compiler pipeline. It
  orchestrates specialist roles (state audit, design review, a paper
  simulation for user sign-off, implementation, and test placement) so the
  feature lands fully and consistently across every target, not half-built on
  one backend.
---

# Loom language feature developer

Adding a feature to Loom means walking a ten-phase, strictly one-directional
pipeline (`.ddd → parse → macro → scope → AST-validate → lower → enrich →
IR-validate → codegen → compose → write`) and landing it across **ten targets**
(5 backends: TS/Hono, .NET, Phoenix vanilla Ecto, Python/FastAPI, Java/Spring;
5 frontends: React, Vue, Svelte, Angular, Feliz F#/Fable). The failure mode this
skill exists to prevent is a feature that's designed for one backend,
half-implemented, or rebuilt because it was already shipped on a fast-moving
`main`.

It runs as a **conductor over specialist roles**. You (the conductor) own the
plan and the user relationship; you spawn each role as a subagent with the prompt
in `agents/`, feeding it the previous role's output. The roles and their prompts:

| Phase | Role | Prompt | Gate |
|---|---|---|---|
| 1 | **State auditor** | `agents/state-auditor.md` | ground truth on fresh `main` |
| 2 | **Feature reviewer** | `agents/feature-reviewer.md` | GO / reframe / HOLD |
| 3 | **Feature simulator** | `agents/feature-simulator.md` | **user signs off on the shape** |
| 4 | **Feature developer** | `agents/feature-developer.md` | implements across targets |
| 5 | **Test developer** | `agents/test-developer.md` | tests at the right tiers |
| 6 | **Final review** | (conductor + `simplify`/`code-review`) | gates green, layering clean |

The dense knowledge each role needs lives in `references/` — read these yourself
too, so you can steer:
- `references/pipeline-checklist.md` — the per-phase file map; which targets each
  feature kind touches; the working discipline.
- `references/test-placement.md` — the test taxonomy, the completeness gates, the
  "lowest altitude" rule.
- `references/architecture-invariants.md` — what "compatible with Loom" means;
  the reviewer's checklist.

## Before anything: orient on fresh `main`

Loom's `main` moves fast (parallel agents land PRs continuously). Start every
feature by syncing — `git fetch origin main && git reset --hard origin/main` (or
rebase the feature branch) — and confirm `npm install` has run (the SessionStart
hook does this; `src/language/generated/` and `node_modules/.bin/biome` should
exist). A stale base lies twice: you rebuild merged work *and* reason from code
that no longer exists. This is not optional ceremony — it's the single biggest
source of wasted effort in this repo.

Then read the proposal (usually under `docs/old/proposals/` — its format is problem →
surface → grammar additions → lowering semantics → open questions) and the
`global-implementation-plan.md` if the feature is part of a roadmap.

## The workflow

Work the phases in order. Each phase's output feeds the next; don't skip the
audit or the simulation gate. Within a phase, keep going to the end without
asking "continue?" — finishing a phase well is the go-ahead for the next.

### Phase 1 — State audit
Spawn the state auditor (`agents/state-auditor.md`). It establishes, on fresh
`main`: is the feature already shipped or partial; the closest existing analog to
mirror; the concrete file slice by pipeline phase; the exact target matrix; the
completeness gates it trips; the risks. **If it comes back "already shipped",
stop and tell the user** — don't build a duplicate (this has happened in this
repo). If "partial", the remaining slice becomes the feature.

### Phase 2 — Feature review
Spawn the feature reviewer (`agents/feature-reviewer.md`) with the audit. It
returns GO / GO-WITH-CHANGES / HOLD against the architecture invariants and DSL
idiom. On HOLD or a genuine design fork, surface it to the user with the
reviewer's recommendation via `AskUserQuestion` — this is a real user-owned
decision, not a "should I proceed". On GO, the recommended minimal slice + analog
carry forward.

### Phase 3 — Simulate, then get user sign-off  ← the key gate
Spawn the feature simulator (`agents/feature-simulator.md`). It produces a paper
prototype grounded in the analog's *real* generated output: the `.ddd` a user
would write, the generated fragment per affected target, a behavioural test
sketch, and open questions. **Show the user this document and get explicit
approval of the shape before writing any compiler code.** This is where the
feature is cheapest to change. Fold the user's answers to the open questions into
the slice. (Per Loom convention, always carry two examples: the `.ddd` source and
the generated output — the simulation is exactly that.)

### Phase 4 — Implement
Spawn the feature developer(s) (`agents/feature-developer.md`). Granularity:
- Do the **shared phases first, in one developer** — grammar → generated → IR
  types → lower → enrich → IR-validate → the `ExprTarget`/`WalkerTarget` seam
  contract. Every backend depends on these, so they can't be parallelized.
- Then fan out: for a feature whose backends touch **disjoint file trees**, spawn
  **one developer per backend/frontend in parallel** (the gap-closure "disjoint
  buckets" pattern — launch them in a single turn). For a feature carried by a
  shared seam, the leaf tables are small enough for one developer.

Keep moving while work runs — if the next slice is independent, start it; don't
idle. Re-sync after any merge to `main`.

### Phase 5 — Tests
Spawn the test developer (`agents/test-developer.md`) with the list of changed
files/targets. It places assertions at the lowest catching altitude and satisfies
the completeness gates. For independent targets this can run in the same turn as
the corresponding feature developer; for shared phases, run it after they land.
The recipe minimum: 1 parsing + 1 negative validator + 1 IR + 1 generator test
per touched backend, plus at least one `LOOM_*` compile pass.

### Phase 6 — Final review and land
- Run the fast suite (`npm test`) and the relevant `LOOM_*` build gates; report
  what you ran and the actual results — never claim green you didn't see.
- Check the layering invariant survived (`pipeline-layering.test.ts`) and the
  Biome gate is clean (the Stop hook enforces this).
- Optionally run the `simplify` or `code-review` skill over the diff for a
  quality pass.
- Commit in coherent, phase-shaped commits and push to the working branch. **Do
  not open a PR unless the user asks.**

## Tailoring to the feature kind

Not every feature walks all six phases at full weight. Use the audit to right-size:

- **Codegen gap-fill** (a backend throws/`# TODO`s on valid `.ddd`, no
  grammar/IR change — e.g. the gap-closure buckets): often skip the simulator's
  full treatment; audit → confirm the sibling-backend logic to port → one
  developer + one generator test + the backend's build gate. Mirror the backend
  that already implements it.
- **Validate-only feature** (turn a runtime mis-emit into a compile error): no
  generators — `ir/validate/checks/*` + `validate.ts` + IR negative tests. The
  simulation is just the rejected `.ddd` and the diagnostic.
- **New domain-logic expr/stmt/type**: hits all 5 backends via the seams; the
  simulation should show the rendered fragment in 2-3 representative backends, and
  every backend gets a `render-expr-kinds`/`render-stmt` arm test.
- **UI page primitive**: the 3 shared-walker frontends + Phoenix HEEx (separate
  engine) + Angular optional seam; the simulation shows the rendered page per
  framework; watch walker-stdlib-completeness and heex-parity.
- **Full new surface syntax** (a `criterion`-scale feature): the whole pipeline,
  the whole workflow, a `docs/<feature>.md`, and probably an `examples/` entry.

## Why this shape

The roles aren't bureaucracy — each kills a specific, observed failure: the
**audit** kills duplicate/stale-base rebuilds; the **review** kills
architecturally-incompatible designs before they cost implementation; the
**simulation gate** kills "I built the wrong thing" by making the user approve the
cheapest artifact (paper); splitting **developer** and **test developer** keeps
each focused and lets the test author honestly judge the implementation rather
than rubber-stamp their own. The whole point is a feature that lands *fully and
consistently across ten targets*, the way a Loom maintainer would do it by hand.
