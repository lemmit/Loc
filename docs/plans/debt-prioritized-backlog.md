# Stubs, TODOs & Debt — Prioritized Backlog

> **Status banner (2026-06):** The **Ash foundation has been REMOVED.** `platform: elixir` now generates Phoenix LiveView on PLAIN Ecto/Phoenix (the "vanilla" foundation) only. The `foundation:` knob stays, but `foundation: ash` is now a **validation error**; `vanilla` is the default and only valid value. Many entries below were written while the Ash foundation was live and still talk about an "elixir/ash" vs "elixir/vanilla" split, gates that "stay on ash", or building against "real Ash 3.x" — read those as historical: the single elixir backend is plain Ecto/Phoenix today, and any "(Ash defer)" / "gated on ash" cell now ships on that one elixir backend. The design pack named **ashPhoenix** (HEEx components) is unrelated and stays.

**Created:** 2026-06-18 · **Status:** living backlog (work through top-down)

A single ranked list of every reserved stub, parity gap, and `TODO`/`not yet`
marker found across the toolchain, so we can tackle them one at a time. Each
item carries a stable ID (`DEBT-NN`), the target(s) affected, an impact/effort
read, and a link to any existing plan.

This is the **prioritized** companion to the empirical backend/frontend audits —
[`docs/audits/backend-feature-parity-2026-06.md`](../audits/backend-feature-parity-2026-06.md)
and [`docs/audits/frontend-parity-audit-2026-06.md`](../audits/frontend-parity-audit-2026-06.md),
which cover the full five-backend / four-frontend roster (`src/platform/registry.ts`:
node/dotnet/java/python/elixir backends; react/vue/svelte/angular frontends).
(The older [`gated-features-inventory.md`](../audits/gated-features-inventory.md),
snapshot 2026-06-03, is superseded — it predates the Java/Python/Vue/Svelte/Angular
targets.) When a cited file disagrees with any doc, the **code wins**.

