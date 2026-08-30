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
| **F1** | `shape: document` × `policy { allow … }` (node, java, python) | codegen **throws** an internal invariant | **fixed** — #2527, waiver deleted 2026-08-24 |
| **F2** | `mask unless` × `document` / `embedded` / `eventLog` (node, drizzle) | TS2339 `toWireMasked` does not exist | **fixed** — #2528, waiver deleted 2026-08-24 |
| **F3** | `mask unless` × `persistence: mikroorm` (all four repo variants) | TS2304 cannot find name `User` | **fixed** — in the slice-1 PR |
| **F4** | a field named `secret` after a modifier-less property | swallowed as that property's access modifier; syntax error on the *next* line | open — registered |
| **F5** | principal capability filter × `shape: document` × `mikroorm` | TS2304 cannot find name `currentUser` | **fixed** — #2528, waiver deleted 2026-08-24 |
| **F6** | `mask` × `document`/`embedded`/`eventLog` — **python** | `to_wire_masked` missing on the non-relational repo builders | **fixed** — this PR; was **F2's fix never leaving TypeScript** |
| **F7** | `audited` × `document`/`embedded` — **python** | `record_audit` / `history` are relational-only | **fixed** — this PR |
| **F8** | `versioned` × `eventLog` — **python** | `save()` takes no `expected_version` (mypy `call-arg`) | **fixed** — this PR (guard is stream-head, not row-version) |
| **F9** | `versioned` × `eventLog` × `deny` — **dotnet/EF** | CS0535: the event-sourced impl has no `GetByIdForWriteAsync` | **fixed** — this PR; was **#2527 f/u 2 fixing the DOCUMENT shape only** |
| **F10** | `versioned` × `eventLog` × `requires currentUser.…` — **elixir** | `undefined variable "current_user"` — the ES command emitter never grew the `current_user \\ nil` arg the relational and document paths take | **fixed** — this PR; found only after the log-truncation fix below |

> **Why F1/F2/F5 sat "open" for weeks after they were fixed.** #2527 and #2528
> landed the emitter fixes and did *not* delete the waivers — correctly, as far
> as anyone could tell, because **nothing re-ran this harness**. All three legs
> were gated behind `LOOM_PAIRWISE=1`, and no workflow set it: the corpus had no
> CI entry of any kind, not per-PR, not nightly, not `workflow_dispatch`. The
> stale-waiver ratchet these registers lean on fires only when the leg runs, so
> for three weeks it reported nothing while `main` was quietly red on four
> entries. `pairwise.yml` closes that; the four deletions here are what the first
> run found.

F3 and F5 are the same shape one level apart: the MikroORM repositories were cloned from the
drizzle ones and each missed a different piece the original had. Neither is visible from a
single-feature fixture — `mask unless` has one, `persistence: mikroorm` has a matrix, and the
bug lives only where they meet.

### F1 — `shape: document` × `policy { allow … }` crashes codegen — **fixed (#2527)**

> **Closed 2026-08-24.** `#2527` desugars the `authz-filter` sentinel to ordinary `ExprIR`
> for the in-app document path (`src/generator/_expr/authz-filter-inapp.ts`), so node/java/
> python render it through their existing expression renderer instead of blowing
> `renderExprWith`'s invariant. The generation waiver was deleted when `pairwise.yml`'s first
> run flagged it stale. Diagnosis below kept as the record.

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

### F2 — `mask unless` × any non-relational saving shape does not compile (node/drizzle) — **fixed (#2528)**

> **Closed 2026-08-24.** `#2528` emits `toWireMasked` from the document, embedded and
> event-sourced repository builders, not just the relational one. Waiver deleted on the first
> `pairwise.yml` run. Diagnosis below kept as the record.

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

### F5 — a principal capability filter × `shape: document` × `persistence: mikroorm` does not compile — **fixed (#2528)**

> **Closed 2026-08-24.** `#2528` binds `requireCurrentUser()` in the MikroORM document
> repository, as the drizzle one already did. Waiver deleted on the first `pairwise.yml` run.
> Diagnosis below kept as the record.

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

### Re-run on `main` @ `3a7199c7` (2026-08-24) — the first run since slice 1

The run that motivated `pairwise.yml`. Same three oracles, same cover, three weeks of `main`
later:

| Oracle | Cases | Result |
|---|---|---|
| Generation | 700 | **594 ok, 106 rejected (4 distinct `loom.*` codes), 0 crashed** — red only on the stale F1 waiver |
| Compile — node, strict `tsc` | 25 | **22 pass, 0 compile failures** — red only on the stale F2 (2 cases) + F5 (1 case) waivers |
| Schema-load | 25 | **green** |

Two things are worth reading off this, in opposite directions:

