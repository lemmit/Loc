# Runtime-semantics tier — follow-up backlog (claimable tickets)

**Created:** 2026-07-05. **Status:** open backlog, built for **parallel agents**.
**Parents:** [`conformance-semantics.md`](../conformance-semantics.md) (the RS-rule
contract) · [`a6.2-behavioral-tier-second-backend.md`](a6.2-behavioral-tier-second-backend.md)
(the Python tier) · [`full-review-remediation.md`](full-review-remediation.md) (A6.x).

## Context in one paragraph

The runtime-semantics tier gates the RS-rules (`conformance-semantics.md`) — the
wire *values* a booted backend actually sends/accepts, which the structural
OpenAPI parity diff is blind to. Three rules gate statically across all 5
backends (RS-2/3/5); five gate behaviorally on **node + Python** per-PR
(RS-1/4/6/7/8) via `test/behavioral/run.mjs` (Hono/PGlite in-process) and
`test/behavioral/run-python.mjs` (booted FastAPI on a `services: postgres`
sidecar, HTTP-dispatching the *same* emitted api e2e). **The Python tier has
already found two real cross-backend bugs** (a missing cross-aggregate id import,
a dropped bool create default) — each compiled green and passed structural
parity. Expect these tickets to find more; that is the point.

## How to claim (read before starting — parallel agents collide)

Per `CLAUDE.md`: **open a draft PR first** naming the ticket (`RST-N`) and the
files you'll touch, then `list_pull_requests` to check no one else has claimed
it. Re-sync on fresh `main` before and after each unit. Every ticket lists its
**collision surface** — if two open tickets touch the same file, coordinate or
stack.

## Independence / collision matrix

| Ticket | Touches | Safe to run in parallel with |
|---|---|---|
| RST-1 (RS-9 status assert) | grammar? + `test e2e` lower + `_frontend/e2e-harness.ts` + both runners | RST-2/3/4/5 (disjoint) — **not** RST-7/8 (share the fixtures) |
| RST-2 (.NET tier) | `run-dotnet.mjs` (new) + corpus + new workflow | everything (new files) |
| RST-3 (Java tier) | `run-java.mjs` (new) + corpus + new workflow | everything (new files) |
| RST-4 (make python required) | branch protection / CI meta | everything |
| RST-5 (semantics-spec artifact) | `src/system/` + `.loom` bundle | everything |
| RST-6 (python unit tier) | `run-python.mjs` (+ maybe a sibling) | RST-2/3/4/5 — coordinate with RST-1 if it edits run-python |
| RST-7 (multi-word RS-1) | `corpus-python/sales.ddd` | RST-2/3/4/5 — **not** RST-1/8 (share fixture) |
| RST-8 (broaden corpus) | `corpus-python.json` + new fixtures | RST-2/3/4/5 — **not** RST-1/7 (share corpus) |

RST-2 and RST-3 are the same shape on different backends — give them to two
agents; they only collide on this doc's status table.

---

## Tickets (ranked)

### RST-1 · Gate RS-9 (400/422 routing) — teach `test e2e` to assert HTTP status  ·  L
- **Why.** RS-9 (malformed body → 400, well-formed-but-invalid → 422) is the
  only behavioral rule with **no gate** — the `test e2e` DSL can express
  `expect(x).toThrow()` (throw/no-throw) but not the 400-vs-422 *status*, which
  is exactly RS-9's runtime content. Node's update-vs-create default divergence
  and the two Python bugs show error-path behavior is where drift hides.
