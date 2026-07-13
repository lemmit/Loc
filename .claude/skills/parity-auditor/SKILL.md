---
name: parity-auditor
description: >-
  Cross-target parity audit and gap-drain for the Loom DSL compiler — owns the
  INVERSE of building a feature: take the existing emitters as ground truth,
  build the validator-grounded who-emits-what matrix across all targets, and
  drain the gap-lists. Use this whenever the task is to audit, survey, or
  reconcile feature support ACROSS backends/frontends rather than add one
  feature: "audit parity across backends", "which backends support X / where
  does feature Y work", "feature Y works on node but not java/python/elixir",
  "drain the compile-tier skip-list", "refresh / redo the parity audit", "is
  this gap real or stale", or picking up `docs/proposals/platform-parity-debt.md`
  or any `docs/audits/*-parity-*.md`. Reach for it even when the user just says
  "what's the state of X across the stack" or "find the silent gaps". Its core
  discipline is separating a SILENT gap (a backend # TODOs / throws / crashes on
  valid `.ddd`) from an HONEST gap (a `loom.*` validator code), re-verified on
  fresh `main` because parity claims rot fast. It does NOT implement the fixes —
  once a real gap is confirmed it HANDS OFF to the language-feature-developer
  skill (which owns landing a feature across targets). Don't use it to add new
  surface syntax or wire a single new feature — that's language-feature-developer.
---

# Loom parity auditor

