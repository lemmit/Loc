# Capability emission deduplication — resolving typed-capabilities OQ#1

> **Status:** PROPOSED (design note; no implementation yet). Resolves
> [`typed-capabilities.md`](./typed-capabilities.md) **open question #1**
> ("Emission deduplication when a capability is reused"). Sequenced *after*
> typed capabilities land — dedup keys off a stable capability identity, which
> the typed `capability` declaration provides cleanly.
>
> **Headline call:** dedup is a **per-backend codegen choice over an unchanged,
> per-aggregate IR**, enabled by one additive IR seam (capability provenance on
> each propagated filter/stamp). The genuine win is **stamps**, not filters;
> the genuine *risk* is a **stamp-timing semantic divergence that already exists
> today** and must be pinned before any dedup ships.
>
> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain
> Ecto/Phoenix only — vanilla is the only foundation — and `foundation: ash` is
> now a validation error. The "Phoenix / Ash" rows below — `base_filter`,
> single/anonymous policies, the slice-3 bypass work — describe a foundation that
> no longer exists; only the "Phoenix / vanilla" path remains.)**

## 1. The question

A capability (`auditable`, `softDeletable`, `tenantOwned`) is implemented by
*many* aggregates. After lowering, its `filter` / `stamp` body is copied onto
every implementor's `agg.contextFilters` / `agg.contextStamps`. Each backend
then emits that body once **per aggregate**. With 10 auditable aggregates the
`onCreate { createdAt := now()  createdBy := currentUser }` body is emitted 10
times. OQ#1 asks: should generated code be **deduplicated** — a shared base, a
marker-interface loop, a shared interceptor — and at what cost?

The typed-capabilities proposal enumerated the options without choosing:
a shared base mapping, the marker-interface `OnModelCreating` loop, a shared
stamp interceptor keyed on the interface, or per-aggregate copies (status quo).
It also flagged the trap: *an interceptor stamps at SaveChanges, not in the
operation body, so a value read before save would differ.* This note resolves
that.

## 2. Current emission inventory (the baseline we are deduping)

What ships **today** for `contextFilters` and `contextStamps`, per backend:

| Backend | Filter (`contextFilters`) | Stamp (`contextStamps`) |
|---|---|---|
| **.NET / EF** | per-`EntityConfiguration` `builder.HasQueryFilter(...)`, one call per predicate (`emit/efcore.ts:318`) | **already centralized**: one `AuditableInterceptor : SaveChangesInterceptor` with a per-aggregate `switch` arm (`emit/auditable-interceptor.tpl.ts`) — fires at **SaveChanges** |
| **Hono / Drizzle** | AND-ed into every root read site; inlined, or a module-level `<name>Criterion(...)` fn when the filter is exactly one criterion (`repository-find-predicate.ts`) | **not wired** (IR carries it; codegen ignores it) |
| **Java / Hibernate** | static `@SQLRestriction("…")` per entity class; principal filters AND-ed in the repository (`emit/entity.ts:549`, `emit/repository.ts:307`) | applied **in the service body** — `aggregate._stampOnCreate(...)` before `save` (`emit/service.ts:79-97`) — fires at **operation time** |
| **Phoenix / Ash** | `base_filter expr(...)` per resource (`elixir/domain-emit.ts:363`) | **not wired** |
| **Phoenix / vanilla** | per-query helper (`elixir/vanilla/capability-filter.ts`) | **not wired** |

Two facts fall out of this table and drive the whole design:

**Fact A — filters are already "one idiomatic hook per entity," and that is
correct.** Every backend has a native per-entity query-filter seam
(`HasQueryFilter` / `@SQLRestriction` / `base_filter` / WHERE-splice). The
predicate is a `this`-relative one-liner (`!this.isDeleted`). There is no large
shared body to hoist.

**Fact B — stamp timing already diverges across backends.** .NET stamps at
**SaveChanges** (interceptor; *not* visible inside the operation body). Java
stamps **in the operation body** before save (visible if the operation reads the
field back). Hono/Phoenix don't stamp at all. So "what a stamp means" is *not
currently uniform* — and any dedup that moves stamping to a save-time hook is
making a semantic choice, not just a layout choice.

