# Gated Features Inventory

> **Superseded (2026).** The Ash foundation has since been removed entirely —
> `platform: elixir` now generates plain Ecto/Phoenix only, `foundation: ash` is
> a validation error, and `vanilla` is the default and only valid value. The
> `ash`/`ashPostgres` foundation rows below are historical.
>
> **Superseded (2026-06-21).** This snapshot predates Java/Python being broken
> out as backends and the Phoenix `vanilla` foundation gaining event-sourcing /
> document / provenance support. For the current five-backend picture see
> [`backend-feature-parity-2026-06.md`](backend-feature-parity-2026-06.md).
> Several rows below are stale — the gate sets have widened since. As of
> 2026-06-23: TPH is no longer node-only (all five backends); event-sourced
> storage is `{node, dotnet, java, python}` + elixir·vanilla; provenance AND
> per-op/lifecycle `audited` are `{node, dotnet, java, python}` + elixir·vanilla;
> `ignoring` filter-bypass is all five families incl. both elixir foundations; and
> `X id[]` reference collections now emit on all five backends (the matrix row
> below showing phoenix `✗ set` is wrong — #1533/#1551 fixed both foundations).
> Use the current audit for any decision.

**Snapshot date:** 2026-06-03

A cross-backend audit of features that work on some platforms but not others —
the standing platform-parity debt. Each entry names where the gate lives, which
backends support the feature today, and the diagnostic code (if any) that fails
fast when an unsupported combination is requested.

This is a **point-in-time empirical snapshot**, not a spec. The authoritative
source for any row is the cited file; when they disagree, the code wins.

Backends: **node** (Hono/TS), **dotnet** (.NET/EF Core), **phoenix**
(Phoenix LiveView/Ash), **react**/**static** (frontend-only).

Legend: ✓ implemented · ✗ gated (validator error) · ⚠ partial / stub · N/A not applicable.

---

## Summary matrix

| Feature | node | dotnet | phoenix | react |
|---|:---:|:---:|:---:|:---:|
| Event-sourced storage `persistedAs(eventLog)` | ✓ | ✓ | ✗ | N/A |
| TPH inheritance `inheritanceUsing(sharedTable)` | ✓ | ✗ | ✗ | N/A |
| TPC inheritance `inheritanceUsing(ownTable)` | ✓ | ✓ | ✓ | N/A |
| `shape(document)` persistence | ✓ | ✓ | ✗ | N/A |
| Principal-referencing capability `filter` (`currentUser`) | ✗ | ✓ | ✗ | N/A |
| Non-principal capability `filter` (relational) | ✓ | ✓ | ✓ | N/A |
| Provenanced fields (runtime trace) | ✓ | ✓ | ✗ (gated) | N/A |
| Generic carriers (`paged<T>` etc.) | ✓ | ✓ | ✓ | ✗ |
| Ordered `X id[]` reference collections | ✓ | ✓ | ✗ (set semantics) | display-only |
| Per-op `audited` operations (audit record) | ✓ | ✓ | ✗ (gated) | N/A |
| Audit stamping (`with audit` / `contextStamps`) | ✓ | ⚠ parsed, parity deferred | ⚠ parsed, parity deferred | N/A |
| Non-constructible aggregates (omit create surface) | ✓ | ✓ | ⚠ always create | ⚠ always create |
| `where`-clause finds / queryable predicates | ✓ | ✓ | ✓ | ⚠ hook only |
| Page `requires <pred>` guard | N/A | N/A | ⚠ v0 stub | N/A |
| Complex page event-handler statements | N/A | N/A | ⚠ | ⚠ limited |

Persistence-adapter sub-matrix (alternate adapters; defaults are full-surface):

| Adapter (platform) | Status |
|---|---|
| `drizzle` (node, default) | ✓ full surface |
| `efcore` (dotnet, default) | ✓ full surface |
| `ashPostgres`/`ash` (phoenix, default) | ✓ full surface |
| `mikroorm` (node) | ⚠ minimal-v1 (see §4) |
| `dapper` (dotnet) | ⚠ minimal-v1 (see §4) |
| `marten` (dotnet) | ✗ reserved stub — throws `AdapterNotImplementedError` |

Style/layout adapter stubs:

| Adapter (platform) | Status |
|---|---|
| `style: cqrs` (node) | ✗ reserved stub |
| `style: layered` (dotnet) | ✗ reserved stub |

---

## 1. Persistence & storage strategy

### 1.1 Event-sourced storage — `persistedAs(eventLog)`
- **Gate:** `src/ir/validate/checks/system-checks.ts:826-861` (`EVENT_SOURCING_BACKENDS = {node, dotnet}`)
- **Supported:** node, dotnet (`<agg>_events` stream table + fold-on-load repository).
- **Gated:** **phoenix** — would silently fall back to state persistence, losing the
  event log, so it's a hard error rather than a downgrade.
- **Code:** `loom.event-sourcing-backend-unsupported`
- **Tracking:** `workflow-and-applier.md` (appliers A2).

### 1.2 Table-Per-Hierarchy inheritance — `inheritanceUsing(sharedTable)` (the omitted-modifier default)
- **Gate:** `src/ir/validate/checks/system-checks.ts:785-824`
- **Supported:** **node only.** TPH storage emission is Hono-only.
- **Gated:** **dotnet, phoenix** — must use `inheritanceUsing(ownTable)` (TPC), which all
  backends support.
- **Code:** `loom.tph-backend-unsupported`
- **Tracking:** `aggregate-inheritance.md` I2/I3.

### 1.3 `shape(document)` persistence (opaque key-value map)
- **Gate:** `src/util/platform-axes.ts:40-47`
- **Supported:** node, dotnet (relational + embedded + document).
- **Gated:** **phoenix** — relational + embedded only; `document` (a single opaque Ash
  `:map`) is "allowed-but-warned" future work.

---

## 2. Inheritance — unsupported on *every* backend (universal, not platform-specific)

These are language-level rejections, not per-backend gates, but they bound what
the inheritance feature can express today.

### 2.1 Mixed strategy — `ownTable` override under a `sharedTable` (TPH) base
- **Gate:** `src/language/validators/inheritance.ts:117-145`
- **Status:** rejected everywhere. The override concrete would live outside the
  shared table, so `find all Base` and polymorphic `Base id` refs couldn't see it.
- **Code:** `loom.tph-own-override-unsupported`

### 2.2 Polymorphic `Base id` reference to a TPC (`ownTable`) abstract base
- **Gate:** `src/language/validators/inheritance.ts:168-200`
- **Status:** rejected everywhere — the FK target is ambiguous across per-concrete tables.
- **Code:** `loom.polymorphic-id-ref-unsupported`

---

## 3. Capability filters / stamps

### 3.1 Principal-referencing `filter` (references `currentUser`, e.g. tenancy)
- **Gate:** `src/ir/validate/checks/system-checks.ts:365-407` (`LIMITED_FAMILIES = {node, phoenix}`)
- **Supported:** **dotnet only** (EF `HasQueryFilter`).
- **Gated:** **node, phoenix** — principal-referencing filters not yet wired.
- Non-principal filters on relational aggregates (e.g. `filter !this.isDeleted`)
  ARE emitted on all backends.
- **Code:** `loom.context-filter-unsupported`

### 3.2 Per-operation `audited` flag (`operation … audited`)
- **Gate:** `src/ir/validate/checks/system-checks.ts` `validateAuditedOperationSupport`
  (`AUDIT_OP_BACKENDS = {node, dotnet}`; `AUDIT_LIFECYCLE_BACKENDS = {node}`).
- **Supported:** **node, dotnet** — an audited public operation appends a who/what/when +
  before/after snapshot to the `audit_records` sink in the operation's save transaction.
  On .NET an `IAuditWriter` stages the row onto the request unit of work so the audit
  row commits with the aggregate.
- **Gated:** **phoenix** (audited operations); **dotnet, phoenix** (audited *lifecycle*
  actions `audited create` / `destroy`, not yet instrumented on .NET) — a hard error.
  **Code:** `loom.audited-backend-unsupported`.
- Scope note: this gates the *per-operation* `audited` flag only. The `with audit`
  capability macro (§3.3) is a separate mechanism and is **not** gated.

### 3.3 Audit stamping (`with audit` / `contextStamps`) — runtime parity
- **Supported (runtime):** node.
- **Partial:** dotnet, phoenix — parsed; runtime parity deferred (the `with audit` /
  `auditable` macros emit `contextStamps`; .NET has a partial auditable interceptor).
- **Not gated** — co-hosting is allowed; closing this is Tier-1+ work, not Tier-0.
- **Tracking:** `docs/old/plans/type-system-feature-migration.md` (DBT register).

---

## 4. Alternate persistence adapters (minimal-v1)

Both gates reject the same feature set; defaults (`drizzle`/`efcore`) are full-surface,
so these only fire on explicit selection.

### 4.1 `persistence: dapper` (dotnet)
- **Gate:** `src/ir/validate/checks/system-checks.ts:420-471` · **Code:** `loom.dapper-unsupported`
- **Test:** `test/adapters/dotnet-dapper.test.ts`

### 4.2 `persistence: mikroorm` (node)
- **Gate:** `src/ir/validate/checks/system-checks.ts:483-535` · **Code:** `loom.mikroorm-unsupported`
- **Test:** `test/adapters/node-mikroorm.test.ts`

Rejected by both minimal-v1 adapters (supported only by the default adapters):
retrieval query bundles · seed data · event-sourced aggregates · non-relational
`shape(...)` · aggregate inheritance (abstract/extends) · reference-collection
associations (`Id[]` join tables) · nested entity parts · audit stamping
(`contextStamps`) · capability filters (`contextFilters`) · provenanced fields ·
server-managed field access (`managed`/`token`/`internal`/`secret`).

### 4.3 `persistence: marten` (dotnet) — reserved stub
- **Gate:** `src/platform/dotnet.ts:100-111` — throws `AdapterNotImplementedError`.

---

## 5. Provenanced fields — `provenanced field: T`
- **Gate:** `src/ir/validate/checks/system-checks.ts` `validateProvenancedStorage`
  (`PROVENANCE_BACKENDS = {node, dotnet}`).
- **Supported:** **node, dotnet** — the lineage SDK (`domain/provenance.ts` /
  `Domain/Common/ProvLineage.cs`), per-write trace capture, the co-located
  `<field>_provenance` column, the transactional `provenance_records` flush, wire-DTO
  exposure, and `ddd snapshot` capture.
- **Gated:** **phoenix** — the keyword is accepted but emits no trace code (a silent
  no-op); now a hard error. **Code:** `loom.provenanced-backend-unsupported`.
- **Reference:** `docs/provenance.md`, `docs/old/plans/type-system-feature-migration.md` DBT-1.

---

## 6. Generic carriers — `paged<T>`, `envelope<T>`
- **Gate:** `src/ir/validate/checks/structural-checks.ts:213-269` · **Code:** `loom.generic-carrier-unsupported`
- **Supported:** node, dotnet, phoenix.
- **Gated:** **react** — wire shape carries the carrier, but the frontend doesn't emit
  one yet. Tracking: `payload-transport-layer.md` P3b.

---

## 7. Reference collections — `X id[]` ordering
- **Reference:** `docs/generators.md` (Reference-collection section); `experience_gathered.md` §8.4.
- **node (Drizzle), dotnet (EF):** ordered via an `ordinal` column (`ORDER BY ordinal`).
- **phoenix (Ash):** **unordered / set semantics** — `manage_relationship` doesn't inject
  the ordinal; rows return in Postgres' order. Treat `party[0]` as "some element", not
  "the first". (Ratified as set semantics: the join table is contractually a set.)
- **react:** display-only `string[]`; no first-class ordered editor.

---

## 8. Frontend / page DSL gaps (react + phoenix LiveView)

### 8.1 React page event-handler statements — `src/generator/react/body-walker.ts`
- ✗ multi-segment state mutation (`nested.field := v`) — single-segment only (`body-walker.ts:972-975`).
- ✗ collection mutation on nested paths (`parent.items += x`) — single-segment only (`:999-1002`).
- ✗ statements with no React analogue (`emit`, `delete`, complex workflow stmts) (`:1017-1021`).
- ✗ unimplemented layout primitives surface as `{/* … not supported by the React walker yet */}` (`:648`).

### 8.2 React `where`-clause / list-page filter
- List-page filter mode deferred — v1 emits the data hook only.
- **Reference:** `docs/generators.md`; DBT-4 in `type-system-feature-migration.md`.

### 8.3 Phoenix LiveView page DSL
- `requires <pred>` page guard — v0 stub: bind-only; full `handle_params/3` guard deferred (`docs/generators.md`).
- New parts in page body — TODO stub `<%-- TODO: new <part> unsupported in page body --%>` (`heex-walker-core.ts:311`).
- Unimplemented primitives surface as `<!-- … not supported by Phoenix LiveView target -->` (`heex-walker-core.ts:551`).
- `verify_token/1` auth helper — TODO stub; user implements it (`auth-emit.ts:79`).

### 8.4 Non-constructible aggregates (omit the create surface)
- **node, dotnet:** omit `POST /` route / `CreateCommand` + factory.
- **phoenix:** always emits create (Ash models all-CRUD by default).
- **react:** always emits the create form (v1 keeps create always-on).
- **Test:** `test/generator/create-gate.test.ts`.

---

## 9. Cross-cutting concerns — reserved-but-unwired everywhere

`PlatformSurface` (`src/platform/surface.ts:216-271`) defines optional lifecycle
hooks that are **undefined on every backend today** — designed boundaries with no
implementation yet. Filling one lands that concern's adapter for that backend.

| Hook | Concern | Proposal |
|---|---|---|
| `emitAuthGate` | authorization gate | `docs/old/proposals/authorization.md` |
| `emitAuditInit` | audit subsystem init | `docs/old/proposals/audit-and-logging.md` |
| `emitCompliancePolicy` | sensitivity/compliance | `docs/old/proposals/sensitivity-and-compliance.md` |
| `emitTenancyFilter` | multi-tenancy isolation | `docs/old/proposals/multi-tenancy-design-note.md` |
| `emitI18nAdapter` | i18n catalog | `docs/old/proposals/i18n.md` |

The `ComposeServiceShape` reserved slots (`auditSidecar`, `policyInitCmd`,
`i18nCatalogDir`) are the compose-side counterparts — also undefined everywhere.

---

## 10. Universal "not yet anywhere" gaps (for completeness — not platform-gated)

- **Explicit `loads:` eager-load specs** — rejected outright; every retrieval loads
  the whole aggregate. `loom.retrieval-loads-unsupported`
  (`query-checks.ts:186-205`). Per-operation autoload planned.
- **Pagination on `find all`** — returns every row; `find all(skip, take)` is future syntax.
- **Multi-target frontends** — a react deployable has exactly one `targets:`.
- **Block-body lambdas in UI e2e tests** — fall back to a stub comment (`ui-e2e-render.ts:415-421`);
  supported in page event handlers.
- **SSR** — frontend is client-only Vite; a Next.js variant would be a separate platform.
- **`slot` type reaching a backend renderer** — UI-only; throws if it leaks
  (`typescript/render-expr.ts:357`, `phoenix-live-view/render-expr.ts:528,600`).