- **The intersection surface itself got better, not worse.** Crashes went 20 → 0 and the
  compile leg has no unwaived failure. The slice-1 findings were drained (#2527, #2528) and
  nothing new arrived in three weeks of a fast-moving `main`. The generation tier's remaining
  job is regression protection, not discovery.
- **Every red the re-run produced was a stale waiver, and staleness is exactly what a dark
  ratchet cannot report.** Four entries, all fixed weeks earlier. The register said "open" for
  all four; the emitters said otherwise. That gap is the cost of a gate with no workflow, and
  it is the argument for wiring the leg *before* widening it — a wider matrix behind the same
  dark switch would have produced more stale rows, not more caught bugs.

## The five-backend compile run (2026-08-24) — F6–F10, and the pattern behind them

Slice 1's compile oracle was node-only *by design* ("this slice's job is to prove the harness
earns them"). It has now earned them: `pairwise.yml` runs the same all-pairs cover through
each backend's real toolchain. The first run:

| Leg | Cases | Verdict |
|---|---|---|
| node | 25 | clean |
| **python** | 25 | **7 compile failures** → F6, F7, F8 · 0 rejected · 0 crashed |
| **dotnet** | 25 | **1 compile failure** → F9 · 4 rejected (named `loom.*`) · 0 crashed |
| java | 25 | clean (22 compiled, 3 rejected) — two independent full runs |
| **elixir** | 25 | **1 compile failure** → F10 · reported as "clean" for three runs because the leg truncated the log from the HEAD (below) |

### Two of these are findings this register already called CLOSED

That is the result worth carrying forward, and it is why every row above names its **target**:

- **F6 is F2.** #2528 fixed `toWireMasked` on the non-relational repository builders — and its
  diff touches `src/generator/typescript/` and nothing else. Node's document / embedded /
  event-sourced builders each emit the method; python's emit it **zero** times. The register
  said *fixed*.
- **F9 is #2527's follow-up 2.** That fix added `GetByIdForWriteAsync` to the **document**
  repository impl, and `src/generator/dotnet/emit/repository.ts:711` says so in its own comment
  — "the interface declares `GetByIdForWriteAsync` and the document impl had no
  implementation". The **event-sourced** impl was left without it. The register said *fixed*.

One partial along the TARGET axis, one along the SHAPE axis. Both were recorded closed, and
neither was reachable by anything that ran in CI. This is the same shape #2664 hit from the
contract side (three schemathesis findings closed on Hono alone), which makes it three
independent instances of one process defect: **a fix is marked closed when it lands on the
first target it was reported against.**

### The pattern: per-shape repository emitters drift

| Backend | Repository emission | Compile failures |
|---|---|---|
| java | ONE emitter, no per-shape split | **0** |
| node | 3 shape-specific builder FILES | 0 — *but only since #2528* |
| dotnet | 3 shape-specific impl FUNCTIONS in one file | 1 |
| python | 3 shape-specific builder FILES | 7 |

The backends that split repository emission per storage shape are exactly the backends that
drift. Every python failure is the same mechanism: `routes-builder.ts` calls a repository
method whenever a capability flag is set, with **no check on persistence shape**, and only the
relational builder implements it. So the finding is not "python forgot three methods" — it is
that **a per-shape split creates N places to implement every capability and nothing checks all
N**. Java, which cannot drift this way, passed the identical cover including all four crossings
python fails.

Java's clean result is also what proves the leg is honest: a leg that quietly dodged the hard
crossings would look exactly like a green one.

### Elixir — three false "clean" verdicts, two harness bugs, and F10

The verdict took four runs, and the first three were the harness's fault, not elixir's:

| Run | Result | Cause |
|---|---|---|
| 1 | 17 of 25 "failed" | hex.pm timeouts under concurrent load from sibling agents |
| 2 | all 21 remaining "failed" | a reaped `dockerd` |
| 3 | 17 of 25, 65min | same hex timeouts, uncontended — so NOT contention |
| **4** | **25 pass / 1 infra, 78min** | after the fix below |

Run 3 is the one that mattered: uncontended and still failing, which killed the contention
theory and forced a real diagnosis. **The leg mounted `~/.hex` — the PACKAGE cache — but not
`~/.mix/archives`, where `mix local.hex` installs the hex archive, and hex is not baked into
the `hexpm/elixir` image.** So all 25 `docker run --rm` cases re-downloaded the same archive
from builds.hex.pm, which throttles it. One fetch is fine; twenty-five are not — which is
exactly why a SINGLE case passed in 81s throughout. Mounting the archive dir and installing
`--if-missing` makes it one fetch per run; harness faults went 34 → 0.

Note what this says about the retry added alongside: **a bounded retry cannot beat a rate
limit**, and the logs show it spending `attempt 2 of 3` and `attempt 3 of 3` before failing
anyway. The retry is still correct for hex.pm's transient 500s (#2661's case) but it was
treating a symptom here.

**Run 4 was read as "zero real compile findings on elixir" — and that reading was wrong.**
It is recorded here rather than edited away, because the reason it was wrong is the more
useful finding. One case did report a compile failure, and its entire captured body was four
thousand characters of