Loom emits the same `.ddd` model across **10 targets** — 5 domain-logic backends
(TS/Hono `node`, .NET `dotnet`, Java/Spring `java`, Python/FastAPI `python`,
Phoenix `elixir` on plain Ecto — the `vanilla` foundation, the only one) and 5 frontends
(React, Vue, Svelte, Angular, Feliz — F#/Fable/Elmish) plus the Phoenix HEEx render path. Parity is the
promise that a feature either works on a target or **fails fast at validate
time** — it never silently emits a half-working backend. Auditing that promise,
and draining the lists of where it's broken, is the single most repeated category
of work in recent PRs (the #1477 backend audit, the #1478 frontend audit, the
#1467 compile-tier skip-list drain).

This skill is the **inverse of `language-feature-developer`**. That skill lands a
*new* feature across the targets. This one takes the *existing* emitters as ground
truth and answers "who emits what, where's the gate, and which gaps are real" —
then hands each real gap back to `language-feature-developer` to close. Keep the
boundary clean: if you find yourself editing `ddd.langium`, an IR node, or an
emitter to *add* behaviour, you've crossed into the other skill — stop and hand
off.

The core discipline, the thing this skill exists to get right, is the
**silent-vs-honest gap distinction**:

- **HONEST gap** — the target is omitted from a validator gate set, so valid
  `.ddd` that uses the feature on that target gets a hard `loom.*-unsupported`
  error. Annoying but *safe*: the user is told, nothing mis-emits. Closing it is a
  feature task for `language-feature-developer`.
- **SILENT gap (🔴)** — the target is *absent from the gate's checked set AND the
  emitter produces nothing* (or `# TODO`s / throws mid-generation). Valid `.ddd`
  passes validation and emits a backend that's quietly wrong — soft-deleted rows
  leak, tenancy scoping vanishes, a page crashes codegen. This is a **correctness
  bug**, higher priority, and often the real find of an audit.

`references/silent-vs-honest-gap.md` is the concrete recipe for telling them
apart — read it before classifying anything.

## Before anything: orient on fresh `main` — parity claims rot

This is not boilerplate; it's the #1467 lesson. That skip-list drain found **half
the list was already stale** on fresh `main` — the gaps had been closed by other
PRs and the doc just hadn't caught up. The backend audit doc
(`docs/audits/backend-feature-parity-2026-06.md`) lists Python as a 🔴 silent gap
for capability filters (Finding F1) — but on a current checkout
`system-checks.ts:1004` already reads `LIMITED_FAMILIES = new Set(["node",
"elixir", "java", "python"])`, i.e. **python is now gated; F1 is fixed**. The doc
is a point-in-time snapshot; the code is the contract. When the audit prose and
the cited line disagree, **the code wins, every time.**

So, first:

```bash
git fetch origin main && git reset --hard origin/main   # or rebase the feature branch
```

Confirm `npm install` has run (the SessionStart hook does it; `src/language/generated/`
and `node_modules/.bin/biome` should exist). Then re-derive every claim you're
about to make from the *current* cited lines — never carry a row forward from an
audit doc on trust. A stale base makes you report gaps that no longer exist and
miss ones that just opened.

## The workflow

Work it in order. Each step feeds the next; the matrix is only as good as the
gate citations under it.

### Step 1 — Enumerate the target matrix from the registry

The authoritative roster is `src/platform/registry.ts` (the `platforms` map +
`inTreeBackends`) and `src/platform/surface.ts` (`PlatformDescriptor` —
`needsDb` / `mountsUi` / `isFrontend` / `hostableFrameworks`). Don't hand-list
targets from memory — read the registry, because backends arrive as
`family@version` packages and the set grows. The current roster and the
per-axis gate index live in
`references/target-matrix.md` — start there, but **re-read the registry** to
confirm nothing was added.

The two helpers that turn the registry into a usable test matrix already exist —
reuse them, don't reinvent:
- `test/fixtures/corpus/backends.ts` — the canonical 5 backend keys (`node`,
  `dotnet`, `java`, `python`, `vanilla`) and their `platform:` clauses (`vanilla`
  → `elixir { foundation: vanilla }`, the sole elixir foundation).
- `src/util/platform-axes.ts` — the realization-axes vocabulary
  (`PLATFORM_SAVING_SHAPES` etc.) some gates read from.

### Step 2 — For each feature axis, find the authoritative gate set + grep the emitters

This is where the matrix earns its credibility: **every cell cites a `loom.*`
code or a named gate set + file:line, never prose.** The pattern across the
codebase is a `const FOO_BACKENDS = new Set([...])` literal in
`src/ir/validate/checks/system-checks.ts` (and `structural-checks.ts`), wired into
`validateLoomModel` in `src/ir/validate/validate.ts`. To find the gate for an
axis:

```
# the gate sets themselves (the source of truth for each row)
rg -n "_BACKENDS|_CAPABLE|_FAMILIES|new Set\(\[" src/ir/validate/checks/system-checks.ts src/ir/validate/checks/structural-checks.ts
# how it's wired (which check fn runs)
rg -n "validate\w+Support|validate\w+Backend" src/ir/validate/validate.ts
# the loom.* diagnostic code the gate raises
rg -n "loom\.[a-z-]+unsupported|loom\.[a-z-]+" src/ir/validate/checks/system-checks.ts
```

Then, for each target the gate claims to support, **confirm the emitter actually
emits** — and for each target it *doesn't* gate, **confirm the emitter actually
errors** (not silently no-ops). That cross-check is the whole silent-vs-honest
test. The grep recipes and classification rules are in
`references/silent-vs-honest-gap.md`. The Method-notes block at the bottom of
`docs/audits/backend-feature-parity-2026-06.md` shows exactly how a 🔴 was
verified: grep the suspect generator for the IR field the feature populates
(`rg -rn contextFilters src/generator/python/` → zero hits) against the backends
that do consume it.

Frontends are gated at different layers — the validator surface
(`src/language/walker-stdlib.ts`), the `WalkerTarget` seam contract
(`src/generator/_walker/target.ts`), the primitive registry
(`src/generator/_walker/registry.ts`), and the pack required-set
(`src/generator/_packs/required-primitives.ts`). The frontend audit
(`docs/audits/frontend-parity-audit-2026-06.md` §Method) walks these four layers
in order; the classic frontend silent gap is a primitive the validator accepts
that's absent from a pack's `RequiredSet` and has no `templates.has` guard, so it
crashes codegen (the `Section`/`Sticky` finding).

### Step 3 — Generate a representative `.ddd` per axis and diff emit vs TODO vs reject

Don't author throwaway fixtures — **reuse the compile-tier corpus harness** (the
#1417 machinery). One canonical platform-agnostic `.ddd` per feature lives under
`test/fixtures/corpus/*.ddd` with a `platform: __PLATFORM__` token; the harness
swaps the token per backend:

- `test/fixtures/corpus/manifest.ts` — `CORPUS`: one row per feature, listing the
  backends it's *declared* to generate on (and a `note` for exclusions, e.g.
  `criterion-filter` excludes `java`).
- `test/fixtures/corpus/harness.ts` — `corpusSourceFor(featureId, backend)` swaps
  the token; `generateCorpusCase(featureId, backend)` runs the full
  lower→enrich→validate→compose pipeline in-memory (no docker) and returns the
  file map (or throws on a parse/validate error).
- `test/conformance/corpus-coverage.test.ts` — the gate that proves every declared
  cell generates and every `.ddd` has a manifest row.

To audit an axis, run `generateCorpusCase` (or `corpusSourceFor` + the CLI
`node bin/cli.js generate system <f.ddd> -o out`) for the feature across every
backend and bucket the outcome into exactly three:

1. **emits** — file map contains the real artifact (grep it for the expected
   construct, not just non-empty).
2. **validator-rejected** — throws a `loom.*-unsupported` → an HONEST gap, the gate
   is doing its job.
3. **silent** — generates a file map with the feature *missing* (or throws a raw
   `Error`/emits a `# TODO` mid-generation) → a 🔴 SILENT gap, a correctness bug.

If a feature has no corpus fixture yet, adding one is in-scope (drop the `.ddd` +
a manifest row — that's the documented "adding a feature = drop a `<feature>.ddd`
+ one row" path), but keep it platform-agnostic with the `__PLATFORM__` token so
every backend reuses it. For the heavier compile tiers, the same corpus feeds
`LOOM_TS_BUILD` / `LOOM_REACT_BUILD` / `LOOM_DOTNET_BUILD` etc. — a "compile-tier
skip-list drain" means walking those gated suites' skip annotations and re-checking
whether each skip is still warranted on fresh `main`.

### Step 4 — Produce or refresh the audit doc

Audits live under `docs/audits/` and follow a settled shape — match it rather than
inventing one. Read `docs/audits/backend-feature-parity-2026-06.md` (backends) or
`frontend-parity-audit-2026-06.md` (frontends) as the template. The non-negotiable
elements:

- A **snapshot date** and a one-line statement that the code wins when prose and
  code disagree.
- A **summary matrix**: feature rows × target columns, each cell one of
  `✓ / ✗ gated / ⚠ partial / 🔴 silent / N/A`, and a final **Gate (source of
  truth)** column citing the named set + `file:line`.
- **Findings** (`F1`, `F2`, …) — each 🔴 silent gap written up with the
  reproduction (the grep that proved zero emit, or the CLI repro that crashed), the
  impact in user terms, and the recommended fix (usually "add the target to the
  gate set" as the safe interim, or the principled emit).
- A **Method notes** block: which lines you read, the commit you read them at, and
  how each 🔴 was verified.

When *refreshing* an existing audit, re-derive every row from current lines and
**flip the cells that changed**, with a dated note saying what moved (the backend
audit's `[2026-06-20 audit]` blocks are the model). Mark a superseded older audit
as superseded; don't delete the history.

The précis register `docs/proposals/platform-parity-debt.md` is the
prioritisation roll-up that links each gap to its owning proposal — keep it in
sync with the audit, but the audit (code-verified) is authoritative when they
drift (its own header says so).

### Step 5 — Drain: hand each real gap to language-feature-developer

A confirmed gap is now a feature task. The #1467 pattern for fanning out: backend
gaps land in **disjoint file trees** (`src/generator/python/` vs
`src/generator/java/` vs `src/generator/elixir/` never collide), so spawn **one
`language-feature-developer` run per backend in a single turn**, each closing its
own bucket. That skill owns the implementation — feed it the gap, the cited gate,
and the sibling backend that already implements the feature (the analog to mirror).

Right-size by gap kind:
- **🔴 silent correctness gap** (the urgent ones) — often the *safe interim* is a
  one-line gate widening: add the target to the `FOO_BACKENDS` set so it fails
  fast instead of mis-emitting. That alone restores the parity invariant and can
  be done without a feature build; the principled emit is the follow-up. Call this
  out explicitly in the hand-off.
- **Honest gap** (target gated) — a straight `language-feature-developer` feature:
  audit the analog backend → port the emitter → narrow the gate as the target
  gains support → one generator test + that backend's build gate.
- **Frontend pack/primitive gap** — ship the missing `.hbs` + add the name to the
  pack `RequiredSet`/`TSX_ONLY_PRIMITIVES` so the load-time gate enforces it going
  forward (the `Section`/`Sticky` fix shape).

Keep the parity invariant front of mind in every hand-off: **a model that passes
validation must generate on its target, or fail validation — never crash codegen
and never silently downgrade.** Every gap you drain either makes a target emit the
feature or makes the validator reject it honestly; there is no third acceptable
state.

## Why this shape

The audit-then-drain split exists because the two halves have different failure
modes. The audit fails by **trusting stale prose** — so it's pinned to fresh-main
code with cited lines, and the silent-vs-honest distinction forces you to actually
read the emitter, not the doc. The drain fails by **building the wrong fix or a
duplicate** — so it hands off to `language-feature-developer`, which carries its
own state-audit and "already shipped?" gate. Keeping this skill out of the
implementation entirely is deliberate: an auditor that also patches is tempted to
rubber-stamp its own matrix. The matrix is the deliverable; the fixes belong to the
feature skill.