- **Scope.** (a) Add a status-asserting form to the api `test e2e` surface —
  e.g. `expect(api.orders.create({bad})).toFailWith(422)` (or a `.status`
  accessor on the result). Thread it through: the `test e2e` lowering
  (`src/ir/lower/lower.ts` + `lower-types.ts`), the emitted api-suite builder
  (`src/generator/_frontend/e2e-harness.ts`), and the headless runner harness
  (`web/src/testing/run-api-tests.ts` — where the emitted `fetch`/dispatch
  result's status must be surfaceable rather than only thrown). (b) Add RS-9
  cases to `test/behavioral/corpus-python/sales.ddd` and a node corpus system: a
  create with a malformed body (→ 400) and one violating an invariant (→ 422).
- **Verify.** `behavioral-e2e` + `behavioral-e2e-python` green with the new
  assertion; RS-9 registry tier flips to `behavioral` with a gate note.
- **Use the `language-feature-developer` skill** — this walks grammar/IR/emitter
  and is exactly its shape. **Collision:** the e2e emitter + runners (see matrix).
- **DoD.** RS-9 asserted on node + Python; `semantics-rules.ts` RS-9 gate note
  added; `conformance-semantics.md` RS-9 tier updated.

### RST-2 · Add .NET as the 3rd behavioral backend  ·  L
- **Why.** Cross-backend parity is the contract's whole point; 2→3 backends
  widens the net to the .NET wire/EF path. Likely finds bugs (as Python did).
- **Scope.** `test/behavioral/run-dotnet.mjs` mirroring `run-python.mjs`: generate
  → boot the generated .NET backend → wait → HTTP-dispatch the emitted api e2e
  via the same `loadApiTests({dispatch})` seam. Lift the boot recipe from
  `.github/workflows/dotnet-obs-e2e.yml` / `test/e2e/observability-events-dotnet.test.ts`
  (needs the `mcr.microsoft.com/dotnet/sdk` container — heavier than Python; the
  runner sets the DB connection string env + `dotnet run`). A corpus (reuse
  `corpus-python/sales.ddd` retargeted, or a `corpus-dotnet/`) + a
  `behavioral-e2e-dotnet.yml` with a `services: postgres` sidecar.
- **Verify.** `behavioral-e2e-dotnet` green (or a documented, filed bug if it
  finds one — then fix on the same seam as #1681/#1684).
- **Note.** The runner's `dispatch` is already backend-agnostic (matched on
  pathname); only boot + DB wiring differ. **Collision:** none (new files).
- **DoD.** New runner + fixture + workflow; RS-1/4/6/7/8 tier notes add `dotnet`;
  scoping-note "v2" bullet ticked.

### RST-3 · Add Java as a behavioral backend  ·  L
- Sibling of RST-2 on Java. Boot recipe from `java-obs-e2e.yml` (JDK 21 + gradle
  `bootJar` → `java -jar`, host-runnable — no SDK container). Same seam, same
  DoD. Give to a *different* agent than RST-2; they don't collide.

### RST-4 · Make `behavioral-e2e-python` a required check  ·  S
- **Why.** It has 3 green runs (#1679/#1681/#1684); it's still non-blocking, so a
  regression could land on `main`. Make the gate teeth real.
- **Scope.** Either fold `behavioral-python` into the `tests-passed` rollup, or
  add it to branch protection's required checks. **Needs repo-admin action** — an
  agent should open a PR/issue documenting the intent and the exact check name if
  it can't change settings directly.
- **DoD.** `behavioral-e2e-python` required on PRs touching its path filter.

### RST-5 · Promote the RS registry to a diffable spec artifact  ·  M  ·  ✅ DONE
- **Why.** `conformance-semantics.md` roadmap v2: make a contract change a
  reviewable artifact diff, exactly as `wire-spec.json` does for wire shape.
- **Landed as a committed, diffable JSON mirror with a drift gate** (not a
  per-`.loom/` emit). The RS-rules are a **global toolchain contract**, not a
  per-generated-system fact, so emitting them into every system's `.loom/`
  bundle would be wrong — instead the mirror follows the `wire-spec.json` /
  `langium-generated` "derived file + CI drift gate" precedent:
  - `serializeSemanticsSpec()` in `test/conformance/semantics-rules.ts`
    deterministically serializes `SEMANTICS_RULES` (stable id order + fixed
    per-rule field order, `{ version, rules }` envelope, 2-space indent).
  - The committed mirror lives at `test/conformance/semantics-spec.json`.
  - `test/conformance/semantics-spec-sync.test.ts` fails on drift; regenerate
    with `UPDATE_SEMANTICS_SPEC=1 npx vitest run test/conformance/semantics-spec-sync.test.ts`.
  - Documented in `docs/conformance-semantics.md` (Roadmap v2 bullet).
- **Collision:** none — `test/conformance/` + docs only (`src/system/` untouched).

### RST-6 · Python **unit-tier** parity (generated pytest domain suite)  ·  M–L
- **Why.** `run-python.mjs` runs only the **api** tier; the generated pure-domain
  tests (the Python analogue of the node `unit` tier) don't run headless. That's
  domain-logic behavior (invariants, operations) unverified on Python per-PR.
- **Scope.** Extend `run-python.mjs` (or a sibling) to `uv run pytest` the
  generated domain test suite for a corpus case, gating on its result. Confirm
  the generator emits a runnable pytest domain suite first.
- **Collision:** `run-python.mjs` (coordinate with RST-1 if it also edits it).

### RST-7 · Harden RS-1 with a genuinely multi-word field  ·  S  ·  ✅ DONE
- **Landed:** `externalRef: string` on `Customer` in `corpus-python/sales.ddd`,
  created camelCase + asserted read-back (`expect(read.externalRef).toBe(…)`) —
  exercises the inbound snake-normalization path (`external_ref` persist ↔
  `externalRef` wire) explicitly on the Python behavioral tier.
- **Why.** #1620 (the RS-1 bug) was specifically a **multi-word** field
  (`commitSha`) whose inbound camelCase key wasn't snake-normalized — single-word
  fields hid it. The Python fixture currently leans on `customerId`/`placedAt`;
  add a clearly multi-word field (e.g. `externalRef: string` on an aggregate)
  created + read back to exercise the inbound-normalization path harder.
- **Scope.** `test/behavioral/corpus-python/sales.ddd` (+ the node corpus if you
  want symmetry). **Collision:** shares the fixture with RST-1/RST-8 — coordinate.

### RST-8 · Broaden the behavioral corpus (more domain shapes)  ·  M
- **Why.** Both bugs came from **one** fixture. More shapes = more coverage:
  aggregate inheritance (TPH), a `workflow`, `shape(document)`, `shape(embedded)`,
  event-sourced (`persistedAs(eventLog)`), a `retrieval` with a filter. Each new
  shape exercises a different emitter path likely to harbor a Python-parity bug.
- **Scope.** New `test/behavioral/corpus-python/*.ddd` fixtures + entries in
  `corpus-python.json`. Start with the shapes most divergent from plain CRUD.
- **Note.** Expect red first — that's a found bug; fix on the #1681/#1684 seam or
  file it. **Collision:** `corpus-python.json` (shares with RST-7).

---

## Suggested wave assignment (for a batch of agents)

- **Wave A (parallel, independent):** RST-2 (.NET), RST-3 (Java), RST-5
  (artifact), RST-4 (make-required). Four agents, zero shared files.
- **Wave B (after/with A):** RST-1 (RS-9 — the language-feature one, one agent,
  owns the e2e emitter + runners), RST-6 (unit tier).
- **Wave C (serialize — shared fixtures):** RST-7 then RST-8 (or one agent takes
  both), since they share `corpus-python/`.

When a ticket lands, tick it here and update the RS-rule's `tier`/`conforms` in
`test/conformance/semantics-rules.ts` + `docs/conformance-semantics.md` (the
registry is the source of truth — keep the three in lockstep).

## Landed

- **RST-5** (diffable spec artifact) — ✅ `test/conformance/semantics-spec.json`,
  a committed diffable mirror of `SEMANTICS_RULES` derived by
  `serializeSemanticsSpec()` and gated by `semantics-spec-sync.test.ts`
  (regenerate with `UPDATE_SEMANTICS_SPEC=1`). Scoped as a global-contract
  committed artifact, not a per-system `.loom/` emit.
- **RST-7** (multi-word RS-1) — ✅ `externalRef` on `Customer` in
  `corpus-python/sales.ddd`, created camelCase + read-back-asserted; hardens the
  RS-1 inbound normalization path on the Python behavioral tier.
