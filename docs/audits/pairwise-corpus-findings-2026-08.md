# Pairwise-combination corpus — findings register (2026-08)

**Mission:** M-T9.29 slice 1 — [`docs/new-plan/T9-toolchain-health.md`](../new-plan/T9-toolchain-health.md).
**Harness:** `test/pairwise/` (composer + case selection + waiver registers), driven by
`test/e2e/pairwise-corpus*.test.ts`.
**Scope of this slice:** capabilities × persistence-shape × authz × persistence-adapter,
through three cheap oracles — generation, node/`tsc` compile, and `psql -f` schema-load.

---

## Why this register exists

The curated corpus (`test/fixtures/corpus/`) is **one fixture per feature** by design. The
recurring "generated code fails to compile" bug class does not live inside a feature — it
lives at the **intersections** no single-feature fixture crosses:

| Bug | Crossing |
|---|---|
| #2412 | `mask unless` × `audited` → .NET CS0128 + Python F821 |
| #2387 | `audited` × dapper × `shape: document` |
| #2391 | `audited` × dapper × `persistedAs: eventLog` |
| #2321 | `versioned` × a declared column of the same name → DDL Postgres refuses (G2) |
| #2451 | `deny` — nothing built it at all → Python import bug |
| #2492 | `policy { deny }` × dapper → **codegen crash** (fixed 08-11 as M-T6.29) |

Every one is a two-factor interaction. That is the argument for an all-pairs cover rather
than more hand-written fixtures: a cover containing every pair finds every two-factor bug,
and it does so in ~25 cases instead of 200.

## How an outcome is classified

The harness (`test/pairwise/harness.ts`) puts every crossing in exactly one bucket, and the
classification **is** the gate — conflating two of them is how a matrix like this turns into
noise nobody reads.

| Verdict | Meaning | Gate |
|---|---|---|
| `ok` | parsed, validated, generated | feeds the compile / schema-load oracles |
| `rejected` | a **named `loom.*` diagnostic** refused it | **legitimate.** "A pair that can't combine must be rejected by a validator, not crash codegen" — a coded rejection *is* the contract being honoured. Recorded, never failed. |
| `crashed` | the pipeline **threw**, or errored with no `loom.*` code at all | **finding.** Valid-looking source that takes the compiler down instead of answering. |

The `loom.*` code is read off `Diagnostic.code`, not scraped out of the message prose — the
code is a sibling *field* of the message, so scanning the text would find one only when a
message happens to quote it, and every honest rejection would be miscounted as a crash.

## The ratchet

Findings are not suppressed, they are **registered**, in `test/pairwise/waivers.ts`
(+ `waivers-tsc.ts`, `waivers-schema.ts`). The gate fails in **both** directions:

- a crossing that crashes with **no matching waiver** → new bug, gate red;
- a waiver that matched **nothing** in the run → the bug is fixed, so delete the entry in the
  same PR, gate red until you do.

That second direction is what makes this a register rather than a suppression list.

---

## Findings

### F1 — `shape: document` × `policy { allow … }` crashes codegen — **open**

**Class:** pipeline crash (internal invariant).
**Reaches:** node, java, python — on **every** capability value, and on both node persistence
adapters. **Not** .NET/EF, **not** Elixir (their document read path does not route the filter
through the generic dispatcher).
**Crossings affected:** 5 capabilities × 3 backends × persistence = 20 of the swept crossings.

```
codegen threw: renderExprWith: 'authz-filter' must be handled by the backend's
query-filter translator, not the generic expression dispatcher
```

**Where:** `src/generator/_expr/target.ts` — `renderExprWith`'s `authz-filter` arm is an
*internal invariant*: the node is supposed to be intercepted by each backend's query-filter
translator before recursion ever reaches the generic dispatcher. On `shape: document` the
document read path renders the aggregate's `contextFilters` through the ordinary expression
renderer, so the policy ladder's `authz-filter` sentinel arrives where it must never arrive.

**Why it is a finding and not an honest gap:** the combination is not obviously impossible —
a tenant-owned document-shaped aggregate under a `deep` read ladder is an ordinary thing to
write, and three of five backends refuse it by *throwing an internal assertion*, which is the
one outcome the mission's contract rules out. If the ladder genuinely cannot be pushed into a
jsonb read, that must be a `loom.*` diagnostic naming the limitation (the way
`loom.dapper-unsupported#deep-scope` does for Dapper), not an invariant blowing up in phase ⑧.

