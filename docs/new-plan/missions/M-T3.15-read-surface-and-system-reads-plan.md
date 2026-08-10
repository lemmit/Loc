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

---

## 0. TL;DR

Four root causes. Everything else in this doc is a symptom of one of them.

- **A — Loom has no construct for SYSTEM READS.** Every read that isn't aggregate
  CRUD is hand-rolled: its own route shape, its own gate story (or none), its own
  default-deny status. There are three of them today and they have three
  different answers.
- **B — the two read surfaces cannot compose.** Gated projections and
  `mask unless` are mutually exclusive by validator (`loom.field-mask-projection-source`),
  and the diagnostic's own remedy points authors back at the *ungated* CRUD routes.
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
| workflow instances | `/workflows/<wf>/instances`, `/instances/{id}` | **none** | **no** |
| provenance | — | n/a | n/a — write substrate only, **no read endpoint exists** |
| query-time projections | `/projections/<name>` | first-class `requires` | yes |

Three reads over compiler-owned tables, three different answers. Provenance is
exactly where audit was before #2378: a table nothing can read. It will hit this
same question the moment it gets a route — which is the tell that the answer
should be a construct, not a fourth one-off.

### A1 — introduce a first-class system-read construct
Covers audit history, workflow instances, and provenance behind one surface: one
gate, one masking hook, one entry in `validateDefaultDeny`. This is the item that
makes A2/A3 and the D2 repoint cheap instead of repetitive. **Size: L.**

### A2 — gate workflow-instance reads
`GET /workflows/<wf>/instances` exposes correlation state, command params, and
saga progress to any authenticated caller, and `validateDefaultDeny` does not
enumerate it. Standalone security fix that does not wait on A1. **Size: S.**

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

### D5 — interim risk while D3/D4 are pending
`find all(): T[] requires <expr>` is **enforced on node and .NET, silently dropped
on Java, Python, and Elixir.** Root cause: `isAutoAllFind` (`java/emit/repository.ts`,
and the identical predicate in the python emitter) tests
`name === "all" && params.length === 0 && !filter` — it never looks at `requires`,
so an author-declared *gate-only* `all` is misclassified as the compiler-synthesized
one and dropped, gate included. Adding a `where` clause makes it work; declaring
only a gate — the form `auth.md` documents — does not.

**Not being fixed**, because D4 deletes the syntax. But the workaround is
*documented* in `auth.md` and `T3`, and it is broken on three of five backends —
so if D3/D4 are more than a release away, either fix it or mark it broken in the
docs. **Do not leave it advertised and non-functional.**

> Note the fix would NOT be to flip `isAutoAllFind`: on Java that would route the
> gated `all` to `GET /all` as a second endpoint instead of gating `GET /`. The
> fix belongs at the list-route emitter, matching what node and .NET already do.

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