> **Doc/code drift to fix in passing.** `loom-ir.ts:444` and `:474` already
> *describe* the dedup'd shape — ".NET: one `OnModelCreating` filter loop per
> capability, scoped by `Entries<I<Cap>>()`" — but `emit/efcore.ts:191-198`
> explicitly reverted it ("No DbContext-level loop, no marker interfaces … the
> grouping infrastructure was removed when stdlib macros were split"). The
> docstrings document an *intended* design that never shipped. OQ#1's resolution
> includes reconciling these comments with whatever we actually build.

## 3. Design invariants

1. **The IR stays per-aggregate and fully resolved.** Dedup never collapses
   `contextFilters` / `contextStamps` in the IR — that would break the "every
   aggregate is self-describing, backends never re-resolve" thesis and the
   per-entity combination EF *requires* (§5). Dedup is a **rendering** decision.
2. **Dedup is opt-in per backend.** Per-aggregate copies (status quo) remain a
   valid, supported emission. A backend adopts a dedup'd shape only where it is
   idiomatic *and* behavior-preserving.
3. **Behavior is identical; bytes are not.** Unlike the rest of typed
   capabilities (a byte-identical-IR migration), dedup **changes generated
   source by construction** (fewer arms / one loop). So it is gated by the
   **runtime** suites — `dotnet-build` (`/warnaserror`), `java-build`,
   `*-obs-e2e`, `k8s-e2e` (read **and** write round-trip) — *not* by the
   sha256 before==after gate. Stating this plainly avoids a category error in
   the migration plan.
4. **No cross-aggregate emission coupling that fights a platform's model.**
   EF's one-filter-per-entity rule (§5) is the canonical example.

## 4. The one IR seam: capability provenance on propagated members

To group N aggregates' identical filter/stamp under one marker / branch, codegen
must know *which capability* a propagated entry came from. Today that link is
severed at lowering: the propagated predicate is anonymous and the
`implementsCapabilities` list is informational.

Add an **optional, additive** provenance tag, set by the propagation pass in
`src/ir/lower/lower-capabilities.ts`:

- `contextFilterOrigins?: (string | undefined)[]` — index-aligned with
  `contextFilters`; the capability name a filter was propagated from, or
  `undefined` for an aggregate-local or bare (un-`for`'d) context filter.
- `ContextStampIR.capabilityOrigin?: string` — same, on each stamp rule.

Properties:

- **Byte-neutral by default.** No current backend reads it; adding it is a pure
  IR-shape addition (the typed-capabilities byte-identical gate still holds).
- **It is the only new seam.** Everything else is per-backend codegen that
  reads this tag to decide grouping. The marker-interface name is
  `marker(capabilityName)` (a naming-util addition: `pascal(name)` →
  `I<Pascal>` for C#, a TS brand symbol, an Ash extension atom).
- **Pairs with the existing `contextFilterRefs`.** A filter that is one named
  criterion *and* came from a capability can still reify to its
  `<name>Criterion` fn — orthogonal.

## 5. Filters — keep per-entity emission (status quo). Do **not** dedup.

Recommendation: **filters are already optimal; leave them per-entity on every
backend.** Reasons:

- **EF forces per-entity combination.** Classic EF Core allows **one filter per
  entity** (a second `HasQueryFilter` overwrites). An entity implementing two
  filtering capabilities (`softDeletable` + `tenantOwned`) **must AND-combine**
  them into a single predicate — which is inherently per-entity. A
  "loop per capability in `OnModelCreating`" cannot express two independent
  filters on one entity. So the marker-interface loop is not even *correct* for
  the multi-capability case under classic EF; the per-`EntityConfiguration`
  `HasQueryFilter` (combining all of an entity's filters) is the right shape.
  (EF Core 10's multiple named filters relax this — revisit then, not now.)
- **Nothing meaningful to hoist.** The predicate is a `this`-relative
  one-liner; the "duplication" is one line per entity, and each backend already
  has its idiomatic per-entity hook (Fact A).
- **Cross-backend uniformity.** Drizzle (WHERE-splice) and Ash (`base_filter`)
  are *intrinsically* per-read / per-resource. Forcing a shared abstraction onto
  one backend to match a (non-existent) EF win buys nothing.

**Marker interface for filters is still worth emitting** — `I<Capability>` on
the entity — but for **typing / tooling / discoverability** (find-implementors,
`is ISoftDeletable` checks elsewhere), *not* to drive filter installation.

→ **OQ#1 verdict for filters: per-aggregate copies, by design. The marker
interface is emitted for type identity, not dedup. Reconcile the stale
`loom-ir.ts` docstrings to say so.**

> **⚠ This verdict is being revisited (2026-06).** §5's "filters can't dedup"
> rests on **classic EF's one-filter-per-entity rule** (a second
> `HasQueryFilter` overwrites). The .NET backend now targets **EF Core 10**,
> whose **named** query filters lift that rule — and it already emits
> `HasQueryFilter("<Name>", …)` (`emit/efcore.ts` `queryFilterName`). So the
> premise of the "don't dedup" verdict no longer holds for two of five backends.
> See **§5b** for the framework-capability grounding and **§11** for the
> named+dedup plan that supersedes this verdict on the filter side.

## 5b. Framework-native named-filter support (the §9.1 EF10-revisit input)

"Named filter" = the framework lets you register a query/global filter under a
**stable name** so it is (a) one addressable unit per capability and (b)
**selectively bypassable by name**. Whether a backend *can* dedup a capability's
filter into one named unit — vs. only AND-inline a `this`-relative predicate per
entity — is a property of the target framework, not of Loom:

| Backend | Framework | Native **named** filter? | Mechanism | Default state |
|---|---|---|---|---|
| **.NET** | EF Core 10 | ✅ yes | `HasQueryFilter("Name", …)` + `IgnoreQueryFilters(["Name"])` | on by default |
| **Java** | Hibernate | ✅ yes | `@FilterDef`/`@Filter` (named, parameterized) + `session.enableFilter("name")` | **off** by default (must enable per session) |
| **node** | Drizzle | ❌ no | query builder — no global/named filter layer; emulate with a named predicate fn (reified `<name>Criterion`) | n/a |
| **Phoenix** | Ash | ⚠ partial | `base_filter` is single/anonymous; **policies** are named + bypassable but are authz, not query filters | base_filter always on |
| **Phoenix (vanilla)** | Ecto | ❌ no | query DSL — no global filter; emulate with composable named query fns | n/a |
| **Python** | SQLAlchemy | ⚠ partial | `with_loader_criteria(Entity, …)` in a `do_orm_execute` event — global + entity-keyed, but no named, individually-toggleable registry | n/a (and Loom does **not** consume `contextFilters` here yet — a gap) |

Three consequences for the design:

- **Two backends (.NET, Java) have first-class named filters** → a capability's
  filter *can* map to one named DB-layer unit, bypassable by name. The other
  three can only share a **named predicate expression/function** across
  implementors — a codegen/IR concern, not a framework feature.
- **Default-state divergence.** EF filters are on-by-default (bypass with
  `IgnoreQueryFilters`); Hibernate filters are off-by-default (must
  `enableFilter` per session) — so a named Hibernate filter needs an
  interceptor/request aspect to *activate* it, where EF needs nothing. An
  always-on `softDelete` is free on EF, wired on Hibernate.
- **The dedup IR seam should carry capability identity (a stable name)**, letting
  each backend choose its rendering: named-filter on .NET/Hibernate, shared
  predicate fn on Drizzle/Ecto/SQLAlchemy, base_filter-or-policy on Ash. This is
  the same `capabilityOrigin` seam §4 proposes — confirming it serves filters as
  well as stamps.

The §11 plan builds directly on this matrix.

## 6. Stamps — dedup via a marker-interface-keyed write-time hook (the real win)

Stamp **bodies** are larger (multi-assignment, expression-valued) and the
platforms with a save-time interception seam *naturally* centralize by type.
This is where dedup pays off in maintainability and code size.

- **.NET** — the `AuditableInterceptor` already exists; change its
  per-aggregate `switch (entry.Entity)` to **per-capability branches keyed on
  the marker**:
  ```csharp
  if (entry.Entity is IAuditable a) { /* capability's onCreate/onUpdate body, once */ }
  if (entry.Entity is ISoftDeletable s) { /* ... */ }
  ```
  Because the stamp body is `this`-relative and identical across implementors,
  one branch per capability replaces N arms. Aggregate-local / non-capability
  stamps keep a per-type arm (no marker to key on). **No timing change** — it
  already fires at SaveChanges.
- **Java / JPA** — move the per-service `_stampOnCreate` call to a JPA
  **`@EntityListener`** (or a `@MappedSuperclass` base) registered for entities
  implementing the marker, using `@PrePersist` / `@PreUpdate`. ⚠️ **This is a
  timing change** (operation-body → flush) — see §7.
- **Hono / Drizzle, Phoenix** — stamps are unwired today. When wired, emit a
  **single shared helper per capability** (`applyAuditableStamps(row, event)`)
  the repos call, rather than inlining per aggregate. (Dr/Ecto have no native
  save interceptor, so the helper is the dedup unit; timing is whatever the call
  site chooses — pin it per §7.)

## 7. The stamp-timing contract (must be decided *before* any stamp dedup)

Dedup'd stamping on a save-time hook means a stamped value is **not observable
inside the operation body**. Today .NET already behaves this way; Java does not.
We must pick one contract and make every backend conform — otherwise dedup
silently changes Java's observable behavior.

**Recommendation: pin stamps as WRITE-TIME (persistence-moment) semantics.**

- A stamp value (`createdAt`, `updatedBy`, `dataKey`) is **materialized at
  persist**, and is **not guaranteed readable within the same operation body**.
  Authors who need the value mid-operation must compute it explicitly, not rely
  on a stamp.
- Rationale: (a) it matches the *intent* of audit/tenancy stamps (infra
  metadata applied uniformly at the edge, not domain logic the operation reads
  back); (b) it is what .NET — our most complete backend — already does; (c) it
  is the only contract a SaveChanges-interceptor / `@PrePersist` listener can
  honor, which are the idiomatic dedup seams; (d) it keeps the value **out of
  the wire response of the create call** only if the backend re-reads — note as
  a sub-question (§9.3).
- Consequence: **Java's emission changes** from `_stampOnCreate` in the service
  to a `@PrePersist` listener. Behavior-preserving *for any model that does not
  read a stamped field inside the same operation* — which the existing examples
  do not. Gate with `java-build` + `java-obs-e2e` + `k8s-e2e` write round-trip;
  add an IR validator (phase ⑦) that **rejects reading a capability-stamped
  field inside the stamping aggregate's own operation bodies** so the timing
  contract is enforced, not just documented.

If we ever want operation-time stamps, that becomes an explicit per-stamp
modifier — out of scope here.

## 8. Sequencing & phases

Dedup is **not urgent** and is **blocked on typed capabilities** for a clean
capability identity. Status quo (per-aggregate copies) is correct until then.

- **Phase 0 — typed capabilities lands** (separate proposal). Prereq for a
  stable `capabilityOrigin`.
- **Phase 1 — IR provenance seam (§4)** + reconcile the stale `loom-ir.ts`
  docstrings + emit `I<Capability>` marker interfaces on .NET/Java for type
  identity. **Byte-identical-gated** (markers are additive; nothing keys off
  them yet — verify no DTO/wire change). Land independently; low risk.
- **Phase 2 — stamp-timing contract (§7)**: pin write-time semantics; add the
  phase-⑦ validator rejecting in-operation reads of stamped fields. Pure
  validation + docs; no codegen change. Unblocks Phase 3.
- **Phase 3 — .NET stamp dedup**: `AuditableInterceptor` switch → per-capability
  `is I<Cap>` branches. Behavior-preserving (already SaveChanges-timed);
  **runtime-gated** (`dotnet-build`, `dotnet-obs-e2e`, `k8s-e2e`). Output
  changes — *not* byte-identical.
- **Phase 4 — Java stamp dedup**: service `_stampOnCreate` → `@EntityListener`
  on the marker. **Timing change**, guarded by the Phase-2 validator;
  runtime-gated (`java-build`, `java-obs-e2e`, `k8s-e2e`).
- **Phase 5 (opt, when stamps get wired) — Hono/Phoenix shared stamp helper**.
  Couples to "wire stamps through to runtime on Hono/Phoenix" (today a known
  gap, `docs/capabilities.md` §stamp). Dedup is free once that lands (emit the
  helper once, not per aggregate).
- **Filters: no phase.** Stays per-entity by design (§5).

## 9. Open sub-questions (smaller than OQ#1, deferred)

1. **EF Core 10 named filters** — revisit the filter marker-loop once multiple
   named per-entity filters exist; could let `softDeletable` and `tenantOwned`
   register independently. Not before EF10 is the pinned target.
2. **`dataKey` / managed-value stamps** (tenancy) — a *computed* stamp (derived
   materialized path), the strongest dedup case since its body is non-trivial
   and identical everywhere. Confirm it rides the same `capabilityOrigin` path;
   it is the worked case to validate the design against
   ([`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) R5).
3. **Create-response visibility under write-time stamps** — if a stamped field
   must appear in the create call's response, the backend re-reads after save.
   Decide per backend; orthogonal to dedup but surfaced by the §7 contract.
4. **Cross-context capabilities** — a capability implemented by aggregates in
   *different* bounded contexts emits its marker/interceptor once per context
   (interceptors are per-`DbContext`). That is correct (per-store), but confirm
   the marker interface type is shared, not per-context-duplicated.

## 9b. Implementation status (2026-06)

What shipped, and what stays deferred after an end-to-end investigation of the
`.NET` stamp path:

- **`.NET` lifecycle stamping now compiles and is CI-covered.** The
  `AuditableInterceptor` previously emitted uncompilable code (a bare
  `currentUser` identifier; `private set` stamped fields the interceptor could
  not write) and **no build matrix exercised it**. Fixed to mirror the Java
  reference: a `currentUser` stamp value resolves to the principal id read from
  the ambient `RequestContext.Current` (the .NET analogue of Java's
  `currentUser.id()`); stamped fields widen to `internal set` (same-assembly
  interceptor); a `loom.dotnet-stamp-unsupported` validator gates principal
  stamps without auth (mirrors `loom.java-stamp-unsupported`); covered by
  `test/e2e/fixtures/dotnet-build/stamps-principal.ddd` under
  `dotnet build /warnaserror`. This is the working *raw-id* stamp pattern
  (`createdBy: guid` + `:= currentUser`), the same one Java's
  `stamps-principal.ddd` compiles.

- **The `auditable` capability's `createdBy/updatedBy: User id` fields now
  compile on every backend.** The prelude types these as `User id` — the id of
  the `user {}` **principal**, which is not a domain aggregate, so it has no
  `UserId` strong-id class and the strong-id path dangled (an undefined `UserId`
  field/EF-conversion/response-DTO; no backend build matrix compiled
  `with auditable`). Fixed at lowering: `lowerBase`'s id branch detects an
  *unresolved* id ref whose text is the principal name (`PRINCIPAL_TYPE_NAME`,
  shared from `src/util/principal.ts`) with a `user {}` block in scope, and
  lowers it to the principal's declared id **scalar** (`user { id: <type> }`) —
  a plain primitive, not a strong id. So `createdBy` becomes the same plain
  scalar a hand-written `createdBy: guid` produces, and the field / `currentUser`
  stamp / wire all agree. Covered by `auditable.ddd` cells in both the
  `dotnet-build` and `java-build` matrices, plus a lowering unit test
  (`ir-capabilities.test.ts`) that pins the scalar tracks `user { id }`.

- **Marker-interface dedup (`I<Capability>`) stays deferred.** The interceptor
  switch is already one arm per aggregate; the dedup is cosmetic. Now that
  `auditable` compiles (it is the only stamping capability), a *verifiable*
  marker dedup is unblocked — but it remains low-value until a second stamping
  capability exists. Revisit then.

## 11. Plan: named filters in service of **selective bypass** (the adopted feature)

> **Status:** PLAN — APPROVED, implementation started (2026-06). State audit +
> design review + simulation sign-off done (fresh `main` @ `86d55e87`).
> Supersedes §5's "filters stay per-aggregate, don't dedup" verdict on the
> *value question*: dedup is dropped as a goal; the feature is
> **selectively-bypassable filters**, with the §4 provenance seam as its
> substrate.
>
> **User-approved decisions:** keyword `ignoring`; bypass-all via the `*`
> wildcard; scope `find` + `view` + inline reads; bypassing an unknown /
> filter-less capability or an unsupported backend is a compile error
> (`loom.filter-bypass-unknown-capability` / `loom.filter-bypass-no-filter` /
> `loom.filter-bypass-unsupported`). Ship order: Slice 0 → .NET → Drizzle+Ecto →
> Java (full hybrid) → defer Ash + Python.
>
> **SHIPPED (branch `claude/capability-filter-dedup`):**
> - **Slice 0** — `capabilityOrigin` provenance seam (byte-neutral). ✅
> - **Slice 1** — grammar (`find`/`view`/inline, `*`) + lowering + printer +
>   the three validators + **.NET** `IgnoreQueryFilters`. Runtime-verified:
>   emitted project compiles under `dotnet build /warnaserror` (the gate caught
>   a CA1068/CS1503 inline-read signature bug, since fixed). ✅
> - **Slice 2** — **node/Drizzle** + **Phoenix/Ecto-vanilla** honor bypass by
>   omitting the predicate; validator widened to `{dotnet, node, elixir-vanilla}`
>   (elixir-**Ash**, java, python still fail-fast — foundation-aware). Runtime-
>   verified: elixir-vanilla `mix compile --warnings-as-errors` + node
>   `tsc --noEmit` both pass. ✅
> - **Slice 3** — **Phoenix/Ash** honors bypass via the §11.6 "pay for what you
>   use" triage: a capability some read `ignoring`s is PROMOTED out of the
>   always-on `base_filter` and re-applied per-read via `filter expr(...)`,
>   omitted on the reads that bypass it (the default `:read` becomes an explicit
>   `read :read do primary? true; filter … end`; finds/views/retrievals get
>   their own promoted `filter` line). A never-bypassed cap and a bare
>   (capability-less) `filter` stay in `base_filter`. Triage is derived at
>   codegen (`src/generator/elixir/capability-filter.ts`) from read-decls ×
>   `contextFilterOrigins` — not stamped. Validator now allows elixir on BOTH
>   foundations. Runtime-verified: a `with softDeletable` + bare-filter system
>   with `ignoring softDeletable` / `ignoring *` reads compiles under
>   `mix compile --warnings-as-errors` against real Ash 3.x
>   (`test/e2e/fixtures/elixir-ash-build/filter-bypass.ddd`). ✅
> - **Slice 4** — **Java/Spring Boot** honors bypass via the §11.6 "pay for what
>   you use" triage: a never-bypassed cap (and any bare filter) stays on the
>   always-on `@SQLRestriction`; a capability some read `ignoring`s is PROMOTED to
>   `@FilterDef(autoEnabled = true, applyToLoadByKey = true)` + `@Filter`, and the
>   bypassing find/view/retrieval bodies wrap with
>   `em.unwrap(Session.class).disableFilter(…)` / `enableFilter(…)` (finally-rearmed).
>   Triage derived at codegen (`src/generator/java/capability-filter.ts`). Runtime-
>   verified: `gradle testClasses bootJar` against Spring Boot 4.1 / Hibernate 7.x
>   (`test/e2e/fixtures/java-build/filter-bypass.ddd`). ✅
> - **Slice 5** — **Python/SQLAlchemy** honors bypass by omitting the bypassed
>   conjunct (find + view bake-in; `run_<retrieval>` unions its inline call-site
>   bypasses). The proposal's "wire `contextFilters` first" prerequisite was
>   already satisfied on `main` (Python emits capability filters today). Runtime-
>   verified: `ruff` + `mypy --strict` + `pytest`
>   (`test/e2e/fixtures/python-build/filter-bypass.ddd`). ✅
>
> All five DB backends now honor `ignoring`;
> `FILTER_BYPASS_FAMILIES = {dotnet, node, elixir, java, python}` is complete.
>
> **Known pre-existing gap (orthogonal):** on node/Drizzle the criterion-based
> retrieval path (`Repo.findAll(<Criterion>)`) does **not** apply capability
> filters at all (even without `ignoring`), so inline-read bypass there is a
> vacuous no-op. Not introduced by this work; tracked separately.

### 11.1 The reframe (why not "dedup")

Filter predicates are `this`-relative one-liners (§5, Fact A) — "dedup" only
collapses one line per entity into one named registration: code-*size* polish, no
capability. The value EF Core 10 / Hibernate *named* filters actually unlock is
**bypass**: a query reading past a capability's filter (admin view ignoring
`softDeletable`, cross-tenant report ignoring `tenantOwned`). That is green-field
— the audit confirms `IgnoreQueryFilters` exists only in an `efcore.ts` comment,
with no DSL surface and no emitted call site. So we build bypass; naming is a
*means* (the EF/Hibernate handle), not a standalone slice.

### 11.2 Surface — `ignoring <Cap>`, a clause on `find` (sibling of `where`)

Keyed on the **capability name** (the stable identity the user wrote with
`with <Cap>`), never on a per-filter name — the grammar already removed the
`filter for "<name>"` qualifier precisely because *a capability co-locates its
filter* (`ddd.langium:906-908`). No name is added to `FilterDecl`.

```ddd
aggregate Order with softDeletable, tenantOwned { code: string  total: money }

repository Orders for Order {
  find adminView(): Order[] ignoring softDeletable   // drop softDeletable's predicate; keep tenantOwned's
  find raw(): Order[] ignoring *                      // bypass every capability filter (wildcard)
}

view ActiveOrders = Order where this.total > 0 ignoring softDeletable   // also on views
```
```csharp
// .NET / EF Core 10 — the bypass call site that is vapor today
public Task<List<Order>> AdminViewAsync() =>
    _db.Orders.IgnoreQueryFilters(["SoftDeletableFilter"]).ToListAsync();
```

**Surface (user-approved 2026-06):** keyword **`ignoring`**; bypass-all via the
**`*`** wildcard (not an `all` soft keyword); allowed scope is **`find` +
`view` + inline reads** (broader than a find-only v1).

- **`find` / `view`** — a trailing clause, sibling of `where`:
  `('ignoring' ('*' | bypass+=[Capability] (',' bypass+=[Capability])*))?`
  on `FindDecl` (`ddd.langium:1050-1052`) and on both `View` forms
  (`ddd.langium:1151-1162`, after each `where`). Soft keyword `ignoring`; flat
  `+=` list; `*` is the discriminator over the explicit-capability list.
- **Inline reads** — `Repo.findAll(…)` / `Repo.run(<Retrieval>(…))` are *member-
  call expressions*, so bypass there is an **expression-level** modifier, not a
  declaration clause — a distinct grammar shape (e.g. a postfix `ignoring` on the
  call, lowered onto the `repo-run` `ExprIR`). Settle its exact form during
  Slice 1 design; it reuses the same `capabilityOrigin` resolution.

Keyed on the **capability name** the user wrote with `with <Cap>` — never a
per-filter name (the `filter for "<name>"` qualifier was deliberately removed). A
capability contributing *several* filters is bypassed **as a unit**. Aggregate-
local anonymous `filter <expr>` (no capability) is **not** bypassable — accepted
scoping (you own that source); revisit only if a real need appears.

### 11.3 Slices (incremental; per-backend, because there is no shared filter seam)

| # | Scope | Files (phase) | Gate | Parallelizable? |
|---|---|---|---|---|
| **0** | `capabilityOrigin` provenance seam | `FilterEntry` + `collectFilters` (`lower-capabilities.ts:11-81`); `contextFilterOrigins?: (string\|undefined)[]` on `loom-ir.ts` (mirror `contextFilterRefs`) | **byte-identical** (no consumer) | no — serializing substrate |
| **1** | surface (`find`+`view`+inline) + **.NET** | `ddd.langium` `ignoring`-clause on `FindDecl` + `View` (×2 forms) + the `Repo.findAll`/`run` call expr (+`langium:generate`, commit generated); `lower` → bypass-set on `FindIR`/`ViewIR`/the `repo-run` `ExprIR`; printer arms (print-completeness); `efcore.ts` resolve origin→EF name→`IgnoreQueryFilters` (repo finds + view reads + inline); `loom.filter-bypass-*` validators (`ir/validate/checks/*`, mirror `validateContextFilterSupport`) | runtime: `dotnet-build`, `dotnet-obs-e2e`, `k8s-e2e` read+write | no (grammar→regen→lower→emit is a chain) |
| **2** | **Drizzle + Ecto** honor bypass (omit predicate from the AND-chain) | `typescript/repository-find-predicate.ts`; `elixir/vanilla/capability-filter.ts` | `behavioral-e2e`, `k8s-e2e` | **yes — 2 agents** (disjoint trees) |
| **3** | **Ash** honors bypass — §11.6 triage (promote a bypassed cap out of `base_filter`, apply per-read) | `elixir/capability-filter.ts` (triage + per-read predicate); `elixir/domain-emit.ts` (reduced `base_filter` + default-`:read` override); `elixir/domain/actions.ts` (explicit `read :read`); `elixir/repository-emit.ts` (per-find/-view/-retrieval `filter`); validator widened to allow elixir-Ash | `elixir-ash-build` (`filter-bypass.ddd`) `mix compile --warnings-as-errors` | ✅ done |
| **4** | **Java** (`@SQLRestriction`→`@Filter` *only where bypassed* — §11.6 triage; `Session.disableFilter`/`enableFilter` at bypass sites) | `java/capability-filter.ts` (triage + `inlineRunBypassesByRetrieval`); `java/emit/entity.ts` (split `@SQLRestriction` ↔ `@FilterDef(autoEnabled)`/`@Filter`); `java/emit/repository.ts` (Session disable/enable wrap); `java/emit/view.ts` + `document-store.ts`; `java/index.ts` threads `promotedCaps` | `java-build` (`filter-bypass.ddd`) `gradle testClasses bootJar` | ✅ done |
| **5** | **Python** (filter-emission already on `main`; bypass = omit conjunct, find+view+inline) | `python/find-predicate.ts` (`FilterBypass` + bypass-filtered `contextFilterPredicate`); `python/repository-builder.ts` (per-find/-view bake-in + `run_<retrieval>` union bypass) | `python-build` (`filter-bypass.ddd`) `ruff` + `mypy --strict` + `pytest` | ✅ done |

All five DB backends (dotnet, node, elixir, java, python) now honor
`ignoring`; `FILTER_BYPASS_FAMILIES = {dotnet, node, elixir, java, python}`. The
`loom.filter-bypass-unsupported` fail-fast (mirrors `loom.context-filter-unsupported`)
is now unreachable for backend deployables — kept as a guard for any future
non-honoring target rather than removed.

### 11.6 Java — the "pay for what you use" hybrid (researched; no regression)

The two naïve options both lose: `@SQLRestriction` is **unbypassable by design**
(Hibernate javadoc: *"always applied and cannot be disabled"*), and blanket-
migrating to `@Filter` makes every existing soft-delete/tenancy filter
**off-by-default** (a silent regression). The idiomatic resolution leans on the
fact that **Loom owns every query site** and can triage per capability×entity:

- **Triage at generation.** If the model contains **no** `ignoring <Cap>`
  targeting an entity → keep today's **`@SQLRestriction`** (zero regression,
  covers JPQL + by-id + lazy; no runtime cost). Only when an `ignoring <Cap>`
  *does* target it → emit that predicate as a **bypassable `@Filter`** instead.
  This is a *derived* fact (find-decls × capability membership), computed at
  enrich/codegen — never stamped.
- **Always-on without a global hook.** Loom targets **Spring Boot 4.1.0 →
  Hibernate ORM 7.x** (`SPRING_BOOT_VERSION` in `java/emit/program.ts:21`), so
  the 6.5+ machinery is available: emit
  `@FilterDef(name=…, autoEnabled = true, applyToLoadByKey = true, parameters = @ParamDef(name=…, type=…, resolver = <Cap>Resolver.class))`
  + `@Filter(name=…)`. `autoEnabled` reproduces `@SQLRestriction`'s always-on
  semantics with no interceptor to forget; `applyToLoadByKey=true` keeps by-id /
  lazy loads filtered (else a promoted filter leaks previously-hidden rows); a
  request-scoped `Supplier<T>` resolver supplies parameters (e.g. the tenant id).
- **Bypass call site.** At a generated `ignoring <Cap>` finder, wrap the query:
  ```java
  Session s = em.unwrap(Session.class);
  s.disableFilter("softDeletable");
  try   { return em.createQuery("select o from Order o", Order.class).getResultList(); }
  finally { s.enableFilter("softDeletable"); /* re-arm for the rest of the session */ }
  ```
- **Gotchas to encode:** `@SQLRestriction` and `@Filter` coexist on one entity
  (different predicates AND-cleanly); **native SQL bypasses both** — any native
  query site must splice the predicate manually. `@SoftDelete` / `@TenantId` are
  *not* used for bypassable capabilities (same no-escape limitation as
  `@SQLRestriction`; reserve them for hard, never-`ignoring`-able isolation).

This makes Java a **full bypass backend** (not deferred-only) at the cost of one
triage pass — you pay the `@Filter` machinery exactly where bypass is modeled,
and everything else keeps today's zero-cost behavior. The triage principle
generalizes: *render a capability filter in its bypassable form only where the
model actually bypasses it* — applicable to any backend whose always-on and
bypassable forms differ (Java here; .NET needs none, EF's named filters are
always-on **and** bypassable in one form).

### 11.4 Orchestration — skills & agent parallelization

- **Skill:** `language-feature-developer` drives the gated phases. Done: state
  audit, design review. Next: **feature-simulator → user sign-off** (paper
  prototype of 11.2's `.ddd` + per-backend generated fragment) *before any code*.
- **Bottleneck then fan-out:** Slice 0 is the single serializing dependency
  (everything reads `capabilityOrigin`). One **feature-developer** agent lands it.
  Slice 1 is an internal chain (one agent). After Slice 1, **Slice 2's two
  backends and every deferred backend are independent** → spawn one
  feature-developer per backend in a single turn (the "disjoint buckets"
  pattern).
- **Tests:** a `test-developer` agent places 1 parsing + 1 negative-validator + 1
  IR + 1 generator test per touched backend at lowest altitude; bypass is
  **runtime-gated** (byte-changing), verified via the `verify` skill driving
  `k8s-e2e` read+write round-trips.
- **Final review:** `simplify` + `code-review` over each diff; `pipeline-layering`
  + Biome gates.

### 11.5 Architecture notes (from the review)

- **Derive, don't stamp:** store `capabilityOrigin` (a genuine propagation-time
  input nothing can re-derive once the predicate is anonymized), but keep the EF
  filter *name* derived in the emitter (`queryFilterName`) — resolve
  `ignoring <Cap>` → origin → name at codegen, never onto the IR.
- **Resolved facts on `LoomModel`:** the bypass set rides `FindIR`;
  `contextFilterOrigins` is index-aligned with `contextFilters`. No backend
  re-resolves.
- **Completeness gates:** new `ignoring` syntax trips **print-completeness**
  (printer arm) + round-trip; the new diagnostic needs a stable `loom.*` code
  (**diagnostic-codes-completeness**). No walker/heex gates (not UI).

## 10. Cross-references

- [`typed-capabilities.md`](./typed-capabilities.md) — OQ#1 this resolves; the
  typed `capability` decl that supplies the capability identity.
- [`../capabilities.md`](../../capabilities.md) — current (stringly-typed) filter /
  stamp / implements reference and the per-backend emission this builds on;
  notes the Hono/Phoenix stamp-wiring gap (Phase 5 prereq).
- [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) R5 —
  `tenantOwned` / `tenantRegistry`, the `dataKey` managed stamp (sub-question 2).
- [`reified-criteria.md`](./reified-criteria.md) — `contextFilterRefs`, the
  orthogonal filter-as-criterion reification.
- Code: `src/ir/lower/lower-capabilities.ts` (propagation; the new seam),
  `src/ir/types/loom-ir.ts:440-478` (the IR fields + stale docstrings),
  `src/generator/dotnet/emit/auditable-interceptor.tpl.ts` (Phase 3),
  `src/generator/dotnet/emit/efcore.ts:191-324` (filters; §5),
  `src/generator/java/emit/service.ts:74-103` + `emit/entity.ts:549` (Phase 4),
  `src/generator/typescript/repository-find-predicate.ts` (Hono; Phase 5).
