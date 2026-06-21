# Backend Feature-Parity Plan

**Status:** proposed · **Opened:** 2026-06-21 · **Audit:**
[`audits/backend-feature-parity-2026-06.md`](../audits/backend-feature-parity-2026-06.md)

A sequenced plan to bring the five domain-logic backends (node/Hono, .NET, Java/
Spring, Python/FastAPI, Phoenix·ash + Phoenix·vanilla) to **full feature parity**,
grounded in the validator gate sets that are the source of truth for what each
backend emits today.

## Definition of "full parity"

A feature is at parity when **every backend either emits it or fails fast** at
validate time — no backend is silently in a gate's blind spot (the F1 footgun),
and the supported set of each gate is closed deliberately rather than by accident.
Two legitimate end states per (feature × backend):

1. **Emitted** — the backend produces working code, verified by its `LOOM_*`
   build/e2e gate.
2. **Gated** — the validator rejects the combination with an actionable
   `loom.*` diagnostic (a reviewed decision, e.g. "no idiomatic Ash fit").

"Parity" does **not** require every backend to emit every feature — it requires
that the gap is *explicit and safe*. Elixir's foundation split (`ash`/`vanilla`)
is the canonical case: some features are reached by routing to `vanilla`, not by
forcing an un-idiomatic Ash emission.

## How this plan uses our custom skills

Each workstream below is a Loom pipeline change, so it runs through the
**`language-feature-developer`** skill (`.claude/skills/language-feature-developer/`),
right-sized per its "Tailoring to the feature kind" guidance:

| Workstream kind here | Skill right-sizing | Phases run |
|---|---|---|
| Flip a gate (turn a silent gap into a fail-fast error) | **Validate-only feature** | audit → IR-validate + negative test (skip simulator) |
| Port an emitter a sibling backend already has | **Codegen gap-fill** | audit → confirm analog → 1 developer + 1 generator test + build gate |
| Add cross-cutting runtime (provenance/audit) to a backend | **Codegen gap-fill** (disjoint buckets — one developer per backend, parallel) | audit → develop → test |
| Foundation routing vs new emission (elixir·ash) | **Full** — has a user-owned design fork | audit → review → **simulate + sign-off** → develop |

Skill mechanics to apply throughout:
- **Phase 1 state audit on fresh `main` first, every time** — `main` moves fast;
  several of these gaps may already be closing in flight. Spawn the
  `state-auditor` and check `list_pull_requests` before building.
- **Disjoint-bucket fan-out** — provenance/audit on Java and Python touch
  disjoint file trees (`src/generator/java/` vs `src/generator/python/`), so spawn
  one `feature-developer` per backend **in a single turn** (the gap-closure
  pattern).
- **Simulation gate only where there's a real shape decision** — the elixir·ash
  workstream (W4) has a genuine fork; run the `feature-simulator` and get user
  sign-off. The gate-flip and emitter-port workstreams skip it.
- **Final pass** — run `npm test` + the touched `LOOM_*` build gates, then the
  **`/code-review`** (or **`/simplify`**) skill over the diff, and **`/verify`**
  for a runtime spot-check on at least one backend. Report actual results.
- The Stop hook runs the Biome gate; `pipeline-layering.test.ts` guards the
  one-directional invariant — don't import upward to share a parity helper.

Per backend compile gates to run locally (see `CLAUDE.md` → Docker): Java
`gradle … bootJar` (host), .NET `dotnet build /warnaserror` (sdk container),
Python `uv sync + ruff + mypy + pytest` (host), Phoenix `mix compile
--warnings-as-errors` (elixir container, `LOOM_HEX_MIRROR=1`).

---

## Workstream W0 — Stop the bleeding: gate the F1 silent gap *(do first)*

**Gap:** Python is absent from `LIMITED_FAMILIES`
(`src/ir/validate/checks/system-checks.ts:1014`) yet the Python generator never
consumes `contextFilters` — a capability `filter` (tenancy / soft-delete) on a
python aggregate emits **no WHERE scoping, with no error**.

**Slice (validate-only, ~hours):** add `python` to `LIMITED_FAMILIES` so a filter
on a python aggregate raises `loom.context-filter-unsupported` until W1 lands the
real emission. This converts a correctness hole into a fail-fast — the repo's own
stated discipline ("a parsed-but-unemitted feature is a footgun").