**Not fixed here.** The fix is one query-filter-translator arm per affected backend (three
emitters), which is a language/emitter change with its own per-backend tests and compile
gates — outside the "at most 1–2 trivial bugs" budget of a harness slice, and the register
entry is the handoff.

**Reproduce:**
```bash
LOOM_PAIRWISE=1 LOOM_PAIRWISE_DUMP=/tmp/pw npx vitest run test/e2e/pairwise-corpus.test.ts
# then: node bin/cli.js generate system /tmp/pw/node-none-document-policyAllow-default.ddd -o /tmp/out
```

---

### F2 — `persistence: dapper` × `policy { allow … }` throws out of codegen — **open**

**Class:** unsupported combination delivered through the wrong channel (a codegen exception
where a `loom.*` diagnostic belongs).
**Reaches:** .NET + dapper, every capability, `relational` and `embedded` shapes.

```
codegen threw: dapper: capability filter on 'Thing' is outside the Dapper SQL subset;
use 'persistence: efcore' or simplify the predicate.
```

**Where:** `src/generator/dotnet/emit/dapper.ts` — `whereToSql`'s `default:` arm. The message
is user-facing and the advice is correct, so the *intent* is honest; the **channel** is not.
Phase ⑧ throwing means `ddd parse` reports the system as valid and the failure only appears at
generate time, with no code, no source span, and no entry in the diagnostic catalog.

**This is the live tail of #2492.** That bug was `policy { deny }` × dapper, fixed on 08-11 as
M-T6.29 by giving `whereToSql` an `authz-filter` case that dispatches to `authzFilterToSql`.
That fix covered the **deny** sentinel; the **allow ladder** rungs still fall through to
`default:`. The same commit *did* add `loom.dapper-unsupported#deep-scope` for the
hierarchical deep-scope sentinel — which is exactly the shape the fix wants here, so the
remedy is a known one: extend `validateDapperSupport` to cover the remaining ladder rungs, or
render them, rather than throwing.

**Not fixed here** for the same reason as F1 — it is a .NET-emitter/validator change with its
own dapper compile gate, not a harness change.

---

## Recorded legitimate rejections (not findings)

These crossings are refused by a **named** diagnostic. They are what the contract asks for, and
they are listed so the register shows what "honest" looks like next to the two findings.

| Crossing | Code | Note |
|---|---|---|
| `softDeletable` × `persistedAs: eventLog` (all backends, all authz values) | `loom.event-sourced-command-mutation` | The `softDelete` macro's op assigns a field directly; an event-sourced aggregate may only `emit`. Correctly named, correctly located, and it fires identically on all five backends. |

## Observations (neither finding nor rejection)

- **MikroORM emits no `.sql` migration chain.** `persistence: mikroorm` ships `db/entities.ts`
  and lets MikroORM's own schema generator produce DDL at boot, where `drizzle` emits
  `db/migrations/*.sql`. The schema-load oracle is therefore scoped to the raw-SQL adapter;
  running mikroorm cases through it would only assert that an adapter which emits no chain
  emits no chain. MikroORM's schema correctness is covered by its behavioral leg
  (`behavioral-e2e-mikroorm.yml`), which boots against a real Postgres.

---

## Oracle results, this slice

| Oracle | Cases | Result |
|---|---|---|
| Generation (full cross product × 5 backends × reachable adapters) | 700 | 2 findings (F1, F2), 30 legitimate rejections, remainder `ok` |
| Compile — node, strict `tsc` (all-pairs cover) | 25 | clean; `waivers-tsc.ts` empty |
| Schema-load — `psql -f` the emitted chain (all-pairs cover, drizzle) | 25 | clean; `waivers-schema.ts` empty |

The compile and schema-load legs finding nothing on **node** is the expected shape, not a
disappointment: every recorded instance of this bug class was on .NET, Python or the Dapper
adapter (#2412 was .NET CS0128 + Python F821 — node compiled it fine). Slice 1's job was to
build the harness and prove it bites; the follow-up slice that adds the dotnet / java /
python / elixir compile legs is where those legs are expected to pay, and the waiver registers
are already in place for them.

## Follow-up slices

1. **Compile legs for dotnet / java / python / elixir** — the same all-pairs cover through each
   backend's real compiler (the recorded instances of the class all live there).
2. **Widen the axes** — inheritance (TPH/TPC `extends`), unions / payload carriers,
   containment / part-in-part, as M-T9.29's mission body lists.
3. **Fix F1 and F2** — one emitter/validator change each, with their own gates.
