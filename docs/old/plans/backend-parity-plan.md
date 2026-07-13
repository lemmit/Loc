# Backend Feature-Parity Plan

**Status:** proposed · **Opened:** 2026-06-21 · **Audit:**
[`audits/backend-feature-parity-2026-06.md`](../../audits/backend-feature-parity-2026-06.md)

> **Update (2026):** the Ash foundation has been **removed**. `platform: elixir`
> now generates Phoenix LiveView on **plain Ecto/Phoenix** (the vanilla foundation
> only); `foundation: vanilla` is the default and only valid value, and
> `foundation: ash` is a validation error (the `foundation:` knob stays). The
> "foundation routing vs Ash emission" fork below is therefore **moot** — there is
> no Ash backend to route around; every Phoenix feature targets vanilla. The
> ash-vs-vanilla framing is retained as the historical record of how parity was
> reached before Ash was deleted.

A sequenced plan to bring the five domain-logic backends (node/Hono, .NET, Java/
Spring, Python/FastAPI, Phoenix on plain Ecto/Phoenix) to **full feature parity**,
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
   `loom.*` diagnostic (a reviewed decision).

"Parity" does **not** require every backend to emit every feature — it requires
that the gap is *explicit and safe*. (Historically Elixir had a foundation split
`ash`/`vanilla` where some features were reached by routing to `vanilla` rather
than forcing an un-idiomatic Ash emission; with Ash removed, vanilla is the only
elixir foundation and there is nothing to route around.)

## How this plan uses our custom skills

Each workstream below is a Loom pipeline change, so it runs through the
**`language-feature-developer`** skill (`.claude/skills/language-feature-developer/`),
right-sized per its "Tailoring to the feature kind" guidance:

| Workstream kind here | Skill right-sizing | Phases run |
|---|---|---|
| Flip a gate (turn a silent gap into a fail-fast error) | **Validate-only feature** | audit → IR-validate + negative test (skip simulator) |
| Port an emitter a sibling backend already has | **Codegen gap-fill** | audit → confirm analog → 1 developer + 1 generator test + build gate |
| Add cross-cutting runtime (provenance/audit) to a backend | **Codegen gap-fill** (disjoint buckets — one developer per backend, parallel) | audit → develop → test |
| Phoenix (elixir) emission gap-fill | **Codegen gap-fill** (Ash removed — no foundation fork remains) | audit → confirm analog → develop → test |

Skill mechanics to apply throughout:
- **Phase 1 state audit on fresh `main` first, every time** — `main` moves fast;
  several of these gaps may already be closing in flight. Spawn the
  `state-auditor` and check `list_pull_requests` before building.
- **Disjoint-bucket fan-out** — provenance/audit on Java and Python touch
  disjoint file trees (`src/generator/java/` vs `src/generator/python/`), so spawn
  one `feature-developer` per backend **in a single turn** (the gap-closure
  pattern).
- **Simulation gate only where there's a real shape decision.** (W4's original
  ash-vs-vanilla fork is now moot — Ash is removed — so no simulator gate is
  needed there.) The gate-flip and emitter-port workstreams skip it.
- **Final pass** — run `npm test` + the touched `LOOM_*` build gates, then the
  **`/code-review`** (or **`/simplify`**) skill over the diff, and **`/verify`**
  for a runtime spot-check on at least one backend. Report actual results.
- The Stop hook runs the Biome gate; `pipeline-layering.test.ts` guards the
  one-directional invariant — don't import upward to share a parity helper.

Per backend compile gates to run locally (see `CLAUDE.md` → Docker): Java
`gradle … bootJar` (host), .NET `dotnet build /warnaserror` (sdk container),
Python `uv sync + ruff + mypy + pytest` (host), Phoenix (plain Ecto/Phoenix)
`mix compile --warnings-as-errors` (elixir container, `LOOM_HEX_MIRROR=1`).

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

## Workstream W4 — Elixir foundation gaps *(RESOLVED — Ash removed)*

**Status (2026):** ✅ resolved, and the foundation fork it described is now
**moot**: the Ash foundation has been **removed**. The features below were all
historically "gated on `ash`, emitted on `vanilla`"; with Ash gone, vanilla is the
only elixir foundation and every one of these emits on it. There is nothing to
route around — `foundation: ash` is now a validation error.

**Formerly foundation-shaped gaps (all now emit on the only elixir foundation):**
- ES aggregate storage — emits on plain Ecto/Phoenix.
- `shape(document)` — emits on plain Ecto/Phoenix.
- Provenance — emits on plain Ecto/Phoenix.
- Return-dominant ops (DEBT-03 — mutate-then-return / guarded bodies).
- ES *workflows* (saga appliers) — emits via
  `src/generator/elixir/vanilla/workflow-eventsourced-emit.ts` +
  `vanilla-eventsourced-workflow.ddd` under the `elixir-vanilla-build.yml` gate.

The original "(a) foundation routing vs (b) Ash emission" fork is **closed by
removal**: there is no Ash backend, so (b) is gone and (a) is simply "the elixir
backend." W4 lives on only as documentation of the final elixir feature set in
[`platforms.md`](../../platforms.md) and the [`generators.md`](../../generators.md)
matrix.

**Skill:** none remaining — no design decision left now that Ash is removed. Ref:
`elixir-eventsourcing-vanilla-plan.md`.

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
W4 (elixir — RESOLVED by Ash removal; docs only)
W5 (guardrail + docs — after W1–W3 settle the gate sets)
```

W0 is immediate and unblocks nothing else — do it first to close the correctness
hole. W1–W3 are independent codegen-gap-fills (disjoint backend trees) and can be
fanned out. W4 is resolved by the Ash removal (docs only). W5 lands last so the
meta-test reflects the final gate sets.

## Out of scope (not "backend parity")

Alternate persistence adapters (`dapper`/`mikroorm` minimal-v1, `marten`/`axon`/
`jooq` reserved stubs) and frontend page-DSL gaps (react/phoenix walker
limitations) — tracked separately in
[`audits/gated-features-inventory.md`](../../audits/gated-features-inventory.md) §4/§8
and the realization-axes plans.
</content>
</invoke>