**Skill:** validate-only. No simulator. Files: `system-checks.ts` + one negative
IR test (`test/ir/`). Gate: the existing `loom.context-filter-unsupported`.

**Decision (user-owned):** W0 is the safe interim; W1 is the real fix. If Python
capability filters are wanted *now*, skip straight to W1 and treat W0 as the
regression test.

---

## Workstream W1 — Capability filters: Python emission + non-relational completion

**Gaps:**
- Python emits no `contextFilters` at all (relational, principal, non-relational).
- Principal-referencing filter on a **non-relational** shape is gated on *every*
  backend (`system-checks.ts:1048` — "actor + json intersection isn't wired").
- Elixir wires non-relational filters on `embedded` only; `document` is
  vanilla-only future work.

**Slice:** port the predicate lowering Python already has for `where` finds
(`src/generator/python/find-predicate.ts`) into the repository root reads —
relational first (mirror node `repository-find-predicate.ts` / java `entity.ts` +
`render-sql-restriction.ts`), then the principal accessor (thread
`current_user` into the scoped `find_all`/`find_by_id`, the analog of .NET
`HasQueryFilter` / node `requireCurrentUser()`). Then remove `python` from the
gate (undo W0) for the cases now emitted. Non-relational + principal stays gated
across the board unless a separate decision opens it.

**Skill:** codegen gap-fill. Analog = node + java filter emission. Files:
`src/generator/python/{repository-builder,find-predicate,routes-builder}.ts`;
gate edit in `system-checks.ts`. Tests: 1 generator test (filtered read) + the
`LOOM_PYTHON_BUILD` gate; an `obs`/e2e read-scoping assertion if cheap.

---

## Workstream W2 — Provenance parity (Java, Python)

**Gap:** `PROVENANCE_BACKENDS = {node, dotnet}` + elixir·vanilla
(`system-checks.ts:1814`). Java and Python gate `provenanced` fields entirely.

**Slice (disjoint buckets — Java ∥ Python):** mirror the node/.NET shape — the
lineage SDK, a co-located `<field>_provenance` column in the shared
`MigrationsIR`, inline trace capture at each named-op write site, and a
`provenance_records` flush inside the save transaction, plus wire-DTO exposure of
current lineage. Then add `java`/`python` to `PROVENANCE_BACKENDS`.

**Skill:** codegen gap-fill, **two developers in one turn** (java tree vs python
tree are disjoint). Analog = `Domain/Common/ProvLineage.cs` (.NET) and
`domain/provenance.ts` (node); elixir·vanilla already ported it, so its
`src/generator/elixir/vanilla/` provenance emit is a second reference. Tests: 1
generator test each + each backend's build gate; a `ddd snapshot` round-trip if in
scope. Ref: `docs/provenance.md`, `type-system-feature-migration.md` DBT-1.

---

## Workstream W3 — Audit parity (audited ops + lifecycle)

**Gaps:**
- `AUDIT_OP_BACKENDS = {node, dotnet}` — per-operation `audited` not on java/
  python/elixir.