```
Compiling 12 files (.ex)
Compiling 12 files (.ex)
…
```

cut off mid-word. Nothing in it named a file, a line, or an error, so it was filed as another
unclassified infra timeout — the same disposition the genuine `:timeout` case above got, which
made the misfiling look consistent.

**The cause was in the leg, not in elixir: every leg returned `` `${err.stdout}${err.stderr}`
.slice(0, 4000) ``, and a compiler prints its diagnostic LAST.** The slice kept the progress
noise and threw away the answer. Worse, the truncation happened BEFORE the text reached
`infraFailure`, so a signature at the tail could not match either — the classifier was being
handed a prefix and asked to recognise a suffix. `trimForMessage` now keeps a 600-character
head for command context and the TAIL, and marks the elision; the classifier sees the FULL
text. Both directions are pinned in `test/pairwise/compile-leg.test.ts`, including the
head-slice case that reproduces the miss.

With the tail visible the same case reported, immediately and unambiguously:

```
error: undefined variable "current_user"
 27 │  :ok <- ensure(current_user.role == "agent", {:forbidden, …}),
    └─ lib/d/main.ex:27:24: D.Main.bump_thing/2
```

That is **F10**, and it is a textbook instance of the class this corpus exists to find:
`versioned` × `eventLog` × `requires currentUser.…`. The relational command path
(`context-emit.ts`) and the document path both give a principal-reading command a
`current_user \\ nil` trailing argument; the event-sourced path was the one command emitter
that never grew it, so it rendered `current_user.role` into a `with` chain of a function that
never bound it. Fixed on both halves — the function head AND the controller's pass-through,
because emitting the parameter alone would compile and then deny every request at runtime on
`nil.role`, which is strictly worse than the compile error it replaces. Pinned by
`test/generator/elixir/es-command-principal.test.ts` (mutation-proved: reverting either half
fails four of its five assertions), and verified by a real container compile — `Generated d
app`, exit 0.

The wider lesson is about the instrument. Three runs in a row reported elixir clean while a
real emitter bug sat in the cover, and the two mechanisms that hid it are opposites of the
same mistake: a signature list only catches infra it has already seen (so an unmatched infra
failure becomes a FAKE finding), and a head-truncated log shows no diagnostic at all (so a REAL
finding becomes a fake infra fault). **This leg misclassified in both directions before it
reported anything true.** A green oracle is a claim about the oracle first.

Two corrections to the record, both mine: the earlier claim that "hex.pm is unreachable from
this sandbox" was **wrong** (the host gets HTTP 200 from both hex hosts and the mirror works —
every `repo.hex.pm` fetch returned 200 through it), and this section previously read
"UNVERIFIED". A HARNESS FAULT is a prompt to investigate, not a verdict to accept: "the
registry is down" and "your own daemon died" report identically and share no remedy.

**Cost, and what it implies for CI:** 78min for the full cover, uncontended, with a warm hex
archive — against a 60min cell budget sized from a single-case extrapolation that was wrong by
more than 2×. The budget is now 150min. The real fix is that `deps/` and `_build/` are not
shared across cases the way the node leg shares `node_modules`, so every case rebuilds the
whole dependency tree from source; hashing `mix.exs` and mounting both is the named follow-up.

Both of those failures also exposed a flaw in the harness itself: an infra failure was being
reported as a compile finding, which both manufactures fake findings and — on a waived case —
reads as "still broken", silently holding a waiver whose bug may already be fixed. The core now
classifies infra signatures as HARNESS FAULTS before the ratchet sees them
(`test/pairwise/compile-leg.ts`, gated both ways by its own test).

### Disposition

**All five are FIXED in the same PR that found them**, and the deciding argument was not
ambition but consistency: this PR drains four stale waivers in its first commit precisely
because *you cannot wire a gate into CI that lands red*, so shipping a compile matrix with 9
known failures and a register saying "waivers stay empty" would have contradicted itself. The
registers stay empty because there is nothing left to sign.

Sizes, since "separate PR" was first justified as scope discipline and that was wrong: F6 and
F9 were splices against templates already in the file (F9's sits twelve lines above the gap it
didn't fill), F7 was four rounds of import gates the relational builder already had, F10 was
one predicate call at three emission sites, and only F8 needed a genuine semantics decision.
None was large.

Post-fix cover: **python 26/26, dotnet's single failure closed, elixir's F10 closed, node /
java already clean** — so the matrix lands green.

---

## Follow-up slices

1. **Compile legs for dotnet / java / python / elixir.** Every recorded instance of this bug
   class lives there (#2412 was .NET CS0128 + Python F821 — node compiled it fine). Slice 1's
   node-only leg already found two; the waiver registers are in place for the rest.
2. **Widen the axes** — inheritance (TPH/TPC `extends`), unions / payload carriers,
   containment / part-in-part.
3. **Fix F1 and F2** — one emitter (or validator) change each, with their own gates.
