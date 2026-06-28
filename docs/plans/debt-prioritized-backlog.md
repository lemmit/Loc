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
which cover the full five-backend / five-frontend roster. (The older
[`gated-features-inventory.md`](../audits/gated-features-inventory.md), snapshot
2026-06-03, is superseded — it predates the Java/Python/Vue/Svelte/Angular
targets.) When a cited file disagrees with any doc, the **code wins**.

---

## Code-verified audit pass (2026-06-19)

Every open entry was checked **against the actual validator gates / generator
emitters** (not the prose). Headline: the **backend & adapter tier (DEBT-02,
03, 06, 07, 13, 14, 15, 17, 20–25, 27–29) is accurate** — those gaps are
genuinely gated (`loom.*-unsupported`) or stubbed (`AdapterNotImplementedError`).
The **stale/over-stated entries were the frontend & "aspirational completeness"
ones** — corrected this session: DEBT-08 (paged done, envelope no-live-use),
DEBT-19 (TPH ships on all 5 backends), DEBT-04 lifecycle (vaporware → DEBT-16
grammar-blocked), DEBT-12 (`requires` guard already ships; new-parts-in-body is
an unreachable stub), DEBT-31 (sortBy dropped). Per-entry verdicts:

| ID | Verified | Note |
|---|---|---|
| 01 | ✅ DONE | tenancy filter on all 5 backends |
| 02 | 🟡 OPEN (partial) | node + java + elixir non-relational `filter` ship (java/node both shapes; elixir `embedded` — its only non-rel shape); only **principal-on-non-relational** gated everywhere |
| 03 | 🟡 OPEN (**narrowed**) | Elixir union returns ship for return/let, **in-memory `assign` mutation, `precondition`/`requires` guards, and `emit`** (PubSub broadcast); only **`add`/`remove`** bodies remain a follow-up. (Detail below is pre-Ash-removal — Ash foundation removed; single elixir backend is plain Ecto/Phoenix now.) |
| 04 | ⚠️ RE-SCOPED | elixir audit-ops = real greenfield; lifecycle = vaporware (→16) |
| 05 | ✅ DONE | `For` shipped; List/Detail removed |
| 06 | ✅ DONE | Provenance runtime shipped on the elixir backend (#1400). (Was foundation-aware vanilla-only; Ash foundation removed, so it's just the elixir backend now.) |
| 07 | 🟢 DONE (CRUD) | elixir emits `shape(document)` (#1403) — `(id, data, version)` jsonb + schemaless-changeset fold |
| 08 | ✅/⚠️ | paged done; envelope deferred (no live use) |
| 09–11 | ✅ DONE | this session |
| 12 | ✅ mostly DONE | `requires` guard ships (handle_params); new-parts unreachable; verify_token niche |
| 13 | 🟢 DONE (read+write order) | elixir `X id[]` now round-trips in order — the join migration's `ordinal` column is stamped on write (`Repo.update_all` from id-list index) + ordered on read (`preload_order` → join `ordinal`); matches node (#1580). Follow-up: named-op incremental `+=`/`-=` ordinal stamping (membership preserved, ordering deferred) |
| 14 | 🔴 OPEN | java `hosts:` → `loom.java-fullstack-unsupported` |
| 15 | 🔴 OPEN | java nested-part single containments → `loom.java-single-containment-unsupported` |
| 16 | ⛔ BLOCKED | grammar has no `audited` slot on Create/Destroy |
| 17 | 🟡 OPEN (partial) | MikroORM real adapter, v1-minimal (retrievals/assoc/inheritance stubbed) |
| 18 | 🟡 OPEN (partial, **narrowed**) | Dapper **retrievals now ship**; only out-of-subset predicates stub (`NotImplementedException`) |
| 19 | ✅ DONE | TPH on all 5 DB backends |
| 20 | ✅ DONE (default/decl alignment) | every backend's eventLog **default now resolves to a REAL adapter** (java `axon`→`jpa`, dotnet `marten`→`efcore`, elixir `ashPostgres`→`ecto`, matching node's `drizzle`); **ecto now declares `["state","eventLog"]`** (it drives the vanilla ES emit). ES strategy itself ships on node/dotnet/java/elixir-vanilla; the marten/axon **event-store stubs** remain (DEBT-23) |
| 21 | 🟡 OPEN (partial) | one real app-`style:` per backend (dotnet=cqrs, node/java=layered); rest reserved stubs |
| 22 | 🟡 OPEN (partial) | one real `transport:` per backend (node=hono, dotnet=controllers); express/fastify/minimalApi stubbed |
| 23 | 🔴 OPEN | marten/axon/jooq all `AdapterNotImplementedError` stubs |
| 24 | 🟡 OPEN (**narrowed**) | criterion reification ships on java/dotnet/node/elixir (python non-reifying *by design*); only **principal-binding in the criterion query-face** is deferred |
| 25 | 🔴 OPEN | worker/orleans/genserver all stubs |
| 26 | 🟡 OPEN (**narrowed**) | instance **visibility** ships on all 5 backends; the **execution/persistence epic** (choreographer seam) remains |
| 27 | 🔴 OPEN | 5 `PlatformSurface` hooks (authGate/auditInit/compliance/tenancy/i18n) are optional no-ops, zero impls (tenancy+audit landed via *other* paths) |
| 28 | 🟡 OPEN (partial) | `loads:` lowered but **unconsumed** by every backend (hardcoded full-load); `find all` pagination grammar-gated |
| 29 | 🔴 OPEN | views are single-source only (no joins, no per-view params) — grammar-level |
| 30 | 🔴 OPEN (a/b/c), ❓ STALE (d) | seed create-validation / appliers / block-body-lambdas genuinely stubbed; **(d) "method-call hooks binding" — no such IR field found; likely a stale/mislabeled entry** |

**Takeaway for picking work:** trust the backend-tier rows; with DEBT-06
(provenance) and DEBT-07 (`shape(document)`) now landed on the elixir backend,
the highest-value *real* items remaining are DEBT-03 (union
`add`/`remove` bodies — `emit` now ships) and DEBT-24 (principal criterion
query-face); DEBT-13 (elixir `X id[]` ordinal) landed via #1580. The frontend
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
| DEBT-02 | Non-relational (`shape(document/embedded)`) capability `filter` — **node (both shapes) + java (both shapes) + elixir (`embedded`) landed** (document → in-app over the rehydrated aggregate; embedded → root scalars are real columns, so SQL `where` / `@SQLRestriction` / Ash `base_filter`). elixir has no `document` shape (DEBT-07). Only follow-up: principal-on-non-relational (actor + json intersection, all backends) | ~~node, java, elixir~~ · principal-non-rel | 4 | M | — |
| DEBT-03 | Operation `or`-union return (exception-less ProblemDetails) | elixir | 4 | M | `exception-less.md` · **return-dominant + mutation(`assign`)/guard(`precondition`/`requires`)/`emit` landed**; only `add`/`remove` bodies remain (detail below predates Ash-foundation removal) |
| DEBT-04 | Audit runtime parity — **RE-SCOPED** (see detail): `audited` ops → **elixir greenfield Ash audit** (real); `audited` lifecycle → **vaporware** (no grammar slot → DEBT-16); `with audit` stamping → vanilla-foundation | elixir | 4 | L | `type-system-feature-migration.md` (DBT) |
| DEBT-05 | React walker `List` / `Detail` / `For` primitives (comment-only today) — **DONE: `For` implemented (all 4 frontends + HEEx; now with an optional `empty:` arm); `List`/`Detail`/`MasterDetail` were inert duplicates of `scaffoldList`/`scaffoldDetails` and were REMOVED** ([D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)) | react (→ vue/svelte) | — | — | resolved |
| **P1 — parity + frontend completeness** |
| DEBT-06 | Provenanced fields (lineage SDK + trace capture) — **DONE on `foundation: vanilla`**: the `<App>.Provenance` SDK (process-buffer + transactional flush + `Json` Ecto type), co-located `<field>_provenance` column, inline named-op capture, and the `provenance_records` migration; gate un-blocks elixir-vanilla (ash stays gated, like ES storage). Ash foundation parity remains out of scope (no co-located-column fit). | elixir/vanilla | 3 | L | `provenance.md`, `type-system-feature-migration.md` DBT-1 |
| DEBT-07 | `shape(document)` persistence — **DONE (CRUD) on `foundation: vanilla`**: the `(id, data, version)` jsonb table + a schemaless-changeset validated fold (cast + required + invariants, the relational `base_changeset` contract) + a data-merge serialize; gate un-blocks elixir-vanilla (ash stays gated). Custom finds + named ops on a document aggregate are gated (`loom.vanilla-document-unsupported`) as a v1 follow-up. | elixir/vanilla | 3 | M | — |
| DEBT-08 | Generic carriers on the wire consumer — **`paged` DONE** (frontend hooks + DTO already ship); **`envelope` re-scoped**: not a frontend gap (backends disagree — Hono serves bare, .NET wraps `{id,ts,body}`) and *no live use case*, so deferred until a real event/message-transport need appears | ~~react, vue, svelte~~ (envelope: all backends) | 2 | M | `payload-transport-layer.md` P3b |
| DEBT-09 | ~~Non-constructible aggregates (omit the create surface)~~ **DONE** — the Phoenix backend drops the create action; the frontend scaffold drops the `<Agg>New` page + list "New" button when `!isConstructible` | elixir, react, vue, svelte | 3 | M | — |
| DEBT-10 | ~~Multi-segment / nested state mutation in page handlers~~ **DONE** — collection `+=`/`-=` now append/remove (was numeric `+`/`-` → broken list code); nested `:=` mutates in place on Vue/Svelte/Angular vs React's immutable spread | react, vue, svelte (+ angular) | 3 | M | — |
| DEBT-11 | ~~Vue workflow forms~~ **DONE** — structural render + error mapping already shipped; the success-toast parity (React/Svelte gap) now lands too | vue | 3 | M | `vue-frontend-plan.md` |
| DEBT-12 | Phoenix page DSL: `requires` guard, new-parts-in-body, `verify_token` | elixir | 2 | M | — |
| DEBT-13 | ~~Ordered `X id[]` reference collections~~ **DONE (elixir read+write order, #1580)** — `ordinal` stamped on write + ordered on read, parity with node; named-op incremental `+=`/`-=` ordinal is the lone follow-up. Frontend ordered-editor still open | ~~elixir (set-only)~~, frontends (editor) | 2 | M | `experience_gathered.md` §8.4 |
| **P2 — backend structural gaps + minimal-v1 adapter completion** |
| DEBT-14 | `hosts:` separate React bundle (only embedded `ui:` works) | java | 3 | L | `java-backend-implementation.md` |
| DEBT-15 | Part-declared single (non-collection) containments | java | 2 | M | `java-backend-implementation.md` |
| DEBT-16 | Audited *lifecycle* actions (`audited create`/`destroy`) — **blocked on grammar**: `Create`/`Destroy` have no `audited` slot (lowering hardcodes `audited: false`); needs the grammar surface before any backend instrumentation. Also no backend emits it today (node's gate is aspirational) | grammar, then dotnet, java, node | 2 | M | — |
| DEBT-17 | MikroORM v1 → full surface (retrieval, assoc, inheritance, filters, …) | node | 3 | L | `retrieval-implementation.md` |
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
| DEBT-28 | `loads:` eager-load specs + pagination on `find all` | all backends | 2 | L | — |
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

### DEBT-02 · Non-relational capability filters
- **Where:** same gate as DEBT-01 (the `shape(document/embedded)` branch).
- **Today:** capability filters only emit for *relational* aggregates on node/elixir/java (a jsonb field isn't a top-level column). .NET handles it.
- **Scope:** JSON-path lowering of the predicate against the document column.

### DEBT-03 · Operation `or`-union return on Elixir/Ash
- **Where:** `src/ir/validate/checks/structural-checks.ts:504` (`validateOperationReturnsUnimplemented`); ships on node/dotnet/python/java **and elixir `foundation: vanilla`** — only **elixir/ash** was gated.
- **Why P0:** N−1 backends ship it; closing one foundation restores full parity. The vanilla `{:ok,_} | {:error, tag, data}` carrier is the reference ported to Ash.
- **Slice 1 (landed):** *return-dominant* ops (body is only `return`/`let`) emit as an Ash 3.x **generic action** (`action :<op>, :term do … run fn input, _ctx -> {:ok, tagged} end end`) that loads the record via `Ash.get(__MODULE__, id)` and hands back a tagged term; the controller translates it (success → 200, error variant → `problem_variant/5` ProblemDetails, absent record → 404). Emitter: `src/generator/elixir/operation-returns-ash-emit.ts`. Shared predicate `isReturnDominantOp` (`src/ir/util/operation-returns.ts`) keeps the validator gate and generator in lock-step. Real-Ash compile verified by the `elixir-ash-build` CI job (fixture `test/e2e/fixtures/phoenix-build/operation-returns.ddd`).
- **Slice 2 (landed):** *in-memory* mutation-then-return — `assign` struct-updates the loaded record in place (`%{record | f: …}`, the success fall-through serialises it) — plus `precondition`/`requires` guards (raise). Predicate broadened to `isAshReturningOpEmittable`. Fixture `operation-returns-body.ddd`.
- **Slice 3 (landed):** `emit` — renders the same `Phoenix.PubSub.broadcast(%Ctx.Events.Name{…})` the regular Ash op body / workflow emits (no persistence, so it fits the in-memory run fn; the per-context Dispatcher consumes it). Fixture `operation-returns-emit.ddd`.
- **Follow-up (still gated on ash → `foundation: vanilla`):** `add`/`remove` collection mutations — they edit a join table via `manage_relationship`, which needs a changeset the generic action's in-memory run fn can't carry (the generic-action → changeset bridge). The validator emits a targeted hint.

### DEBT-04 · Audit runtime parity — RE-SCOPED (investigated 2026-06-19)
- **Where:** `validateAuditedOperationSupport` (`AUDIT_OP_BACKENDS = {node, dotnet}`, `AUDIT_LIFECYCLE_BACKENDS = {node}`).
- **Finding — the entry conflated three things, one of which is vaporware:**
  1. **`audited` operations** (`operation foo() audited`) — REAL and reachable (grammar has the `audited` slot on `Operation`). Runtime ships on node + dotnet (audit-record append in the save transaction). **elixir is the genuine gap** — the Ash backend emits *no* audit runtime, so audited ops are validation-gated off elixir. Closing it is a **greenfield Ash audit-record implementation** (`audit_records` resource/table + an Ash change capturing actor + before/after, staged in the action's transaction) — mirroring node/.NET from scratch (~L).
  2. **`audited` lifecycle** (`audited create`/`destroy`) — **VAPORWARE.** The grammar's `Create`/`Destroy` rules have *no `audited` slot*; `lowerCreate`/`lowerDestroy` hardcode `audited: false` ("no grammar slot"); no macro sets it; and **node doesn't actually emit lifecycle audit rows either** (its routes-builder only instruments operations — the `AUDIT_LIFECYCLE_BACKENDS = {node}` gate is aspirational). So no `.ddd` program can express it and no backend honours it. Making it real needs a **grammar** addition first — that belongs to **DEBT-16**, and DEBT-16 is itself blocked on the grammar slot.
  3. **`with audit` stamping** (`contextStamps` — audit fields stamped onCreate/onUpdate) — a *separate* capability; gated only on the **vanilla (Ecto) elixir foundation** (`system-checks.ts` `reject(…, "uses audit stamping")`). Smaller piece.
- **Recommendation:** split this entry — lifecycle → DEBT-16 (grammar-first); operations → an elixir-greenfield ticket; stamping → vanilla-foundation. A `.NET`-lifecycle slice was prototyped and **discarded** as dead code (instrumentation for an unexpressible feature).

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
- **DEBT-13 Ordered ref collections — DONE (elixir read+write order, #1580):** the vanilla join now stamps the migration's `ordinal` column on write (a per-field `__stamp_ref_ordinal_<field>/2` `Repo.update_all` to the id-list index, inside the persist transaction) and orders on read (`preload_order` → `[asc: dynamic([_assoc, join], join.ordinal)]`), so a `Foo id[]` collection round-trips in declaration order, matching node. Remaining: the named-op incremental `+=`/`-=` path (still `put_assoc`, membership-only — append-order needs max-ordinal tracking) and a first-class ordered editor on the frontends.
- **DEBT-31 Inline collection ops on Phoenix/HEEx — DONE:** expression-position lambda callbacks (`xs.filter(o => …)`, `.map`) render on the JS frontends via the shared `emitExpr` (native `Array.prototype` methods). HEEx's parallel engine (`heex-walker-core.ts`) used to hoist the callback into a `handle_event` clause and emit an invalid `recv.filter(event_N)` chain — because `filter`/`map` aren't in the shared `isCollectionOp` catalogue. `renderMethodCall` now routes a `filter`/`map`/`select` method-call with a lambda arg to `renderCollectionOp` (whose `Enum.filter/2` / `Enum.map/2` arms already existed but were unreachable). **`sortBy` was dropped:** it's not a native JS array method and has no runtime helper, so it's broken on the JS frontends too (`xs.sortBy(...)` → a non-existent method) — there's no parity target to mirror. A real `sortBy` is a separate cross-frontend feature (JS runtime helper + `Enum.sort_by/2` + catalogue/type-system entry).

---

## P2 — backend structural gaps & minimal-v1 adapters

- **DEBT-14 Java `hosts:`** — host a separately-declared react deployable's bundle (only embedded `ui:` works today). `system-checks.ts:491`, `loom.java-fullstack-unsupported`.
- **DEBT-15 Java single part-containments** — map a part-declared `contains x: P` (non-collection) via the shadow-parent FK. `system-checks.ts:600`, `loom.java-single-containment-unsupported`.
- **DEBT-16 Audited lifecycle (dotnet, java)** — `audited create`/`destroy` instrumentation.
- **DEBT-17 / DEBT-18 MikroORM & Dapper v1 → full surface** — both reject the same set (retrieval bundles, seed, event-sourced, non-relational, inheritance, `Id[]` associations, nested parts, audit stamping, capability filters, provenanced, managed access) and throw on complex find predicates (`emit/mikroorm.ts:437`, `emit/dapper.ts:405`). Close incrementally toward the default-adapter surface.
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
The largest cross-cutting unfinished area. `workflow` blocks parse and partially
lower (elixir/vanilla has `workflow-execution-emit.ts`), but the IR carries
fields **no backend consumes** — a persisted workflow-state row is never emitted
(`src/ir/types/loom-ir.ts:917,925`), and frontend workflow forms are open
(DEBT-11). **Recommend a design spike** (`workflow-choreographer-seam.md`) to
decompose into: (a) persisted workflow row + repository, (b) per-backend step
execution, (c) frontend workflow forms, before scheduling slices.

### DEBT-27 · PlatformSurface reserved hooks
`emitAuthGate` / `emitAuditInit` / `emitCompliancePolicy` / `emitTenancyFilter` /
`emitI18nAdapter` (+ the `ComposeServiceShape` slots `auditSidecar` /
`policyInitCmd` / `i18nCatalogDir`) are defined but **undefined on every
backend** (`src/platform/surface.ts`). Each has its own proposal; filling one
lands that concern's adapter for that backend. DEBT-01 (tenancy filter) and
DEBT-04 (audit) overlap these — coordinate so we don't build the same plumbing twice.

### DEBT-28–30 · Universal "not yet anywhere"
Not platform-gated — bounded language gaps: `loads:` eager-load specs + `find
all(skip, take)` pagination (DEBT-28); joined view sources / per-view params
(DEBT-29); and the small IR-consumed-nowhere tail (DEBT-30): seed create-shape
validation (`typescript/emit/seed.ts:20`), side-effecting-call metadata
(`loom-ir.ts:343`), block-body lambdas in UI e2e tests (`ui-e2e-render.ts`),
method-call hooks binding in page handlers (`walker-core.ts:1021`).

---

## Recommended first five

Sequenced for parity impact and momentum (all are ports of an existing pattern,
none require a design spike):

1. ~~**DEBT-03** — operation `or`-union return on Elixir/Ash~~ — **slice 1 done** (return-dominant ops; mutation/guard follow-up remains).
2. ~~**DEBT-05** — React `List`/`Detail`/`For` primitives~~ — **done**: `For` implemented (all 4 frontends + HEEx, with an optional `empty:` arm); `List`/`Detail`/`MasterDetail` removed as inert duplicates ([D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)).
3. **DEBT-01** — principal-referencing filters on node (then elixir, java) — highest demand.
4. **DEBT-02** — non-relational filters (rides on DEBT-01's plumbing).
5. **DEBT-04** — audit runtime parity (dotnet first, then elixir).

When we pick one up, spin its row into a focused slice plan under `docs/plans/`
and link it back here.
