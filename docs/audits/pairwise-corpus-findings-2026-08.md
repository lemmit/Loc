# Pairwise-combination corpus — findings register (2026-08)

**Mission:** M-T9.29 slice 1.
**Harness:** `test/pairwise/` (composer, case selection, waiver registers), driven by
`test/e2e/pairwise-corpus*.test.ts`.
**Axes this slice:** capability × storage shape × authz × persistence adapter.
**Oracles this slice:** generation, node/`tsc` compile, `psql -f` schema-load.

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
| #2492 | `policy { deny }` × dapper → codegen crash (fixed 08-11 as M-T6.29) |

Every one is a two-factor interaction. That is the argument for an all-pairs cover rather
than more hand-written fixtures: a cover containing every pair finds every two-factor bug, in
25 cases instead of 200.

## How an outcome is classified

`test/pairwise/harness.ts` puts every crossing in exactly one bucket, and the classification
**is** the gate — conflating two of them is how a matrix like this becomes noise nobody reads.

| Verdict | Meaning | Gate |
|---|---|---|
| `ok` | parsed, validated (phases ①–⑦), generated | feeds the compile / schema-load oracles |
| `rejected` | a **named `loom.*` diagnostic** refused it | **legitimate.** "A pair that can't combine must be rejected by a validator, not crash codegen" — a coded rejection *is* the contract being honoured. Recorded, never failed. |
| `crashed` | the pipeline **threw**, or errored with no `loom.*` code | **finding.** Valid-looking source that takes the compiler down instead of answering. |

Two things had to be right for that split to mean anything, and both were wrong in the first
build of this harness:

- **The code is read off `Diagnostic.code`, not scraped from the message prose.** The code is
  a sibling *field*; scanning text would find one only when a message happens to quote it, and
  every honest rejection would have been miscounted as a crash.
- **Phase ⑦ has to actually run.** `validateLoomModel` is *not* part of the Langium document
  validation — the CLI and the api toolkit invoke it separately. The first build ran phases
  ①–④ only, and so called `tenancy by` on an auth-less deployable `ok` (the CLI refuses it by
  name) before handing uncompilable code to the compile leg. A discovery harness that runs
  **fewer phases than the product** reports bugs that do not exist and misses the ones that do.

## The ratchet

Findings are not suppressed, they are **registered** — `test/pairwise/waivers.ts`,
`waivers-tsc.ts`, `waivers-schema.ts`. The gate fails in **both** directions:

- a crossing that crashes with **no matching waiver** → new bug, gate red;
- a waiver that matched **nothing** → the bug is fixed, delete the entry in the same PR.

The second direction paid for itself immediately. An early entry recorded
`dapper × policy { allow … }` as a codegen crash; once phase ⑦ was wired in, that crossing
turned out to be refused by name (`loom.dapper-unsupported`), the waiver stopped matching, and
the gate reported it as stale. The finding was **withdrawn**, not shipped.

---

## Findings

| # | Crossing | Symptom | Status |
|---|---|---|---|
| **F1** | `shape: document` × `policy { allow … }` (node, java, python) | codegen **throws** an internal invariant | open — registered |
| **F2** | `mask unless` × `document` / `embedded` / `eventLog` (node, drizzle) | TS2339 `toWireMasked` does not exist | open — registered |
| **F3** | `mask unless` × `persistence: mikroorm` (all four repo variants) | TS2304 cannot find name `User` | **fixed in this PR** |
| **F4** | a field named `secret` after a modifier-less property | swallowed as that property's access modifier; syntax error on the *next* line | open — registered |
| **F5** | principal capability filter × `shape: document` × `mikroorm` | TS2304 cannot find name `currentUser` | open — registered |

F3 and F5 are the same shape one level apart: the MikroORM repositories were cloned from the
drizzle ones and each missed a different piece the original had. Neither is visible from a
single-feature fixture — `mask unless` has one, `persistence: mikroorm` has a matrix, and the
bug lives only where they meet.

