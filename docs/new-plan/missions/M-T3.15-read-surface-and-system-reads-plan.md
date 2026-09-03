# M-T3.15 — The read surface: system reads, projection masking, and the find teardown

> **STATUS: PLAN — awaiting sign-off on the sequencing.** Every fact in the tables
> below was code-verified against `main` @ `1f917ac` (2026-08-05) by generating
> fixtures and reading the emitters, not from memory. Re-verify before
> implementing; this repo's statuses rot. Items marked *(judgement)* are my
> ordering opinion, not a measurement.
>
> Grew out of the `requires`-placement work ([#2443](https://github.com/lemmit/Loc/pull/2443),
> M-T3.2 item 3): once the gate stopped living in the domain entity, the question
> "so what secures the READS?" had no coherent answer.
>
> **Landed since (#2523):** the gate moved to the projection declaration header;
> folded projections gained an ENFORCED gate on both read-model routes across all
> five backends (`loom.projection-gate-without-source` deleted); the list read's
> gate (`find all(): T[] requires …`) now enforces on java/python/elixir too
> (**D5**); and `validateDefaultDeny` enumerates both projection kinds. The
> "ungated, and ungateable" read in root cause A is gone, and B0's two amplifiers
> with it — B0's launder itself is still open.

---

## 0. TL;DR

Four root causes. Everything else in this doc is a symptom of one of them.

- **A — Loom has no construct for SYSTEM READS.** Every read that isn't aggregate
  CRUD is hand-rolled: its own route shape, its own gate story (or none), its own
  default-deny status. There are FOUR of them today and they have four
  different answers. (One used to be "ungated, and ungateable" — the folded
  projection; #2523 fixed that one, leaving workflow instances as the ungated
  member.)
- **B — the two read surfaces cannot compose, and the mask is launderable.**
  Gated projections and `mask unless` are mutually exclusive by validator
  (`loom.field-mask-projection-source`), and the diagnostic's own remedy points
  authors back at the *ungated* CRUD routes. Worse, **§B0**: a masked value can be
  `emit`ted into an event, folded into a materialized projection, and served in
  cleartext — verified end-to-end. That route can be gated now (#2523), but the
  projection's gate is a different predicate from the field's `mask unless`, so
  the launder is unfixed.
- **C — the generated default is the unsecured surface.** The scaffold binds
  `.all`, not a projection, so the no-code path lands on reads `denyByDefault`
  cannot see.
- **D — gate placement + the find teardown.** Placement is done; the teardown has
  a prerequisite that would otherwise delete the audit-history gate as collateral.

**Two items carry the load: B1 (masking in projections) and A1 (a system-read
construct).** B1 unblocks the read-surface story; A1 turns three bespoke answers
into one. **A2 and E1 are small, security-relevant, and independent of both** —
they can land immediately.

---

## 1. Root cause A — system reads are an unnamed class

`GET /<agg>/{id}/history` is not a special case. It is the first *named* member of
a class with no construct behind it:

| compiler-owned read | route | gate today | seen by `denyByDefault` |
|---|---|---|---|
| audit history | `/<agg>/{id}/history` | **borrowed** from `find all`'s `requires` (`enrich/enrichments.ts` `ensureHistoryFind`) | yes (`loom.audit-history-ungated`) |
| workflow instances | `/workflows/<wf>/instances`, `/instances/{id}` | header `requires` on the `workflow` declaration, enforced on both routes, all five backends | **yes** — ✅ CLOSED (#2570) |
| provenance | — | n/a | n/a — write substrate only, **no read endpoint exists** |
| query-time projections | `/projections/<name>` | first-class `requires` | **yes** — ✅ CLOSED (#2523) |
| materialized projections | `/projections/<name>`, `/<name>/{key}` | first-class `requires`, enforced on both routes, all five backends | **yes** — ✅ CLOSED (#2523) |

Four reads, four different answers. Provenance is
exactly where audit was before #2378: a table nothing can read. It will hit this
same question the moment it gets a route — which is the tell that the answer
should be a construct, not a fourth one-off.

### A1 — introduce a first-class system-read construct
Covers audit history, workflow instances, and provenance behind one surface: one
gate, one masking hook, one entry in `validateDefaultDeny`. This is the item that
makes A2/A3 and the D2 repoint cheap instead of repetitive. **Size: L.**

### ~~A2 — gate workflow-instance reads~~ — ✅ **DONE (#2570)**
`GET /workflows/<wf>/instances` exposed correlation state, command params, and
saga progress to any authenticated caller, and `validateDefaultDeny` did not
enumerate it.

It was not merely ungated but **ungateable** — the routes are compiler-derived
and a workflow had no author surface to declare a read gate on, the identical
situation the folded projection was in before #2523. Fixed by giving the
`workflow` declaration a header `requires` clause, in the position every other
gate in the language uses:

    workflow Fulfilment requires currentUser.role == "supervisor" { … }

It gates the READS only; command entries keep their body gates, since the two
audiences are independent. `currentUser`-only
(`loom.workflow-gate-not-current-user`) because the gate runs before any
instance is loaded. Enforced on all five backends, on both routes, ahead of the
store read; `denyByDefault` now demands it, the exemption's stated reason
("compiler-synthesized, no author source line") having evaporated with the new
surface.

Considered and rejected: a dedicated `instances requires …` member (a new
keyword for a case the header covers), and deriving the read gate from the
command gates the way `ensureHistoryFind` copies `find all`'s (free for existing
systems, but "who may start" ≠ "who may read", and a workflow with several
command entries has no single gate to inherit).

**Follow-on, done:** the SCAFFOLD did not inherit that gate — it emitted an
ungated page over the now-guarded route, so the client fired the read and ate
the 403. Closed by [#2581](https://github.com/lemmit/Loc/pull/2581) (a
`requires` option on the `page()` macro factory — the grammar had `RequiresProp`
all along). The nav-link half is **not** closed: see **C3**.

### A3 — give provenance a read endpoint, *through* A1
Not as another bespoke route. **Size: M**, blocked on A1.

---

## 2. Root cause B — the two read surfaces cannot compose

`loom.field-mask-projection-source` (`ir/validate/checks/system-checks.ts`) is a
**hard error** when a projection sources `from` an aggregate carrying a
`mask unless` field. Its message:

> …query-time projection responses are not yet read-masked, so this would expose
> the masked field. **Read the aggregate through its own routes, or drop the mask.**

So today the choice is: gated projection **or** field redaction, never both — and
the diagnostic's own remedy is the ungated CRUD surface.

### B0 — the mask is launderable through an event into a materialized projection
**Verified end-to-end on node, 2026-08-05.** This `.ddd` validates with ZERO
diagnostics and serves the masked value in cleartext on an ungated route:

```ddd
aggregate Employee with crudish {
  salary: decimal mask unless currentUser.role == "admin"
  operation bump() { salary := salary + 1.0
                     emit SalaryChanged { employeeId: id, amount: salary } }   // ← unchecked
}
projection SalaryIndex keyed by employeeId {          // materialized (folded)
  employeeId: Employee id
  amount: decimal
  on (e: SalaryChanged) by e.employeeId { amount := e.amount }
}
```
```ts
// http/projections.ts — no gate, no principal, no mask
app.openapi(createRoute({ method: "get", path: "/salary_index", … }),
  async (httpCtx) => {
    const rows = await db.select().from(schema.salaryIndexes);
    return httpCtx.json(rows as …, 200);
  });
```

`maskUnless` exists in exactly three places — per-backend wire serialization,
audit-history diffing, and the `loom.field-mask-*` validators. **There is no
check on `emit`, none on a projection fold, and no mask marker on a projection
state field**: the mask is a property of the aggregate's *wire projection*, not a
taint on the value.

Two compounding facts made this strictly worse than a mask bug. **Both are now
fixed (#2523)**, which does not close B0 but removes its amplifiers:
- ~~**A materialized projection cannot be gated at all.**~~ **FIXED.** The gate
  moved to the projection declaration header, all five backends emit it on both
  read-model routes, and `loom.projection-gate-without-source` is deleted.
- ~~**`validateDefaultDeny` does not enumerate projections at all.**~~ **FIXED.**
  Both projection kinds are enumerated; an ungated one under `denyByDefault` is
  `loom.default-deny-ungated`.

What remains of B0 is the launder itself: a masked value can still reach a
projection row through `emit`, and the projection's own gate is a *different*
predicate from the field's `mask unless`. Fixing that is a design fork, not a
patch — the candidates are (a) reject `emit <Event>(f: this.<maskedField>)` as
the narrowest honest gate, or (b) propagate a taint onto projection state
fields. **(a) is far smaller** and catches it at the single entry point, but it
forbids a legal-looking `emit`, so it wants sign-off.

### ~~B2 — SQL-pushdown aggregation leak~~ — **RETRACTED, not real**
I recorded this as a live leak; it is not. The `from`/`join` rule fires on the
SOURCE, before the projection's arm is chosen, so it dominates the grouped,
whole-table, per-row and shorthand arms alike. Grouped additionally forbids
non-aggregate sources and joins outright (`loom.projection-groupby-source-unsupported`,
`loom.projection-groupby-join-unsupported`). The pushdown is unreachable through
an aggregate source; the only way in is the B0 launder, and there the *cleartext*
read is the severe consequence, not the aggregation.

Worth keeping from the analysis, for whenever the `from`/`join` rule is relaxed
into real per-field redaction: the discriminant is **where** the masked column
appears, not which aggregation reads it. `count` cannot name a column (its `arg`
is absent by construction) — but a masked column used as a `group by` KEY is
returned verbatim as a response value, and one used in `where` is a decision
oracle. Both leak with `count` alone.

### B1 — teach projections field masking, or explicitly retire `mask unless`
**The unblocker.** Until this lands, "projections are the read surface" is false
for any aggregate with a redacted field, and C1/C2/D3/D4 all stall behind it.

This is a genuine fork, not a gap: `mask unless` shipped on all five backends
recently (M-T3.2 item 6), so retiring it must be a decision rather than attrition.
**Size: L** (five backends × the projection response path). *(judgement: masking
should win — it is a data-protection primitive, and projections are the surface
that should adopt it, not the one that gets to opt out.)*

---

## 3. Root cause C — the generated default is the unsecured surface

### C1 — move the scaffold's reads onto projections
M-T1.3 made projection-backed reads *possible*; the scaffold still binds `.all`.
Until this flips, the **no-code path — the one that most needs a safe default —
lands on reads `denyByDefault` cannot see.** **Size: M**, wants B1 first.

### C2 — decide what the synthesized CRUD reads are FOR once projections carry real reads
*(judgement)* Probably: list and by-id stop being public. That closes the by-id
hole **by subtraction rather than by adding a gate**, and it removes a surface
instead of securing one. Also makes E2 moot. **Size: M, breaking.**

### C3 — the generated nav shows links to routes the backend refuses
The scaffolded PAGES now inherit the gate their route is guarded by
([#2581](https://github.com/lemmit/Loc/pull/2581)) — the workflow header gate
onto both instance pages, the `find all` gate onto the aggregate List page — so
the client renders `Forbidden` instead of firing a read that 403s. The **nav
link is still ungated**, and it is a *different* defect from the one #2581
fixed:

`prepareAppShellVM` (`src/generator/react/templating/preparers/app-shell.ts`)
builds the default sidebar from `aggregates`/`workflows` and **receives no
`PageIR[]` at all**, so no page's `requires` can reach it. Its own comment
states the assumption #2581 invalidated: *"The default hardcoded sidebar entries
(aggregates/workflows) are scaffold pages with no `requires`, so they never
carry `requiresJs` and stay ungated; only the `sidebarOverride` (menu-derived)
entries can be gated."*

So today, under `auth: ui`:

- ✅ the page guards itself
- ✅ an explicit `menu { … }` block's links hide correctly — `navEntryForLink`
  (`_frontend/menu-emitter.ts`) already reads `page.requires`
- ❌ the **default** sidebar shows the aggregate List entry to a principal the
  backend will refuse

**Not scaffold-specific:** a hand-written `page X { requires … }` has the same
problem unless its author also writes a `menu { … }` block. **Size: M** — thread
pages into `prepareAppShellVM` and its five sibling frontend preparers (a
six-frontend signature change), then gate the derived entries the way
`navEntryForLink` already does.

NB the workflow-instance pages have **no** default nav entry at all — the
hardcoded sidebar ignores page `menu:` metadata and lists aggregates plus
workflow *command* pages only, so the visible-and-refused link is the aggregate
List one.

---

---

## 4. Root cause D — gate placement and the find teardown

### D1 — `requires` out of the domain entity — **DONE** ([#2443](https://github.com/lemmit/Loc/pull/2443))

### D2 — repoint the audit-history gate BEFORE deleting find `requires`
**Hard prerequisite, not a nicety.** `ensureHistoryFind` copies `find all`'s
`requires` (`enrichments.ts`), and `loom.audit-history-ungated` fires on
`repo.historyFind && !repo.historyFind.requires` with a message that instructs the
author to *"Declare `find all(): T[] requires <expr>`; history inherits that gate."*

Delete `requires` from `FindDecl` first and `historyFind.requires` becomes
permanently `undefined`: under `denyByDefault` every `audited` aggregate trips a
diagnostic **that cannot be satisfied**, because it tells you to write syntax that
no longer parses. A1 is the natural new home.

### D3 — stop emitting routes for named finds
A named `find` is a public `GET /<snake_find>` on all five backends
(`docs/generators.md` 228 / 368 / 1034), contradicting the read-path design record
(`docs/old/proposals/read-path-architecture.md`: finds are the internal repository
query port). **Breaking; needs sign-off.**

### D4 — delete `requires` from `FindDecl`
86 named finds across corpus/examples/journey, **0** of them gated — so zero
fixture churn once D3 lands.

### ~~D5 — interim risk while D3/D4 are pending~~ — ✅ **FIXED (#2523)**
`find all(): T[] requires <expr>` was **enforced on node and .NET, silently
dropped on Java, Python, and Elixir.** Node and .NET emit a route per repository
find, so `all` was just another entry and picked the gate up for free. The other
three each special-case `all` OUT of their named-find loop — the list endpoint
has a bespoke shape (paging controls, the `<Agg>Paged` envelope, Phoenix's
`index`) — and each then emitted that bespoke route without ever reading the
find's `requires`. Same `.ddd`, 403 on two backends and wide open on three, with
every compile tier green.

Fixed exactly where this document said it belonged — at the list-route emitter,
not by flipping `isAutoAllFind` (which on Java would have routed the gated `all`
to a second `GET /all` endpoint instead of gating `GET /`). "The list read" is
now one shared derivation, `src/ir/util/read-gates.ts` (`listReadFind` /
`listReadGate`), that all five consult, so a backend that forgets it is visibly
missing a call rather than invisibly missing a field read.

Pinned by `test/generator/list-read-gate.test.ts` — all five backends × both list
shapes (bare `T[]` and `paged`) plus the ungated control. Mutation-proven: with
the three fixes reverted exactly the six java/python/elixir assertions fail while
node/.NET and the five ungated controls stay green.

This does not decide D3/D4 either way — if the syntax is later deleted, this
deletes with it. It does mean the form `auth.md` documents is no longer
advertised-and-non-functional.

---

## 5. Independent items

### E1 — `commandHandler` / `queryHandler` have no header gate and are invisible to `denyByDefault`
They are real routes (bound via `api { route <METHOD> "<path>" -> <Ctx>.<Handler> }`).
A body `requires` statement works, but there is no header form, and
`validateDefaultDeny` does not enumerate them — it walks aggregate
operations/creates/destroys, workflow command entries, repository finds, and audit
history only. An **`extern` handler has no body at all**, so it has no gate surface
whatsoever. **Size: S–M.**

### E2 — `getById` reserved-name asymmetry
An author can shadow `find all` to gate it; `getById` is rejected by
`loom.find-reserved-name`, so the by-id read has no author gate surface by any
means. Resolves for free under C2; only worth its own fix if C2 is declined.

### E3 — authorization is no longer assertable at the domain test tier
Consequence of D1: the entity method just runs now, so a DSL `test` block cannot
assert a 403. That belongs at the api tier and may want ergonomics. **Size: S.**

---

## 6. Sequencing

```
B1 (mask in projections) ──┬── C1 (scaffold → projections) ── C2 (retire CRUD reads) ── E2 free
                           │
A1 (system-read construct) ┴── A2, A3, D2 ─── D3 ─── D4
```

- **Immediately, no blockers:** A2, E1.
- **The two loads:** B1 and A1.
- **Gated on the loads:** C1, C2, A3, D2 → D3 → D4.
- **Watch item:** D5, for as long as D3/D4 are pending.

*(judgement: if only one thing gets done, make it A2 — an open read of saga state,
independent, small.)*

---

## 7. Scope + provenance

Verified 2026-08-05 against `main` @ `1f917ac` by generating the same gated
fixture on all five backends and reading the emitted output plus the emitters.
The tables in §1 and the D5 / E1 / E2 findings are measurements. The sequencing,
the C2 prediction, and the B1 fork recommendation are judgement and marked as such.

**This plan is scoped to the authorization / read-path area.** It is not a survey
of Loom as a whole.

Sources: [`auth.md`](../../auth.md), [`tenancy.md`](../../tenancy.md),
[`read-path-architecture.md`](../../old/proposals/read-path-architecture.md),
[`audit.md`](../../audit.md), [T3](../T3-security-governance.md) (M-T3.2, M-T3.13).