> **Cross-link (2026-07-05):** cross-backend **runtime-value** parity — the wire
> JSON a booted backend actually sends/accepts (camelCase keys, enum casing, no
> leaked timestamps, association round-trip) — is now tracked as named RS-rules in
> [`docs/conformance-semantics.md`](../conformance-semantics.md), separate from the
> structural OpenAPI parity in [`conformance.md`](../conformance.md). That's the
> home for the wire-parity fix class (#1620–#1660) this backlog's fix-avalanche
> kept hitting; RS-2/3/5 are gated per-PR today.

---

## Code-verified audit pass (2026-06-19, re-verified 2026-06-28)

Every open entry was checked **against the actual validator gates / generator
emitters** (not the prose). Headline: the **backend & adapter tier (DEBT-02,
03, 06, 07, 13, 14, 15, 17, 20–25, 27–29) is accurate** — those gaps are
genuinely gated (`loom.*-unsupported`) or stubbed (`AdapterNotImplementedError`).
The **stale/over-stated entries were the frontend & "aspirational completeness"
ones** — corrected this session: DEBT-08 (paged done, envelope no-live-use),
DEBT-19 (TPH ships on all 5 backends), DEBT-31 (sortBy dropped).

**2026-06-28 swarm re-verification** (every row re-checked against fresh `main`)
found the backlog now stale on the **audit/lifecycle pair** — both have landed
since the 2026-06-19 pass:
- **DEBT-04 → DONE.** Audited operations *and* audited lifecycle now ship on
  **all 5 backends**: `AUDIT_OP_BACKENDS === AUDIT_LIFECYCLE_BACKENDS ===
  {node, dotnet, java, python, elixir}` (`system-checks.ts`). The grammar *does*
  carry an `audited` slot on **both** `Create` and `Destroy`
  (`ddd.langium:1505,1516` — `(audited?='audited')?`), `lowerCreate`/`lowerDestroy`
  *read* it (`lower-members.ts:266,282` — `c.audited ?? false`, not hardcoded),
  and node *emits the lifecycle audit row* (`routes-builder.ts:455,597` —
  `tx.insert(schema.auditRecords)` for create+destroy, before:null/after=wire and
  vice-versa). The old "lifecycle = vaporware / node gate aspirational" finding
  was itself stale (likely written against pre-#1503 code).
- **DEBT-16 → DONE** (was "⛔ BLOCKED on grammar"). The grammar block it was
  waiting on never existed on fresh `main` — same `audited` slot + lowering +
  all-5-backend emission as DEBT-04.
- **DEBT-26** is *over-stated*, not wrong: the persisted workflow-state **row IS
  emitted** on java/.NET/elixir-vanilla (`workflow-state-emit.ts` /
  `workflow-instances-emit.ts`) and the IR fields (`stateFields`,
  `correlationField`, `instanceWireShape`) *are* consumed — the genuine remainder
  is the step-execution **choreography** + node/python persistence.
- **DEBT-12** new-parts-in-body is **shipped** (`renderNew` in
  `heex-walker-core.ts`), not "an unreachable stub".

Everything else re-confirmed accurate. Per-entry verdicts:

| ID | Verified | Note |
|---|---|---|
| 01 | ✅ DONE | tenancy filter on all 5 backends |
| 02 | 🟢 mostly DONE (2026-06-28 re-verified) | Relational `filter`s ship on all 5 (principal + non-principal; **python's relational principal landed** — `supportsPrincipalFilter('python')` true). `shape(embedded)` `filter`s ship on node/java/elixir/.NET **and now python** (#1571), incl. the principal×embedded intersection (`supportsPrincipalNonRelationalFilter`; gate-verified by `embedded-tenancy.ddd`). The principal × `document` intersection also ships on node/java (verified 2026-06-28: the emitted node repo binds `requireCurrentUser()` and weaves `rec.tenantId === currentUser.tenantId` into every document read; build-gated by `ts-build/document-tenancy.ddd` + `java-build/document-tenancy.ddd`). **python `shape(document)` now landed too** (#1607 — `documentCapabilityBody` evaluates the predicate IN-APP over the rehydrated doc, principal `currentUser` bound via `require_current_user()`; build-gated by `python-build/document-tenancy.ddd`, ruff + mypy --strict clean). **DEBT-02 is fully drained** — the only non-document backend left is elixir, which has no `document` shape (DEBT-07). |
| 03 | 🟢 **DONE** | Elixir (vanilla) union returns ship for return/let, in-memory `assign` mutation, `precondition`/`requires` guards, `emit` (PubSub) — **and now ref-collection (`X id[]` → `many_to_many`) `add`/`remove`**: the returning-op emitter was missing the enriched `agg` in its render context, so `members += t` silently miscompiled (containment-jsonb branch + no join-table write). Now it mirrors the non-returning path — binds the id-list local, persists via a `put_assoc` changeset, projects the wire to ids (`__ref_id_list/1`). The backlog's old "validator hint / `manage_relationship` / generic-action bridge" detail was **stale Ash fiction** (no such gate ever existed). |
| 04 | ✅ DONE (2026-06-28 re-verified) | audited **ops + lifecycle** ship on all 5 backends; grammar has the `audited` slot on Create/Destroy, lowering reads it; node emits the lifecycle audit row. Old "vaporware/aspirational" finding was stale |
| 05 | ✅ DONE | `For` shipped; List/Detail removed |
| 06 | ✅ DONE | Provenance runtime shipped on the elixir backend (#1400). (Was foundation-aware vanilla-only; Ash foundation removed, so it's just the elixir backend now.) |
| 07 | 🟢 DONE (CRUD) | elixir emits `shape(document)` (#1403) — `(id, data, version)` jsonb + schemaless-changeset fold |
| 08 | ✅/⚠️ | paged done; envelope deferred (no live use) |
| 09–11 | ✅ DONE | this session |
| 12 | ✅ mostly DONE | `requires` guard ships (handle_params); new-parts-in-body **ships** (`renderNew`, not a stub — 2026-06-28); verify_token niche |
| 13 | ⛔ WON'T-DO (de-scoped, #1588) | `X id[]` is contractually a **set**; ordering is a read-time projection (`position`/`rank` field + `sort:`), not join storage — see the DEBT-13 row. #1580 closed won't-do; #1590 then dropped the questionable join `ordinal` from all backends |
| 14 | 🔴 OPEN | java `hosts:` → `loom.java-fullstack-unsupported` |
| 15 | 🟢 **DONE (java)** | nested part-in-part containments (single **and** the silently-boot-broken collection case) now map on java: a part FKs to its DIRECT parent (`directParentOf`, shared with migrations-builder), so the `@OneToOne`/`@OneToMany` join column matches the Flyway DDL. Gate `loom.java-single-containment-unsupported` removed; boot-verified on Postgres. This is **Phase 1 of `nested-parts-alignment.md`** — node/.NET/python still flatten nested FKs to the root (lossy for a collection nested below the root); their realignment is Phases 2–4 |
| 16 | ✅ DONE (2026-06-28 re-verified) | the grammar "block" never existed on fresh `main` — Create/Destroy carry the `audited` slot, lowering reads it, all 5 backends emit the lifecycle audit row (merged into DEBT-04) |
| 17 | 🟡 OPEN (partial, **narrowed 2026-06-29**) | MikroORM real adapter — **retrievals now ship** (`run<Name>` methods, #1611, mirroring Dapper DEBT-18); assoc/inheritance/nested-parts/non-relational/filters still gated. Out-of-subset retrieval predicates cleanly rejected (`loom.find-predicate-unsupported`) |
| 18 | 🟡 OPEN (partial, **narrowed**) | Dapper **retrievals now ship**; only out-of-subset predicates stub (`NotImplementedException`) |
| 19 | ✅ DONE | TPH on all 5 DB backends |
| 20 | ✅ DONE (default/decl alignment) | every backend's eventLog **default now resolves to a REAL adapter** (java `axon`→`jpa`, dotnet `marten`→`efcore`, elixir `ashPostgres`→`ecto`, matching node's `drizzle`); **ecto now declares `["state","eventLog"]`** (it drives the vanilla ES emit). ES strategy itself ships on node/dotnet/java/elixir-vanilla; the marten/axon **event-store stubs** remain (DEBT-23) |
| 21 | 🟡 OPEN (partial) | one real app-`style:` per backend (dotnet=cqrs, node/java=layered); rest reserved stubs |
| 22 | 🟡 OPEN (partial) | one real `transport:` per backend (node=hono, dotnet=controllers); express/fastify/minimalApi stubbed |
| 23 | 🔴 OPEN | marten/axon/jooq all `AdapterNotImplementedError` stubs |
| 24 | 🟡 OPEN (**narrowed further**) | criterion reification ships on java/dotnet/node/elixir (python non-reifying *by design*). **.NET + Hono reified find/retrieval principal query-faces now bind the ambient principal** (.NET `RequestContext.Current!.CurrentUser!`, Hono `requireCurrentUser()`) — fixed a latent compile break on both where a `currentUser` criterion reified to an unbound `currentUser` (.NET CS0103 in the `Specification<T>` ctor; Hono `tsc` in the module-level `<name>Criterion` fn). **java + python audited + already correct** (inline query binds the ambient principal — java `@Query` SpEL, python `require_current_user()`), so the compile-bug residue is drained across every reifying backend. Remaining (lower-value cleanup): reifying a principal criterion into a `Criterion<T>`/named *object*, retiring `usesUser` find-threading, and **adding criterion reification to Phoenix** (it doesn't reify today — Ash path removed) |
| 25 | 🔴 OPEN | worker/orleans/genserver all stubs |
| 26 | 🟡 OPEN (**narrowed further, 2026-06-28**) | instance **visibility** ships on all 5; the persisted workflow-state **row IS emitted** on java/.NET/elixir-vanilla and the IR fields (`stateFields`/`correlationField`/`instanceWireShape`) **are consumed** — remaining = step-execution **choreography** + node/python persistence (not "no backend consumes the fields") |
| 27 | 🔴 OPEN | 5 `PlatformSurface` hooks (authGate/auditInit/compliance/tenancy/i18n) are optional no-ops, zero impls (tenancy+audit landed via *other* paths) |
| 28 | 🟡 OPEN (**re-scoped 2026-06-29**) | The original framing was stale. Pagination is **NOT grammar-gated** — it's a deliberate call-site design: a `paged`-return surface (`find x(): T paged` → `Paged<T>`) **already ships** on Hono/EF/Phoenix/React, plus a retrieval call-site `page` arg (`Repo.run(R(args), page?)`). The only real pagination gap is that the **auto-generated implicit `find all()` is unbounded** (`T[]`, no limit). `loads:` is lowered but a **deliberate no-op** on node/.NET (owned containments are part of the parity-enforced `wireShape`, so `loads:` can't narrow them — documented at `repository-find-builder.ts` / `dotnet/emit/repository.ts`); the genuinely-unconsumed part is **cross-aggregate eager-fetch** (`self.lines[].product`), an explicit v2 hydration concern |
| 29 | 🔴 OPEN | views are single-source only (no joins, no per-view params) — grammar-level |
| 30 | 🔴 OPEN (a/b/c), ❓ STALE (d) | seed create-validation / appliers / block-body-lambdas genuinely stubbed; **(d) "method-call hooks binding" — no such IR field found; likely a stale/mislabeled entry** |

**Takeaway for picking work:** trust the backend-tier rows; with DEBT-06
(provenance) and DEBT-07 (`shape(document)`) now landed on the elixir backend,
with DEBT-03 (union `add`/`remove` bodies) now **done** on vanilla, with DEBT-04
+ DEBT-16 (audit ops **and** lifecycle) now **done on all 5 backends** (2026-06-28
re-verification — the grammar block and the "vaporware" framing were both stale),
and DEBT-13 **de-scoped as a non-feature** (see its row), the backend tier is
essentially drained of tractable parity wins.
DEBT-24's compile-bug residue is drained across every reifying backend: .NET +
Hono now bind the ambient principal in the reified find/retrieval query-face
(latent compile breaks fixed), and java + python were audited as already correct
(inline query binds the ambient principal). Its remaining residue
(`Criterion<T>`-object reification of principal criteria, `usesUser` retirement,
adding criterion reification to Phoenix) is lower-value cleanup. The frontend
tier is essentially cleared.

---

Targets: **node** (Hono/TS) · **dotnet** (.NET/EF) · **elixir** (Phoenix
LiveView on plain Ecto/Phoenix) · **python** (FastAPI) · **java** (Spring Boot) · **react** /
**vue** / **svelte** (frontends).

## How this is prioritized

Loom's core promise is *"describe it once, generate a runnable stack on any
backend."* So the ranking rubric, in order:

1. **Parity-completion beats greenfield.** Closing the last-backend gap on a
   feature that already ships on N−1 backends is worth more than a brand-new
   capability axis — it's the difference between "pick any backend" being true
   and being leaky. These are also usually a *port of an existing pattern*, so
   they're tractable.
2. **Commonly-hit beats niche.** Tenancy, soft-delete, audit, and create/detail
   pages are bread-and-butter; an Orleans actor runtime is not.
3. **Silent-wrongness is already handled.** Almost every gap rejects cleanly at
   validation (`AdapterNotImplementedError` / a `loom.*-unsupported` diagnostic),
   so this backlog is about *unblocking specs*, not fixing live bugs. Urgency is
   value-driven, not bug-driven.
4. **Momentum: high-impact / low-effort first.** We're going one-by-one, so
   tractable parity wins are sequenced ahead of XL epics.
5. **Epics get decomposed.** Workflow execution and the reserved cross-cutting
   hooks are design-first tracks, not single tickets.

Effort: **S** (≤1 day) · **M** (a few days) · **L** (~1 week) · **XL** (epic,
decompose first). Impact: 1 (niche) – 5 (core promise).

---

## Master ranked table

| ID | Item | Target(s) to close | Impact | Effort | Existing plan |
|---|---|---|:--:|:--:|---|
| **P0 — parity completion, common, tractable** |
| DEBT-01 | ~~Principal-referencing capability `filter` (`currentUser` / tenancy)~~ **DONE** — all five backends (node, .NET, elixir Ash + vanilla, java) wire it, incl. java reified-criterion retrievals | ~~node, elixir, java~~ | 5 | L | `proposals/criterion-everywhere.md` · **fully landed on every backend** |
| DEBT-02 | ~~Non-relational (`shape(document/embedded)`) capability `filter`~~ **DONE** — node (both shapes) + java (both shapes) + elixir (`embedded`) + **python (both shapes, #1607)** all land (document → in-app over the rehydrated aggregate; embedded → root scalars are real columns, so SQL `where` / `@SQLRestriction`). elixir has no `document` shape (DEBT-07). principal-on-non-relational landed everywhere it applies (`supportsPrincipalNonRelationalFilter`: node/java/elixir/python `embedded`; node/java/**python** `document`; .NET all). Fully drained. | ~~node, java, elixir, python~~ | 4 | M | — |
| DEBT-03 | ~~Operation `or`-union return (exception-less ProblemDetails)~~ **DONE** | ~~elixir~~ | 4 | M | `exception-less.md` · return-dominant + `assign`/`precondition`/`requires`/`emit` **and ref-coll `add`/`remove`** all land on vanilla (the `add`/`remove` was a silent miscompile — missing `agg` in the returning-op render ctx — now persists via `put_assoc`, mirroring the non-returning path) |
| DEBT-04 | ~~Audit runtime parity~~ **DONE (2026-06-28 re-verified)** — audited **operations and lifecycle** (`create`/`destroy`) ship on all 5 backends. Grammar carries the `audited` slot on Create/Destroy (`ddd.langium:1505,1516`), lowering reads it (`lower-members.ts:266,282`), `AUDIT_OP_BACKENDS === AUDIT_LIFECYCLE_BACKENDS === {node,dotnet,java,python,elixir}`, and node emits the lifecycle audit row (`routes-builder.ts:455,597`). The earlier "vaporware / aspirational gate" finding was stale. `with audit` stamping ships via `contextStamps` (a separate, landed concern). | ~~elixir~~ | 4 | L | `type-system-feature-migration.md` (DBT) |
| DEBT-05 | React walker `List` / `Detail` / `For` primitives (comment-only today) — **DONE: `For` implemented (all 4 frontends + HEEx; now with an optional `empty:` arm); `List`/`Detail`/`MasterDetail` were inert duplicates of `scaffoldList`/`scaffoldDetails` and were REMOVED** ([D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)) | react (→ vue/svelte) | — | — | resolved |
| **P1 — parity + frontend completeness** |
| DEBT-06 | Provenanced fields (lineage SDK + trace capture) — **DONE on `foundation: vanilla`**: the `<App>.Provenance` SDK (process-buffer + transactional flush + `Json` Ecto type), co-located `<field>_provenance` column, inline named-op capture, and the `provenance_records` migration; gate un-blocks elixir-vanilla (ash stays gated, like ES storage). Ash foundation parity remains out of scope (no co-located-column fit). | elixir/vanilla | 3 | L | `provenance.md`, `type-system-feature-migration.md` DBT-1 |
| DEBT-07 | `shape(document)` persistence — **DONE (CRUD) on `foundation: vanilla`**: the `(id, data, version)` jsonb table + a schemaless-changeset validated fold (cast + required + invariants, the relational `base_changeset` contract) + a data-merge serialize; gate un-blocks elixir-vanilla (ash stays gated). Custom finds + named ops on a document aggregate are gated (`loom.vanilla-document-unsupported`) as a v1 follow-up. | elixir/vanilla | 3 | M | — |
| DEBT-08 | Generic carriers on the wire consumer — **`paged` DONE** (frontend hooks + DTO already ship); **`envelope` re-scoped**: not a frontend gap (backends disagree — Hono serves bare, .NET wraps `{id,ts,body}`) and *no live use case*, so deferred until a real event/message-transport need appears | ~~react, vue, svelte~~ (envelope: all backends) | 2 | M | `payload-transport-layer.md` P3b |
| DEBT-09 | ~~Non-constructible aggregates (omit the create surface)~~ **DONE** — the Phoenix backend drops the create action; the frontend scaffold drops the `<Agg>New` page + list "New" button when `!isConstructible` | elixir, react, vue, svelte | 3 | M | — |
| DEBT-10 | ~~Multi-segment / nested state mutation in page handlers~~ **DONE** — collection `+=`/`-=` now append/remove (was numeric `+`/`-` → broken list code); nested `:=` mutates in place on Vue/Svelte/Angular vs React's immutable spread | react, vue, svelte (+ angular) | 3 | M | — |
| DEBT-11 | ~~Vue workflow forms~~ **DONE** — structural render + error mapping already shipped; the success-toast parity (React/Svelte gap) now lands too | vue | 3 | M | `vue-frontend-plan.md` |
| DEBT-12 | Phoenix page DSL: `requires` guard, new-parts-in-body, `verify_token` | elixir | 2 | M | — |
| DEBT-13 | ~~Ordered `X id[]` reference collections~~ **WON'T DO (non-feature)** — ordering is a *read-time projection*, not a storage property of a set: a `X id[]` answers *which* ids belong; *what order* is a function of the reading context (same set orders differently in different views), so no single canonical order exists to persist. Domain ordering is modelled as an **explicit field** (`position`/`rank`) read via `sort:` on a `retrieval`/`find` — which already ships. Upholds `experience_gathered.md` §8.4. PR #1580 (elixir join `ordinal`) **closed won't-do**; the node/.NET/Java/Python join-`ordinal` persistence was questionable by the same reasoning and **was dropped** in #1590 (all backends now `ORDER BY` the target FK id, no stored `ordinal` on `X id[]` joins; value-object collections keep theirs — it's their PK). See `proposals/reference-collection-set-semantics.md` | ~~elixir, frontends~~ | — | — | `experience_gathered.md` §8.4 |
| **P2 — backend structural gaps + minimal-v1 adapter completion** |
| DEBT-14 | `hosts:` separate React bundle (only embedded `ui:` works) | java | 3 | L | `java-backend-implementation.md` |
| DEBT-15 | Part-declared single (non-collection) containments — 🟢 **DONE (java #1596, python — nested-parts Phase 2)**; node/.NET part-containment build-out **deferred follow-up** (see note) | java ✅ / python ✅ / node, dotnet ⛔ | 2 | M | `nested-parts-alignment.md` |
| DEBT-16 | ~~Audited *lifecycle* actions (`audited create`/`destroy`)~~ **DONE (2026-06-28 re-verified)** — the "no grammar slot" block never existed on fresh `main`: `Create`/`Destroy` carry `(audited?='audited')?` (`ddd.langium:1505,1516`), lowering reads it (not hardcoded `false`), and all 5 backends emit the lifecycle audit row. Folded into DEBT-04. | ~~grammar, dotnet, java, node~~ | 2 | M | — |
| DEBT-17 | MikroORM v1 → full surface — **retrievals landed (#1611)**; assoc, inheritance, nested parts, non-relational, capability filters still gated | node | 3 | L | `retrieval-implementation.md` |
| DEBT-18 | Dapper v1 → full surface (find/retrieval predicate + same set) | dotnet | 2 | L | — |
| DEBT-19 | ~~TPH inheritance (`inheritanceUsing(sharedTable)`)~~ **DONE (stale entry)** — the validator's `TPH_CAPABLE` set is `{node, dotnet, elixir, python, java}` (all DB backends), so a TPH hierarchy is accepted on every backend; emission ships (Hono shared table + `kind`, .NET EF `HasDiscriminator`, Ash shared-table + `base_filter`). Verified 2026-06-19 | ~~dotnet, elixir, python, java~~ | 3 | L | `tph-unionall-and-contains.md` |
| DEBT-20 | ~~Event-sourced storage (`persistedAs(eventLog)`) adapter alignment~~ **DONE** — ES ships on node/dotnet/java/elixir-vanilla; this closed the *adapter* misalignment: every `eventLog` **default** now resolves to a real adapter (not the `axon`/`marten` stubs / state-only `ashPostgres`), and `ecto` declares the `eventLog` strategy it emits | ~~elixir, java~~ | 3 | L | `elixir-eventsourcing-vanilla-plan.md` |
| **P3 — reserved adapter un-stubbing (greenfield axes, by demand) + half-landed** |
| DEBT-21 | Application styles: `cqrs` (node/java), `layered`/`flat` (dotnet), `flat` (node) | node, dotnet, java | 2 | L | `realization-axes-rollout.md` |
| DEBT-22 | Transports: `express`/`fastify` (node), `minimalApi` (dotnet) | node, dotnet | 2 | L | `realization-axes-rollout.md` |
| DEBT-23 | Event-store persistence adapters: `marten` (dotnet), `axon` (java), `jooq` (java) | dotnet, java | 2 | L | `realization-axes-rollout.md` |
| DEBT-24 | Reified `criterion` specs: query face + rewire invariants/preconditions, other backends | dotnet (then all) | 2 | L | `criterion.md` |
| DEBT-25 | Actor/worker runtimes: `worker` (node), `orleans` (dotnet), `genserver` (elixir) | node, dotnet, elixir | 1 | XL | `realization-axes-alignment.md` |
| **P4 — epics & universal "not yet anywhere" (design-first)** |
| DEBT-26 | **Workflow execution & persistence** (persisted row, IR fields unconsumed) | all backends | 4 | XL | `workflow-choreographer-seam.md`, `workflow.md` |
| DEBT-27 | `PlatformSurface` reserved hooks (authGate, auditInit, compliance, tenancy, i18n) | all backends | 3 | XL | `proposals/*` (per hook) |
| DEBT-28 | `loads:` eager-load specs + pagination on `find all` — **re-scoped 2026-06-29**: pagination already ships (`paged`-return + retrieval call-site `page`); real gaps are (a) the implicit `find all()` is unbounded, (b) `loads:` cross-aggregate eager-fetch (v2). `loads:` on owned containments is a *deliberate* no-op (wireShape parity) | all backends | 2 | L | `proposals/pagination-design-note.md` |
| DEBT-29 | Joined view sources + per-view parameters not emitted | all backends | 2 | M | `views.md` |
| DEBT-30 | Misc IR-consumed-nowhere: seed create-shape validation, side-effecting-call metadata, block-body lambdas in e2e, method-call hooks binding | varies | 1 | S–M | — |
| DEBT-31 | ~~Inline collection-op lambdas on Phoenix/HEEx~~ **DONE** — `filter`/`map` now route to `Enum.filter/2`/`Enum.map/2` (was: lambda hoisted to a `handle_event`, invalid `recv.filter(…)` chain). `sortBy` dropped from scope — it's a non-native JS method with no runtime helper, so it's unsupported on the JS frontends too (no parity target) | elixir | 2 | M | — |
| DEBT-32 | **Vanilla (Ecto) nested entity parts** — **`shape(embedded)` DONE**: each part → an Ecto `embedded_schema` module the root `embeds_many`s (inline jsonb, the same `:map` column Ash uses); a containment-mutating op (`lines += Line{…}`) appends the struct + `put_embed`s; create/read round-trip (the embedded containment migration column is now nullable so an empty embed reads back as `[]`). **Verified against real Postgres** (create→addLine→read) + `mix compile`. Remaining: **relational-shape** containments (child tables + `has_many` + `cast_assoc`) stay gated (`loom.vanilla-containment-unsupported` now points at `shape(embedded)`). | ~~elixir/vanilla (embedded)~~ · relational | 3 | M | — |

---

## P0 — do these first

### DEBT-01 · Principal-referencing capability filters
- **Where:** `src/ir/validate/checks/system-checks.ts` (`validateContextFilterSupport`); diagnostic `loom.context-filter-unsupported`.
- **Today (DONE — every backend):** **.NET** (EF `HasQueryFilter`), **node** (Hono/Drizzle, ambient `requireCurrentUser()`), **elixir/Ash** (`base_filter` + `^actor`), **elixir/vanilla** (Ecto `where` with `^(current_user && current_user.f)` + threaded `current_user`) and **java** (Spring Data `@Query` AND-ing a SpEL-principal clause `:#{@currentUserAccessor.user()?.f()}` into findAll/findById/finds/views) all wire `filter this.tenantId == currentUser.tenantId`.
- **Why P0:** multi-tenancy and `currentUser`-scoped reads are core line-of-business needs.
- **Node slice (landed):** the principal predicate is AND-ed into every root read, rendered against the ambient `requireCurrentUser()` accessor (`auth/middleware.ts`) — the Drizzle analogue of EF Core reading `RequestContext.Current` inside `HasQueryFilter`, so **no read method gains a `currentUser` parameter**. `lowerToDrizzle` takes a `principalAccessor` option (`repository-find-predicate.ts`); `aggregateUsesPrincipalContextFilter` (`loom-ir.ts`) drives the `requireCurrentUser` import. A principal filter now requires the deployable to set `auth: required` (validated, mirroring `validateJavaStampSupport`). Verified end-to-end: the generated project `tsc --noEmit`s clean (fixture `test/e2e/fixtures/ts-build/tenancy-filter.ddd`, wired into `build-generated-ts`).
- **elixir/Ash slice (landed):** `renderBaseFilter` (`domain-emit.ts`) now keeps the principal predicate and rewrites the `current_user.<field>` member access to `^actor(:<field>)` — Ash's request-actor template — so it emits `base_filter expr(tenant_id == ^actor(:tenant_id))`. For the template to resolve, every read runs with `actor: current_user` (the JWT principal on `conn.assigns.current_user`): threaded into the CRUD controller reads (list/get/update/destroy + finds, `api-emit.ts`) and the context-view `Ash.read!` (`view-emit.ts`), all conditional on `aggregateUsesPrincipalContextFilter` so non-tenancy output stays byte-identical. The gate is now foundation-aware (`foundation: ash` allowed; `vanilla` still rejected). Fixture `test/e2e/fixtures/phoenix-build/tenancy-filter.ddd`, wired into the `elixir-ash-build` gate.
  - *Retrieval / returning-op threading (landed):* the two read paths the first slice deferred are now actor-threaded too — a context **retrieval** invoked from a workflow `Repo.run` (`run_<ret>_<agg>!(..., actor: current_user)`, `workflow-emit.ts`) and an **`or`-union returning op** (`Ash.get(__MODULE__, id, actor: context.actor)` in the generic action + `actor: conn.assigns.current_user` on the controller call, `operation-returns-ash-emit.ts`). Fixture `test/e2e/fixtures/phoenix-build/tenancy-ops.ddd`. (These were always fail-closed — a nil actor yields no rows, never a cross-tenant leak — but now read correctly.)
  - *elixir-vanilla non-principal filters (landed):* plain Ecto had **no** capability-filter emission at all — a `filter !this.isDeleted` on a vanilla deployable was *silently dropped* (reads returned deleted rows). Now AND-ed into every root read (`list/0`, `find_by_id/1`, custom finds, retrievals, views) via `from(record in <Agg>, where: …)` — `src/generator/elixir/vanilla/capability-filter.ts`. The prerequisite for vanilla tenancy.
  - *elixir-vanilla principal/tenancy (landed):* `current_user` is threaded from `conn.assigns` (the foundation-agnostic Auth plug, now emitted + router-spliced on vanilla too) through the read seam (repository `list`/`find_by_id`/finds gain a `current_user \\ nil` arg; the controller passes `conn.assigns.current_user`; retrievals read `opts[:current_user]`; views use the existing `run/1` arg) and pinned in the Ecto `where:` as `^(current_user && current_user.tenant_id)` — a nil actor scopes to no rows (fail-closed). Only **principal** aggregates gain the arg; everything else stays byte-identical. Fixture `vanilla-tenancy.ddd`.
  - *java (landed):* `@SQLRestriction` is static SQL with no runtime principal, so the principal predicate AND-s a Spring Data SpEL clause (`:#{@currentUserAccessor.user()?.tenantId()}` — the JPA analogue of node's `requireCurrentUser()`, fail-closed via `?.`) into every find/retrieval/view + the re-declared scoped `findAll`/`findById` overrides; non-principal filters keep riding `@SQLRestriction`. Fixture `java-build/tenancy-filter.ddd`. A *reified* `criterion` retrieval (reads via `JpaSpecificationExecutor.findAll(spec)`, bypassing the `@Query` overrides) is scoped too — the principal filter is AND-ed in as a `tenantScope(User)` `Specification` factory on `<Agg>Criteria`, composed onto the criterion spec in the repo impl (which gains an injected `CurrentUserAccessor`); fixture `java-build/tenancy-reified.ddd`.

### DEBT-02 · Non-relational capability filters — DONE
- **Where:** same gate as DEBT-01 (the `shape(document/embedded)` branch of `validateContextFilterSupport`).
- **Landed:** non-relational capability filters now emit on every backend that has the shape — **node, java, python** (both `embedded` and `document`), **elixir** (`embedded` only — it has no `document` shape), **.NET** (all). The `embedded` case AND-s the predicate into the SQL read (root scalars are real columns); the `document` case evaluates it IN-APP over the rehydrated aggregate (`documentCapabilityBody` on node/python; `.stream().filter` on java), since the jsonb blob isn't per-field queryable. The principal × non-relational intersection landed alongside (the actor binds via the ambient accessor — `requireCurrentUser()` / `require_current_user()` / the `CurrentUserAccessor` bean).
- **python slice (#1607):** `documentCapabilityBody(agg, varName, bypass?)` renders the `contextFilters` as a Python boolean expr over the rehydrated instance, woven into `find_by_id` (gate → `None`), `all()`, `find_many_by_ids`, and custom finds (raw load + AND-ed with the find's own `where`, so `ignoring` can drop a conjunct). Build-gated by `python-build/document-tenancy.ddd` (ruff + mypy --strict).

### DEBT-03 · Operation `or`-union return on Elixir/Ash
- **Where:** `src/ir/validate/checks/structural-checks.ts:504` (`validateOperationReturnsUnimplemented`); ships on node/dotnet/python/java **and elixir `foundation: vanilla`** — only **elixir/ash** was gated.
- **Why P0:** N−1 backends ship it; closing one foundation restores full parity. The vanilla `{:ok,_} | {:error, tag, data}` carrier is the reference ported to Ash.
- **Slice 1 (landed):** *return-dominant* ops (body is only `return`/`let`) emit as an Ash 3.x **generic action** (`action :<op>, :term do … run fn input, _ctx -> {:ok, tagged} end end`) that loads the record via `Ash.get(__MODULE__, id)` and hands back a tagged term; the controller translates it (success → 200, error variant → `problem_variant/5` ProblemDetails, absent record → 404). Emitter: `src/generator/elixir/operation-returns-ash-emit.ts`. Shared predicate `isReturnDominantOp` (`src/ir/util/operation-returns.ts`) keeps the validator gate and generator in lock-step. Real-Ash compile verified by the `elixir-ash-build` CI job (fixture `test/e2e/fixtures/phoenix-build/operation-returns.ddd`).
- **Slice 2 (landed):** *in-memory* mutation-then-return — `assign` struct-updates the loaded record in place (`%{record | f: …}`, the success fall-through serialises it) — plus `precondition`/`requires` guards (raise). Predicate broadened to `isAshReturningOpEmittable`. Fixture `operation-returns-body.ddd`.
- **Slice 3 (landed):** `emit` — renders the same `Phoenix.PubSub.broadcast(%Ctx.Events.Name{…})` the regular Ash op body / workflow emits (no persistence, so it fits the in-memory run fn; the per-context Dispatcher consumes it). Fixture `operation-returns-emit.ddd`.
- **Follow-up — DONE on vanilla (the slices above are Ash-era history):** `add`/`remove` of a ref-collection (`X id[]` → `many_to_many`) inside a returning op. There was **no validator gate** (the "targeted hint / `manage_relationship` / generic-action bridge" framing was Ash-era fiction — none of it survived the Ash removal); it was a **silent miscompile** on vanilla: `renderReturningOpFunction` (`src/generator/elixir/vanilla/operation-returns-emit.ts`) omitted the enriched `agg` from its render context (which the non-returning `renderNamedOpFunction` sets), so `members += t` fell through to the containment-jsonb branch and the success tail returned an in-memory projection with no join-table write. Fix: thread `agg`, persist the success tail via a `put_assoc` changeset + `persist_change` when the body mutates a ref-collection, and project the ref-coll wire field through `__ref_id_list/1` — byte-mirroring the non-returning path. Fixture `test/e2e/fixtures/elixir-vanilla-build/vanilla-returns-ref-coll.ddd` (compiles under `mix compile --warnings-as-errors`).

### DEBT-04 · Audit runtime parity — DONE (re-verified 2026-06-28)
- **Where:** `validateAuditedOperationSupport` — `AUDIT_OP_BACKENDS === AUDIT_LIFECYCLE_BACKENDS === {node, dotnet, java, python, elixir}` (`src/ir/validate/checks/system-checks.ts`).
- **History:** the 2026-06-19 pass recorded this as RE-SCOPED, splitting it into "elixir-greenfield audit ops", "vaporware lifecycle (→ DEBT-16, grammar-blocked)", and "vanilla stamping". The 2026-06-28 swarm re-verification against fresh `main` found **all three have landed** — the "vaporware/grammar-blocked" framing was already stale (likely pre-#1503):
  1. **`audited` operations** (`operation foo() audited`) — ships on all 5 backends (audit-record append in the save transaction). elixir is no longer the gap (`src/generator/elixir/vanilla/audit-emit.ts`).
  2. **`audited` lifecycle** (`audited create`/`destroy`) — **REAL, not vaporware.** The grammar carries the slot on *both* `Create` and `Destroy` (`ddd.langium:1505,1516` — `(audited?='audited')?`); `lowerCreate`/`lowerDestroy` read it (`lower-members.ts:266,282` — `c.audited ?? false`/`d.audited ?? false`, **not** hardcoded); and node **emits the lifecycle audit row** in one transaction with the save (`src/platform/hono/v4/routes-builder.ts:455` create with `before:null`/`after`=wire; `:597` destroy with `before`=wire/`after:null`). elixir vanilla emits it too (`audit-emit.ts` lists `create(...) audited` / `destroy audited`).
  3. **`with audit` stamping** (`contextStamps`) — ships via `contextStamps` (a separate, landed concern).
- **Net:** DEBT-04 (and DEBT-16, which was waiting on the non-existent grammar block) are **DONE**.

### DEBT-05 · React walker `List` / `Detail` / `For` primitives — DONE
- **Was:** `List`/`Detail`/`MasterDetail`/`For` were registered + source-admissible but rendered only as `// X: not supported by the React walker yet` — common page primitives silently degrading to comments.
- **`For` — DONE.** The `For { each:, item => markup }` comprehension now renders on all four frontends via a new `renderForEach` target seam: TSX keyed `.map`/`<Fragment>`, Vue `<template v-for :key>`, Svelte keyed `{#each}`, plus a Phoenix `for … do … end` block (`heex-primitives.ts:renderFor`). It's a child primitive (stays in `NON_PAGE_BODY_LAYOUT_PRIMITIVES`); list key is the loop index (a source-level `key:` is grammar-unwritable next to a brace-body item lambda, so the seam takes a `keyExpr` for programmatic/future use only).
- **`List` / `Detail` / `MasterDetail` — REMOVED (not implemented).** Investigation showed they were inert: `admissibleInSource` but with no renderer and no expander arm, so they parsed/validated then dead-ended to a comment. They duplicated the working, hand-writable, embeddable `scaffoldList`/`scaffoldDetails` sentinels (which *do* have a phase-⑤c expander). No capability was lost by deleting them — embedding a list in a custom page is `scaffoldList { of: T }`. Decision pinned at [D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes); examples switched to the scaffold sentinels. The residual "scaffold expansion is opaque ⑤c magic, could emit unfoldable named components" idea survives as an OPEN note in `../proposals/unfoldable-page-scaffolding.md` (about the sentinels themselves, not the deleted archetypes).

---

## P1 — parity & frontend completeness

Concise scope per item; full gate locations in the table above.

- **DEBT-06 Provenanced (elixir): DONE on `foundation: vanilla`.** Ported the node/dotnet lineage SDK to plain Ecto — `<App>.Provenance` (process-dictionary trace buffer + `flush/1` + the pass-through `Json` Ecto type + the `Record` schema), the co-located `<field>_provenance` jsonb column, inline lineage capture at each named-op write site, and a `provenance_records` flush inside the save `Repo.transaction` (governance-stamped from `RequestContext`). The gate `loom.provenanced-backend-unsupported` is now foundation-shaped: vanilla un-gates, ash stays gated (no co-located-column fit, mirroring ES storage). Capture covers named (persisting) operations. `ddd snapshot` already ran across all backends. Compiled in CI by `elixir-vanilla-build.yml` (`vanilla-provenance.ddd`).
- **DEBT-07 `shape(document)` (elixir): DONE (CRUD) on `foundation: vanilla`.** The vanilla generator now emits the document path — an `(id, data, version)` Ecto schema over the canonical document table (migrations-builder already produced it), a **schemaless** changeset (`cast({%{}, @types}, attrs, …)` + `validate_required` + the invariant validators the relational `base_changeset` runs) whose validated map IS the stored jsonb `data`, a CRUD repository (validated fold on insert; merge-revalidate-bump on update; `Repo.delete`/`get`/`all`), and a data-merge `serialize/1` (the relational `Map.from_struct` swapped). The gate `loom.saving-shape-unsupported` is foundation-shaped (vanilla un-gates document; ash stays on relational/embedded — no idiomatic Ash `:map` fit). Custom finds (need an in-memory rehydrate-and-filter) and user-defined named ops (struct-update flattened columns the document schema lacks) on a document aggregate are gated (`loom.vanilla-document-unsupported`) rather than misgenerated — the v1 follow-up. Compiled in CI by `elixir-vanilla-build.yml` (`vanilla-document.ddd`). The Ash single-opaque-`:map` path stays unbuilt.
- **DEBT-08 Generic carriers — re-scoped after investigation:** `paged` is **already done** end-to-end — the frontend api-module emits the `<Agg>Paged` DTO + a `useRecent…(query)` hook with `page`/`pageSize` and query-key caching (per `pagination-design-note.md`'s frontend scope); the rendered *pager control* is explicitly deferred there. `envelope` is **not a frontend-consumer gap**: the backends don't agree on the wire shape (Hono's route serves the bare `<Agg>Response`; .NET's repo returns `Envelope<T>` = `{id, ts, body}`), so there's no stable contract to unwrap — and **no example/test/parity case uses it**. It was added for completeness alongside `paged` when the carrier mechanism landed, but has no live consumer. Deferred: revisit only when a real event/message-transport need appears (then it's a *cross-backend alignment* job, not a frontend slice). Gate `loom.generic-carrier-unsupported` stays for unsupported *backends*.
- **DEBT-09 Non-constructible aggregates (elixir + frontends) — DONE:** an aggregate with no create surface (`!isConstructible` — no explicit/`crudish` create and an invariant the create input can't satisfy) no longer gets a create surface on Phoenix/Ash or the frontends, matching the Hono/.NET/Python/Java backends. Phoenix: `domain/actions.ts` drops the default `:create` action (was Ash all-CRUD). Frontends: `dropNonConstructibleNewPages` (lower.ts) removes the scaffolded `<Agg>New` page — so the router + menu (derived from `ui.pages`) follow — and `expandScaffoldList` (walker-primitive-expander) suppresses the list "New" button, so no link dangles. All gated on the shared `isConstructible` predicate; the read/detail/operation surfaces are untouched.
- **DEBT-10 Nested state mutation (frontends) — DONE:** two fixes in `walker-core.ts` `emitStmt`/`stateWrite`. (1) **Collection `+=`/`-=`** — `parent.items += x` was rendered as numeric `items + x` (broken: `[] - v` → `NaN`); now type-driven append/remove (`[...items, x]` / `items.filter(e => e !== x)`), the signal carried on the `add`/`remove` IR (`collection` flag from the lowered target type). (2) **Nested `:=`** — `addr.zip := v` keeps React's immutable spread but now diverges per target via a new `renderNestedStateWrite` seam: Vue refs / Svelte `$state` / Angular signals mutate in their native idiom (in-place for Vue/Svelte, `set` for Angular signals).
- **DEBT-11 Vue workflow forms — DONE:** the structural workflow form (fields, typed defaults, submit, navigate) and server/validation error mapping (`useLoomForm` → inline field + `__global` alert) were already shipped; the remaining React/Svelte gap was the **success toast**. The Vue packs' `form-default-onsubmit` now `pushToast(...)`s on completion, and the toast queue + app-shell host are gated on `realtime || forms` (`vue/index.ts` `hasToastHost`) so a form-only project still mounts a host.
- **DEBT-12 Phoenix page DSL:** `requires` guard (v0 bind-only → full `handle_params/3`), new-parts-in-body stub, `verify_token/1` auth helper.
- **DEBT-13 Ordered ref collections — WON'T DO (non-feature).** Ordering a `X id[]` is a read-time projection, not a property of the set — the same ids order differently per reading context, so there is no single canonical order to store. When order is domain data it's an explicit `position`/`rank` field read via `sort:` on a `retrieval`/`find` (already supported); a `X id[]` stays a set (`experience_gathered.md` §8.4). The "first-class ordered editor on frontends" would reify a contract the language intentionally doesn't offer — dropped. The elixir join-`ordinal` PR (#1580) was **closed won't-do**; the four backends (node/.NET/Java/Python) that already persisted a join `ordinal` were questionable by the same reasoning and **#1590 dropped it** — all backends now `ORDER BY` the target FK id with no stored ordinal on `X id[]` joins (value-object collections keep their ordinal — it's the PK). Recorded in `proposals/reference-collection-set-semantics.md`. (The old "Ash `manage_relationship` ordinal injection" framing was stale Ash fiction.)
- **DEBT-31 Inline collection ops on Phoenix/HEEx — DONE:** expression-position lambda callbacks (`xs.filter(o => …)`, `.map`) render on the JS frontends via the shared `emitExpr` (native `Array.prototype` methods). HEEx's parallel engine (`heex-walker-core.ts`) used to hoist the callback into a `handle_event` clause and emit an invalid `recv.filter(event_N)` chain — because `filter`/`map` aren't in the shared `isCollectionOp` catalogue. `renderMethodCall` now routes a `filter`/`map`/`select` method-call with a lambda arg to `renderCollectionOp` (whose `Enum.filter/2` / `Enum.map/2` arms already existed but were unreachable). **`sortBy` was dropped:** it's not a native JS array method and has no runtime helper, so it's broken on the JS frontends too (`xs.sortBy(...)` → a non-existent method) — there's no parity target to mirror. A real `sortBy` is a separate cross-frontend feature (JS runtime helper + `Enum.sort_by/2` + catalogue/type-system entry).

---

## P2 — backend structural gaps & minimal-v1 adapters

- **DEBT-14 Java `hosts:`** — host a separately-declared react deployable's bundle (only embedded `ui:` works today). `system-checks.ts:491`, `loom.java-fullstack-unsupported`.
- **DEBT-15 Java nested part-containments — DONE (java).** A nested part (`Shipment contains label: Label`, single or collection) now FKs to its **direct parent** (`labels.shipment_id`), not the aggregate root — via `directParentOf` (`src/ir/util/containment-parent.ts`), shared by `migrations-builder.ts` and the java emitter so the JPA join column and the Flyway DDL agree. Boot-verified end-to-end on Postgres (Flyway migrate → SQL-insert a two-level graph → GET nests `label`+`stickers` under the right `shipment`). The gate (`loom.java-single-containment-unsupported`) is gone. **This is Phase 1 of [`nested-parts-alignment.md`](nested-parts-alignment.md)** and the DEBT-15 **deliverable**. Phase-2 scoping then found the cross-backend "alignment" is far larger than the plan implied: node never saves single containments and never loads nested parts; python hard-codes the nested level empty (`label=None, stickers=[]`, with `_hydrate_*` helpers as dead code). So node/python/.NET part-containment was **substantially unimplemented**, not merely mis-FK'd — building it out is a real per-backend feature. **python landed** (nested-parts-alignment Phase 2): nested parts FK to (and brand `parent_id` from) their direct parent, `save` recurses (diff-sync per nested level), `_hydrate_<part>` loads nested children, parts emit children-first (no forward-ref), boot-verified on real Postgres. **node + .NET remain deferred** (no example uses part-in-part on those backends; python is the reference port). Re-scoped details + decision in `nested-parts-alignment.md`.
- **DEBT-16 Audited lifecycle — DONE (re-verified 2026-06-28):** `audited create`/`destroy` instrumentation ships on all 5 backends; the grammar slot it was "blocked" on exists (`ddd.langium:1505,1516`) and lowering reads it. Folded into DEBT-04.
- **DEBT-17 / DEBT-18 MikroORM & Dapper v1 → full surface** — both started from the same reject set (retrieval bundles, seed, event-sourced, non-relational, inheritance, `Id[]` associations, nested parts, audit stamping, capability filters, provenanced, managed access) and throw on complex find predicates (`emit/mikroorm.ts`, `emit/dapper.ts`). Closing incrementally toward the default-adapter surface: **both now ship `retrieval`s** (Dapper #DEBT-18; MikroORM #1611 — `run<Name>` methods with where/sort/page); event-sourcing + audit stamping also already land on MikroORM. Remaining on both: associations, inheritance, nested parts, non-relational shapes, capability filters.
- **DEBT-19 TPH inheritance — DONE (stale):** `inheritanceUsing(sharedTable)` emission already ships on every DB backend — `validateInheritanceStorage`'s `TPH_CAPABLE = {node, dotnet, elixir, python, java}` accepts a TPH hierarchy on any of them (Hono Drizzle shared table + `kind` discriminator; .NET EF Core `HasDiscriminator`; Phoenix shared-table multi-resource + filter on `kind`). The "beyond node" framing was stale.
- **DEBT-20 ES adapter alignment — DONE:** the latent misalignment is fixed — every backend's `eventLog` **default** resolves to a real adapter that actually emits the store (java `axon`→`jpa`, dotnet `marten`→`efcore`, elixir `ashPostgres`→`ecto`; node already used `drizzle`), and elixir's `ecto` adapter now declares `["state","eventLog"]` to match the vanilla event-sourced emit it drives. A `registry-lookup` invariant pins "default eventLog adapter is real & advertises eventLog" so a default can't regress to a stub. The idiomatic event-store stubs (`marten`/`axon`/`jooq`) remain reserved under DEBT-23.

---

## P3 — reserved adapter un-stubbing & half-landed work

All adapter stubs are declared in each platform's `adapters()` menu via
`stubAdapter(...)` and rejected at validation — see `realization-axes-rollout.md`
for the rollout order. Un-stub by demand: **styles** (DEBT-21) and **transports**
(DEBT-22) before **event-store persistence** (DEBT-23) before **actor/worker
runtimes** (DEBT-25, lowest demand). DEBT-24 finishes the reified-criteria slice
(query face + rewiring invariants onto specs, then other backends).

Full stub inventory:

| Target | Persistence | Style | Transport | Runtime |
|---|---|---|---|---|
| node | — | `cqrs`, `flat` | `express`, `fastify` | `worker` |
| dotnet | `marten` | `layered`, `flat` | `minimalApi` | `orleans` |
| java | `jooq`, `axon` | `cqrs` | — | — |
| elixir | — | — | — | `genserver` |
| python | *(no realization-axes menu — thin single-impl wiring)* | | | |

---

## P4 — epics & universal gaps (design-first)

### DEBT-26 · Workflow execution & persistence — strategic epic
The largest cross-cutting unfinished area, but **narrower than the original
framing** (re-verified 2026-06-28): `workflow` blocks parse and lower, instance
**visibility** ships on all 5 backends, and the persisted workflow-state **row IS
emitted** on java/.NET/elixir-vanilla (`workflow-state-emit.ts` /
`workflow-instances-emit.ts`), with the IR fields (`stateFields`,
`correlationField`, `instanceWireShape`) **consumed** by those emitters — the old
"IR carries fields no backend consumes / row never emitted" note was stale. The
genuine remainder is the **step-execution choreography** (the choreographer seam)
plus **persistence on node/python**, and frontend workflow forms are open
(DEBT-11). **Recommend a design spike** (`workflow-choreographer-seam.md`) to
decompose into: (a) node/python persisted-row parity, (b) per-backend step
execution, (c) frontend workflow forms, before scheduling slices.

### DEBT-27 · PlatformSurface reserved hooks
`emitAuthGate` / `emitAuditInit` / `emitCompliancePolicy` / `emitTenancyFilter` /
`emitI18nAdapter` (+ the `ComposeServiceShape` slots `auditSidecar` /
`policyInitCmd` / `i18nCatalogDir`) are defined but **undefined on every
backend** (`src/platform/surface.ts`). Each has its own proposal; filling one
lands that concern's adapter for that backend. DEBT-01 (tenancy filter) and
DEBT-04 (audit) overlap these — coordinate so we don't build the same plumbing twice.

### DEBT-28–30 · Universal "not yet anywhere"
Not platform-gated — bounded language gaps.

**DEBT-28 (re-scoped 2026-06-29 after a fresh-`main` audit):** the "`find
all(skip, take)` pagination grammar-gated" framing was **stale**. Pagination is
a *deliberate* call-site design (`ddd.langium` documents it), and two surfaces
already ship: the `paged` return type (`find x(): T paged` → `Paged<T>`, on
Hono/EF/Phoenix + React hooks, per `proposals/pagination-design-note.md`) and a
retrieval call-site `page` arg (`Repo.run(R(args), page?)`). The one real
remaining pagination gap is that the **auto-synthesised implicit `find all()`
is unbounded** (`ensureFindAll` in `enrich/enrichments.ts` emits `all(): T[]`
with no `page`) — bounding it is a list-endpoint wire/design change across all 5
backends + the frontend list hooks. For `loads:`: it lowers to `loadPlan` but is
a **deliberate no-op** on node/.NET (owned containments are part of the
parity-enforced `wireShape`, so an explicit `loads:` can neither widen nor narrow
them — see the documented comments in `repository-find-builder.ts` /
`dotnet/emit/repository.ts`; java/python don't emit retrievals yet). The
genuinely-unconsumed slice is **cross-aggregate eager-fetch**
(`self.lines[].product`), an explicit v2 hydration concern.

**DEBT-29 / DEBT-30:** joined view sources / per-view params (DEBT-29); and the
small IR-consumed-nowhere tail (DEBT-30): seed create-shape validation
(`typescript/emit/seed.ts:20`), side-effecting-call metadata (`loom-ir.ts:343`),
block-body lambdas in UI e2e tests (`ui-e2e-render.ts`), method-call hooks
binding in page handlers (`walker-core.ts:1021` — **likely stale/mislabeled**, no
such IR field found).

---

## Recommended first five

Sequenced for parity impact and momentum (all are ports of an existing pattern,
none require a design spike):

1. ~~**DEBT-03** — operation `or`-union return on Elixir/Ash~~ — **slice 1 done** (return-dominant ops; mutation/guard follow-up remains).
2. ~~**DEBT-05** — React `List`/`Detail`/`For` primitives~~ — **done**: `For` implemented (all 4 frontends + HEEx, with an optional `empty:` arm); `List`/`Detail`/`MasterDetail` removed as inert duplicates ([D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)).
3. **DEBT-01** — principal-referencing filters on node (then elixir, java) — highest demand.
4. **DEBT-02** — non-relational filters (rides on DEBT-01's plumbing).
5. ~~**DEBT-04** — audit runtime parity~~ — **DONE** (ops + lifecycle ship on all 5 backends; re-verified 2026-06-28).

When we pick one up, spin its row into a focused slice plan under `docs/plans/`
and link it back here.