### F1 — `shape: document` × `policy { allow … }` crashes codegen — **open**

**Class:** pipeline crash (internal invariant).
**Reaches:** node, java, python — every capability value, both node persistence adapters.
**Not** .NET/EF, **not** Elixir (Elixir refuses it honestly, via
`loom.context-filter-unsupported`).
**Crossings:** 20 of the 700 swept.

```
codegen threw: renderExprWith: 'authz-filter' must be handled by the backend's
query-filter translator, not the generic expression dispatcher
```

**Where:** `src/generator/_expr/target.ts` — the `authz-filter` arm is an *internal
invariant*: the node is meant to be intercepted by each backend's query-filter translator
before recursion reaches the generic dispatcher. On `shape: document` the document read path
renders the aggregate's `contextFilters` through the ordinary expression renderer, so the
ladder's sentinel arrives where it must never arrive.

**Why it is a finding, not an honest gap:** a tenant-owned document-shaped aggregate under a
`deep` read ladder is an ordinary thing to write, and three of five backends answer it by
blowing an internal assertion — the one outcome the contract rules out. Elixir shows the
correct shape of the answer for the same crossing: a named diagnostic that says the filter is
not wired for `shape: document` on that backend. If the ladder genuinely cannot be pushed into
a jsonb read on node/java/python, that must be a `loom.*` diagnostic, not a phase-⑧ throw.

**Registered in:** `test/pairwise/waivers.ts` (generation).
**Not fixed here:** one query-filter-translator arm (or one validator gate) per affected
backend — three emitters, with their own per-backend tests and compile gates. Outside a
harness slice's budget; the register entry is the handoff.

**Reproduce:**
```bash
LOOM_PAIRWISE=1 LOOM_PAIRWISE_DUMP=/tmp/pw npm run test:pairwise-corpus
node bin/cli.js generate system /tmp/pw/node-none-document-policyAllow-default.ddd -o /tmp/out
```

---

### F2 — `mask unless` × any non-relational saving shape does not compile (node/drizzle) — **open**

**Class:** uncompilable target code — the recorded class, on a crossing nothing built before.
**Reaches:** node + drizzle, `shape: document`, `shape: embedded`, `persistedAs: eventLog`,
every capability value.

```
http/thing.routes.ts(92,44): error TS2339: Property 'toWireMasked' does not exist
  on type 'ThingRepository'.
```

**Where:** the route builder calls `repo.toWireMasked(row, __maskUser)` unconditionally for a
masked aggregate (`src/platform/hono/v4/routes-builder.ts:238`), but only the **relational**
repository builder emits the method — `src/generator/typescript/repository-builder.ts:196`
gates it on `aggHasFieldMask(agg)`, while `repository-document-builder.ts`,
`repository-embedded-builder.ts` and `repository-eventsourced-builder.ts` import
`toWireMethod` alone and never mention the mask. Confirmed by hand on all three shapes:
the emitted repository contains **0** occurrences of `toWireMasked`, the emitted routes
contain **3**.

**Registered in:** `test/pairwise/waivers-tsc.ts`.
**Not fixed here:** emitting the method in three builders changes each repository's **port**
surface — `hono/v4/emit.ts` derives the port members *from the emitted source* — so it needs
its own per-shape tests plus the behavioral leg. An emitter change, not a harness change.

---

### F3 — `mask unless` × `persistence: mikroorm` does not compile — **FIXED in this PR**