- `AUDIT_LIFECYCLE_BACKENDS = {node}` — `audited create`/`destroy` is node-only
  (the .NET create/destroy handlers aren't instrumented).

**Slice:** (a) extend per-op `audited` to java + python (append who/what/when +
before/after snapshot to the `audit_records` sink in the op's save transaction —
mirror node's audited route + .NET's `IAuditWriter` unit-of-work staging); (b)
instrument lifecycle create/destroy on dotnet first (closest analog already has
the op path), then java/python. Elixir audited ops likely vanilla-routed (W4
fork). Grow `AUDIT_OP_BACKENDS` / `AUDIT_LIFECYCLE_BACKENDS` as each lands.

**Skill:** codegen gap-fill. Note: `with audit` *stamping* (`contextStamps`) is a
separate, already-broad mechanism (all five reference it) — W3 is the per-op/
lifecycle `audited` flag only. A **runtime conformance** check of stamping depth
(principal-referencing stamp values, lifecycle hooks) is a good `/verify` task
rather than a static count.

---

## Workstream W4 — Elixir foundation gaps *(RESOLVED by routing — no Ash investment)*

**Status (2026-06):** ✅ resolved. The fork below was decided **(a) foundation
routing** and ratified as
[D-PHOENIX-FOUNDATION-ROUTING](../decisions.md) — the Ash-side investment is
out of scope. No compiler work was needed: every routed feature already emits
on `foundation: vanilla` and fails fast on `ash` on fresh `main` (the
"genuine emission gap" the original plan called out — **ES workflows on
vanilla** — had already shipped: `src/generator/elixir/vanilla/workflow-eventsourced-emit.ts`
+ `vanilla-eventsourced-workflow.ddd` under the `elixir-vanilla-build.yml`
gate). W4 landed as documentation: the *Phoenix foundations* routing table in
[`platforms.md`](../platforms.md), the `elixir·ash`/`vanilla` columns of the
[`generators.md`](../generators.md) matrix, and the decision record. The
historical fork analysis is kept below for context.

**Gaps (foundation-shaped):**
- ES aggregate storage gated on `ash` (`vanilla` emits it).
- `shape(document)` gated on `ash` (`vanilla` emits it).
- Provenance gated on `ash` (`vanilla` emits it).
- Return-dominant-only ops on `ash` (DEBT-03 — mutate-then-return / guarded
  bodies defer to vanilla).
- **ES *workflows* (saga appliers) gated on BOTH foundations**
  (`EVENT_SOURCING_WORKFLOW_BACKENDS` omits elixir, `system-checks.ts:1765`).

**The fork (decide before building — `AskUserQuestion` in skill Phase 2/3):**
Is "full parity" for these reached by **(a) foundation routing** — document the
contract as "use `foundation: vanilla` for ES/document/provenance on Phoenix," and
treat the ash gates as the deliberate, final answer — or **(b) Ash emission** —
invest in an Ash-idiomatic fit (AshEvents/AshCommanded for ES, an Ash `:map`
document, an Ash provenance extension)? The audit and prior decisions lean (a)
("no idiomatic Ash fit"); (b) is months of work per the ES note.

- **If (a):** W4 is mostly docs + one targeted slice: **ES workflows on
  `vanilla`** (a genuine emission gap — appliers + a per-aggregate stream saga
  instead of the state-based saga the emitters currently key off
  `correlationField` for). Add `elixir` to `EVENT_SOURCING_WORKFLOW_BACKENDS` for
  vanilla only.
- **If (b):** full skill run per feature with the simulator gate, since the Ash
  shape is novel.

**Skill:** full workflow — this is the one workstream with a real design decision;
run `state-auditor` → `feature-reviewer` → **`feature-simulator` + user sign-off**
before any compiler code. Ref: `proposals/workflow-and-applier.md`,
`elixir-eventsourcing-vanilla-plan.md`, `phoenix-tph-emission.md`.

---

## Workstream W5 — Parity guardrail + docs *(lands last, prevents regression)*

**Gap:** nothing structurally stops a new backend (or a new feature) from
silently falling out of a gate set the way Python did with `contextFilters` (F1).

**Slice:**
1. A **parity meta-test** (`test/platform/backend-parity-gates.test.ts`) that, for
   each capability-bearing IR field, asserts every backend listed in the gate set
   actually references the corresponding emitter symbol (the inverse of the F1
   grep, mechanized) — so "ungated + unemitted" can't recur.
2. Rewrite the `docs/generators.md` top-level matrix to five backend columns (the
   construct-by-construct table currently stops at TS/.NET/React).
3. Extend `conformance-parity.yml` to include python/java/elixir columns in the
   OpenAPI cross-check where they aren't already.

**Skill:** test-developer for (1); plain docs edit for (2)/(3). (1) is the highest-
leverage item — it makes the audit self-enforcing.

---

## Suggested order

```
W0 (gate F1, hours)
 └─ W1 (python filters)         ┐
W2 (provenance: java ∥ python)  ├─ independent, can run in parallel turns
W3 (audit ops + lifecycle)      ┘
W4 (elixir fork — decide first, then build)
W5 (guardrail + docs — after W1–W3 settle the gate sets)
```

W0 is immediate and unblocks nothing else — do it first to close the correctness
hole. W1–W3 are independent codegen-gap-fills (disjoint backend trees) and can be
fanned out. W4 needs the foundation-routing decision before any code. W5 lands
last so the meta-test reflects the final gate sets.

## Out of scope (not "backend parity")

Alternate persistence adapters (`dapper`/`mikroorm` minimal-v1, `marten`/`axon`/
`jooq` reserved stubs) and frontend page-DSL gaps (react/phoenix walker
limitations) — tracked separately in
[`audits/gated-features-inventory.md`](../audits/gated-features-inventory.md) §4/§8
and the realization-axes plans.
</content>
</invoke>