**Class:** feature × adapter intersection (the #2387/#2391 shape).

```
db/repositories/thing-repository.ts(97,42): error TS2304: Cannot find name 'User'.
```

**Where:** all four MikroORM repository variants emit `toWireMaskedMethod(agg)` when the
aggregate carries a masked field (`src/generator/typescript/emit/mikroorm.ts`, four call
sites), and that method's signature is `toWireMasked(root: T, currentUser: User | null)` — so
the file *names* `User`. None of the four imported it: three had no `User` import at all, and
the event-sourced one gated its import on `findUsesCurrentUser` only. The relational drizzle
builder has always spelled the rule correctly
(`repository-builder.ts:141` — `… || aggHasFieldMask(agg)`); MikroORM was cloned from it
before the mask half existed and never picked it up.

**Fix:** one `maskUserImport(agg)` helper next to the four import blocks, and
`aggHasFieldMask(agg)` added to the event-sourced `repoUsesUser`. A helper rather than four
inline conditions so the next variant cannot forget it independently.

**Verified:** the emitted `thing-repository.ts` now carries
`import type { User } from "../../auth/user-types";`, and
`audited-embedded-mask-mikroorm` type-checks.

---

### F5 — a principal capability filter × `shape: document` × `persistence: mikroorm` does not compile — **open**

**Class:** feature × feature × adapter (three-factor), same family as F3 and in the same file.

```
db/repositories/thing-repository.ts(28,29): error TS2304: Cannot find name 'currentUser'.
```

**Where:** on `shape: document` the tenancy filter cannot be pushed into the query — the row is
one opaque jsonb blob — so it is evaluated **in-app** over the rehydrated record:

```ts
const rec = thingFromDoc(row.data as ThingDoc, row.version);
if (!((rec.tenantId === currentUser.tenantId))) return null;
```

That predicate needs `currentUser` bound. The **drizzle** document builder binds it —
`src/generator/typescript/repository-document-builder.ts:56`, `principalBind`, gated on
`aggregateUsesPrincipalContextFilter(agg)` — and imports `requireCurrentUser`. The **MikroORM**
document repository (`emit/mikroorm.ts`, `renderMikroDocumentRepository`) renders the same
predicate through the same shared `documentCapabilityBody()` helper and binds nothing, so
`currentUser` is a free name in every read.

**Confirmed by hand across the adapter × shape grid** — which is what pins the diagnosis to
*document*, not to mikroorm generally:

| | drizzle | mikroorm |
|---|---|---|
| relational | `requireCurrentUser().tenantId` inlined in the query ✅ | same ✅ |
| embedded | ✅ | ✅ (5 × `requireCurrentUser`) |
| **document** | `const currentUser = requireCurrentUser();` ✅ | **bare `currentUser`, no bind, no import** ❌ |

`shape: document` × `policy { deny }` × mikroorm is *not* affected: the deny sentinel renders
as an always-false constant and references no principal.

**Registered in:** `test/pairwise/waivers-tsc.ts`.
**Not fixed here:** unlike F3 (one import), this needs the bind emitted in each read method of
the mikro document repository — several method bodies in an emitter with no test at this
crossing. It belongs with F2 in one "document/embedded repositories are missing what the
relational one has" follow-up.

---

### F4 — a field named `secret` after a modifier-less property is swallowed as that property's access modifier — **open**

**Class:** grammar ambiguity / degenerate name (M-T9.22's tail; found incidentally while
writing F3's regression test).

`FieldAccess` (`src/language/ddd.langium:1744`) is `'immutable' | 'managed' | 'token' |
'internal' | 'secret'`, and the comment three lines above states the intent plainly: these are
admitted as property names "so pre-existing files that named a field `money` / `secret` / etc.
keep parsing". They do not, in one position. Because a property is `name ':' type (access)?`
and the grammar is newline-insensitive, a bare property followed by a property *named* one of
those five is parsed as `<prev>: <type> <access>` — and the next `:` is then a syntax error
pointing at the **wrong line**:

```ddd
aggregate Doc with crudish {
  title: string
  secret: string        // ← 7:15 error: Expecting token of type '}' but found ':'
}
```

Reorder the two and it parses cleanly (`secret` first, `title` second), as does
`amount: int = 0` followed by `secret: string` — a trailing `= default` terminates the
property and disambiguates. So the failure depends on the *preceding* field, which is why it
survives: any fixture that happens to put the field first, or after a defaulted field, never
sees it. The composer originally named its masked field `secret` and parsed fine for exactly
that reason (it follows `amount: int = 0`); it now uses `ssn`, so a harness failure is always
attributable to a crossing rather than to a name trap.

**Not fixed here:** a grammar change (`ddd.langium` + regenerate + printer round-trip), well
outside a harness slice. Worth pairing with M-T9.22, whose subject is exactly this shape of
bug.

---

## Recorded legitimate rejections (not findings)

117 of the 700 crossings are refused by a **named** diagnostic. They are what the contract asks
for, and they are counted here so the register shows what "honest" looks like beside the
findings.

| Code | Crossings | What it refuses |
|---|---|---|
| `loom.event-sourced-command-mutation` | 35 | `softDeletable` × `persistedAs: eventLog` — the `softDelete` macro's op assigns a field directly; an event-sourced aggregate may only `emit`. Fires identically on all five backends. |
| `loom.{node,dotnet,java,python,elixir}-stamp-unsupported` | 56 | a lifecycle stamp (`auditable`, `tenantOwned`) on an event-sourced aggregate — stamps mutate state, an event-sourced state is folded from the stream. |
| `loom.dapper-unsupported` | 14 | the hierarchical deep-scope sentinel under `persistence: dapper` (added by M-T6.29 alongside the #2492 fix). |
| `loom.context-filter-unsupported` | 13 | a capability filter on a `shape: document` aggregate on Elixir — the honest twin of F1. |
| `loom.vanilla-document-unsupported` | 5 | a non-scalar named operation on a `shape: document` aggregate on Elixir. |

## Observations (neither finding nor rejection)

- **MikroORM emits no `.sql` migration chain.** `persistence: mikroorm` ships
  `db/entities.ts` and lets MikroORM's schema generator produce DDL at boot, where `drizzle`
  emits `db/migrations/*.sql`. The schema-load oracle is therefore scoped to the raw-SQL
  adapter; running mikroorm cases through it would only assert that an adapter which emits no
  chain emits no chain. Its schema correctness is covered by `behavioral-e2e-mikroorm.yml`,
  which boots against a real Postgres.
- **An all-pairs cover cannot see a three-factor bug.** F2 also reproduces on
  `shape: embedded` × `mask` × **drizzle**, but the cover's (embedded, mask) cell happens to
  sit on **mikroorm**, where the symptom was F3 instead. The full cross product (which the
  generation oracle does run) is what makes the shape-level claim; the cover is a compile-cost
  sample, and this is the price it pays. Worth remembering before reading a green compile leg
  as "no interaction bugs here".

---

## Oracle results, this slice

| Oracle | Cases | Result |
|---|---|---|
| Generation — full cross product × 5 backends × reachable adapters | 700 | **563 ok, 117 rejected (9 distinct `loom.*` codes), 20 crashed** → F1 |
| Compile — node, strict `tsc`, all-pairs cover | 25 | F2 (2 cases), F5 (1 case) waived + registered; F3 (1 case) **fixed**; remainder clean |
| Schema-load — `psql -f` the emitted chain, all-pairs cover, drizzle | 25 | clean; `waivers-schema.ts` empty |

Counts come from `LOOM_PAIRWISE_REPORT=<file>`, which the generation oracle writes — a
register whose numbers are hand-tallied goes stale the first time the matrix changes.

## Follow-up slices

1. **Compile legs for dotnet / java / python / elixir.** Every recorded instance of this bug
   class lives there (#2412 was .NET CS0128 + Python F821 — node compiled it fine). Slice 1's
   node-only leg already found two; the waiver registers are in place for the rest.
2. **Widen the axes** — inheritance (TPH/TPC `extends`), unions / payload carriers,
   containment / part-in-part.
3. **Fix F1 and F2** — one emitter (or validator) change each, with their own gates.
