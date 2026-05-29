# Global Implementation Plan — `docs/proposals/`

> **Status:** Reference document. Reads the live design corpus +
> existing `implementation-plan.md` /
> `storage-and-platform-config-micro-plan.md`, then audits the
> codebase against `origin/main` to determine current state before
> ordering. The kitchen-sink example at the end contains draft syntax
> with **known undecided issues** — see the note above that example.

## Context

`docs/proposals/` is the live design corpus for Loom. The `README.md`
index is stale per the maintainer; this plan uses per-doc bodies as
source of truth and verifies state against `origin/main`.

The goal is a single topological order across the in-scope proposals
that:

1. Lands a small set of mechanical refactors / seam extractions first.
2. Resolves cross-proposal collisions before any grammar lands.
3. Sequences features so downstream consumers do not undo upstream
   choices.
4. Skips or shrinks work already shipped on main.

## Audit summary — current state on `origin/main`

Major landings since the original plan was drafted:

| Landed on main | Effect on plan |
|---|---|
| WalkerTarget extraction (#607–#627; tsxTarget + heexTarget standalone; 7 seams delegated — `renderStateRead/Write`, `renderApiCall`, `renderApiHoisting`, `renderHelperImports`, `renderNavigate`, `renderMatch`) | Drop from Phase 0 — done end-to-end |
| `src/ir/wire-types.ts` (#605) — centralised wire-type dispatch | Reuse in Phase 1 / Phase 2 generators |
| named `layout` SystemMember (#609, #611) + multi-pack ports (#620) | Layouts now first-class — relevant to forms & i18n chrome |
| `component` as ModelMember (#629) + slot-typed params (#632, validator #643) | Workspace-wide components — consumed by loom-forms |
| HEEx form primitives, Phase D Slices A–D (#631, #634, #635, #636, #637) | Phoenix form primitives partially landed — slots into loom-forms backend work |
| `react: require ui:` (#606) — legacy archetype fallback removed | No more dual codepaths in later UI proposals |
| Storage adapter taxonomy + orchestrator rewire (#681–#691: F3 contracts, F5/F6/F7 real persistence/style/layout adapters + dispatch) | `persistence`/`style`/`layout` adapter seam is real on all three backends; emit dispatches through it |
| **D-ADAPTER-HOME dissolve** — central `adapter-registry.ts` removed; each backend carries its menu on its `PlatformSurface`; `resolve-adapters.ts` reads the discovered surface | Adapter contracts done; `resolve*` is the ready seam. Next consumer = the per-deployable adapter-selection feature (below), not standalone wiring |

Per-proposal state on `origin/main`:

| Proposal | State | Carry-over |
|---|---|---|
| `provenance.md` | SHIPPED (TS/Hono v1) | Deferred items only |
| `observability.md` | SHIPPED (catalog + 3 backends + `LOOM_OBS_E2E_*` gates) | None in scope |
| `audit-and-logging.md` | PARTIAL — `audited` boolean lands; Hono emits load→mutate→save→audit | Promote to `audited(actions \| access \| events \| off)`; `AuditRecord` shape; before/after snapshots; .NET Mediator behaviour; access-audit query pipeline |
| `sensitivity-and-compliance.md` | PARTIAL — phases 1 + 2-lite shipped | Phase 2 full (`authorized(<tag>,…)`); Phase 3 (`mask:` DTOs + React); Phase 4 (sink-call classification) |
| `storage-and-platform-config.md` | PARTIAL — top-level `storage` + `dataSource` + role-keyed slots + the persistence/style/layout **adapter taxonomy** (F3–F7) exist; adapters live on the `PlatformSurface` (D-ADAPTER-HOME) | **Next gated step: per-deployable `persistence:` / `style:` / `layout:` selection** — grammar + `DeployableIR` fields → system orchestrator resolves via `resolve-adapters.ts` + validator capability-checks (`supports`, `supportedLayouts`). This is what *consumes* `resolve*`; build when there's a pull for a non-default adapter. Plus `STORAGE_CAPABILITIES` matrix; per-aggregate `for:` deferred to v2 (D-GRANULARITY) |
| Everything else in scope | NOT STARTED | Full per each doc's internal phasing |

## New proposals on main

| Proposal | One-line | Hard prereq | Effort |
|---|---|---|---|
| `lifecycle-operations.md` | `create` / `operation` / `destroy` keywords with kind tags on `OperationIR`; fixes the "form/API generators invent create contracts from `aggregate.fields`" layering bug | None | 5 phases, ~13 d / ~7 d parallel |
| `loom-forms.md` | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives bound strictly to typed-action IR | lifecycle-operations Phase 1 | 3 phases, ~5 d |
| `i18n-strings.md` | Bans `+` in user-visible slots; mandates template literals; ICU placeholder lowering with stable content-hash keys | None | ~5 d, folds into i18n |
| `i18n.md` | First-class i18n: ICU catalogs, content-hash keys, named `text { }` entries, `ddd i18n sync` three-way merge, per-backend adapters | i18n-strings | 7 phases, ~4 weeks |
| `workflow-and-applier.md` | Ash-style `create` actions, applier separation, sagas deferred | None | TBD per proposal phasing |
| `platform-directory-layout.md` | Framework-version axis for backend code. **Option A rejected (D-BACKEND-PKG)**; backend layout follows the packaging-split (per-version packages); hono hoist stays as package-staging | packaging-split lands; gated on F-series + `node` rename | per backend, after F-series |
| `per-package-output-tree.md` | Per-layer **output** packages ("Loom as ORM"). Output-side twin of packaging-split; expressible as a `LayoutAdapter` | playground workspace support | deferred — large one-time bill |

## In scope

- Type-system family: aggregate-inheritance, payload-transport-layer,
  exception-less, criterion, partial-update, load-specifications,
  type-system-overview, implementation-plan.
- Storage & platform-config + plan + micro-plan.
- Layout housekeeping: src-ir-phase-reveal,
  test-layout-and-macro-consolidation.
- Access control: authorization, multi-tenancy-design-note,
  policies-supplementary-note (background).
- Provenance / governance backbone: execution-context, provenance
  (extend), audit-and-logging (promote), sensitivity-and-compliance
  (phases 2/3/4), observability (no work), encrypted-at-rest
  (deferred final).
- UX / output: pagination-design-note, lifecycle-operations,
  loom-forms, i18n-strings, i18n.
- Workflow: workflow-and-applier (new on main).

Out of scope (per maintainer): `mutation-testing.md`.

## Known undecided issues (block grammar work, not this plan)

- **Storage keyword overload.** The storage proposal currently uses
  `storage` for **two** distinct concerns: physical resources
  (`storage pg { type: postgres }`) and logical
  aggregate-to-physical bindings (`storage orderEvents { use: pg,
  for: [Sales.Order] }`). The maintainer has flagged this as a
  design issue — one of them should likely be a different keyword
  (candidates: `dataSource`, `persistenceBinding`). Resolved in the
  decisions conversation before Phase 1A starts.
- **i18n `defaultLocale`.** The example below writes
  `defaultLocale en` at system level. `i18n.md` does not pin this
  syntax — placeholder pending the i18n decisions phase.
- **`mask: strategy: <name>`** placeholder syntax. The sensitivity
  proposal lists masking strategies but does not pin the syntax for
  selecting one per field. Placeholder pending phase 3 of the
  sensitivity proposal.

---

## Phase 0 — Convenience & Architectural Groundwork

Strictly housekeeping + cross-cutting design specs + test scaffolding.
No new language features.

### 0.1 Decisions to pin before any grammar edit

- D-RENAME — `inheritanceStrategy: shareTable | ownTable` (inside
  `aggregate { … }`). Removes the only lexical collision with the
  storage proposal.
- D-ES-TPH — Force `inheritanceStrategy: ownTable` for ES concrete
  subtypes of TPH abstract.
- D-STORAGE-SPLIT — Split the `storage` keyword overload (see "Known
  issues" above).
- Type-system D1–D4 + D14–D15 — carrier name, discriminator name,
  postfix-vs-prefix ML syntax — pinned per `implementation-plan.md`,
  locked before P3.
- D-POLICY-STYLE — Pin `policy { }` reachability over function-style.
- D-LIFECYCLE-VERB — Pin `urlStyle: literal | resource` default.
- D-I18N-KEY — Pin Option B (positional hash + named render).
- D-CTX-SHAPE — Pin the ambient `RequestContext` field set
  (see §0.4).
- D-ENVELOPE — Pin the wire envelope rule (entity | `Paged<T>` |
  ProblemDetails | event-frame).

### 0.2 Mechanical file-tree reorgs (still NOT STARTED on main)

- `src-ir-phase-reveal.md` — restructure `src/ir/` into `types/` /
  `lower/` / `enrich/` / `validate/` / `util/`; move
  `migrations-builder.ts` to `src/system/`.
- `test-layout-and-macro-consolidation.md` — mirror `test/` to `src/`
  phases; consolidate macros under `src/macros/`.

### 0.3 Seam extractions

- ~~Walker-target extraction~~ — DONE on main; cite for reuse.
- Split `src/ir/lower-expr.ts` (1,606 LOC) into `lower-expr.ts` /
  `lower-stmt.ts` / `lower-types.ts`.
- Split `src/generator/ts/repository-builder.ts` (~1,125 LOC) into
  `eager-load-builder.ts`, `transaction-boundary-builder.ts`,
  `change-events-builder.ts`, `repository-imports-builder.ts`.
- PlatformSurface lifecycle hooks — extend `src/platform/surface.ts`
  with optional `emitAuthGate`, `emitAuditInit`,
  `emitCompliancePolicy`, `emitTenancyFilter`, `emitI18nAdapter`.

### 0.4 Cross-cutting design specs (`docs/architecture/*.md`)

- `request-context.md` (D-CTX-SHAPE) — single ambient `RequestContext`
  shape consumed by execution-context, multi-tenancy, authorization,
  sensitivity declassification, i18n, audit, observability.
- `wire-envelope.md` (D-ENVELOPE) — entity | `Paged<T>` |
  ProblemDetails | event-frame.
- `modifier-propagation.md` — propagation rules for aggregate-level
  modifiers (`sensitive`, `provenanced`, `audited`, tenant-scope,
  `mask:`, `authorized`).
- `diagnostic-catalog.md` — central error code registry.
- `cli-surface.md` — `ddd` sub-command extension model.
- `coordinated-rebaseline.md` — operational guide for M1 / M2 / M3 /
  Lifecycle-1 / Inheritance fixture rebaselines.

### 0.5 Test infrastructure

(Deferred — judged not worth the ceremony for the structural work
that 0.2 / 0.3 cover. Per-PR verification is "run the suites; no
fixture drift".)

### 0.6 Process

- Decision-log file at `docs/decisions.md` covering all D-tags.
- PR-type taxonomy: `grammar:`, `ir:`, `gen-<platform>:`,
  `rebaseline-<tag>:`, `docs:`, `infra:`.

---

## Phase 1 — Three parallel foundation tracks

### 1A. Storage & platform-config foundation

`storage-and-platform-config-micro-plan.md` F1–F8, scoped as delta on
top of already-landed top-level `storage { type }`. F1 (six small
PRs, non-emitting), F2 (validator + capability matrix), F3 (adapter
contracts — pivot point), F4–F7 (downstream + per-backend seam
refactors), F8 (override + outbox).

Depends on D-STORAGE-SPLIT resolved in §0.1.

### 1B. Lifecycle-operations + loom-forms

`OperationIR` reshape — explicit `kind ∈ {create, operation, destroy}`
tag. Phase 1 grammar+IR+validator → Phase 2 urlStyle+enrichment →
Phase 3 per-backend route emission (parallel across 4 backends) →
Phase 4 crudish reframing → Phase 5 scaffold alignment. Then forms
F1 (primitives bound to typed actions) → F2 (API client wiring) →
F3 (design-pack polish). Reuses already-shipped `component`
ModelMember, slot-typed params, and HEEx form primitive slices A–D.

### 1C. Aggregate inheritance (Track I)

Independent. Uses renamed `inheritanceStrategy:` from §0.1.

---

## Phase 2 — Type-system family

Follows `docs/proposals/implementation-plan.md`. Three serial
sub-tracks + parallel-able fourth, gated by M1, M2, M3.

- 2.1 Payload-transport (P-track) — P1, P2, P3, P4, P5. **M1**: P3 +
  P4 ship together.
- 2.2 Exception-less (A-track) — A1, A2, A3, A4, A5, A6, A7a.
  **M2**: A1+A2+A3 together. **M3**: A4 alone with coordinated
  fixture re-baseline.
- 2.3 Criterion (Crit-track) — Crit1–4 + Crit5 (private workflow +
  workflow-calls-workflow).
- 2.4 Folded: `partial-update.md` into A1; `load-specifications.md`
  into P3.

---

## Phase 3 — Provenance & Governance Family

Audit-driven — deltas only for already-shipped pieces.

- 3.0 `execution-context.md` (Tier 0) — compiler-emitted scope
  frames. Backbone for audit + future provenance/log extensions.
- 3.1 Tier 1 — audit promotion (`audited(actions|access|events|off)`,
  `AuditRecord`, before/after, Mediator behaviour, access-audit
  pipeline) + sensitivity phases 2/3/4 (`authorized(<tag>,…)`,
  `mask:` DTOs, sink-call classification).
- 3.2 Tier 2 — `multi-tenancy-design-note.md` then
  `authorization.md` phases 1–4 (DataKey infra → `policy { data { } }` reachability → operation/view/workflow gates → backend parity).
  Wires `policyDecisionId` into Tier 1 audit records.

---

## Phase 4 — i18n + Pagination

- 4.1 `i18n-strings.md` → `i18n.md` phases 1–7.
- 4.2 `pagination-design-note.md` — `Paged<T>` + `unpaged` +
  page-aware React hooks.

---

## Phase 5 — Deferred tail

- Authorization phases 5–7 (`exists`, field rules, `implies`).
- Provenance v1 across .NET / Phoenix.
- Audit module-wide config.
- `encrypted-at-rest.md`.

---

## Coordinated single-PR moments

| Tag | What | Phase | Reason |
|---|---|---|---|
| D-RENAME | `inheritanceStrategy:` rename | 0.1 | Removes only lexical collision |
| D-STORAGE-SPLIT | `storage` keyword overload split | 0.1 | Disambiguates physical vs logical |
| D-POLICY-STYLE | `policy {}` over function-style | 0.1 | Locks auth grammar shape |
| D-LIFECYCLE-VERB | `urlStyle:` default | 0.1 | Locks lifecycle route shape |
| D-I18N-KEY | Option B placeholder lowering | 0.1 | Locks i18n key stability |
| F1-PR-5 | `STORAGE_CAPABILITIES` + adapter stubs | 1A | Lock for downstream streams |
| F3 | Adapter contract publication | 1A | Enables parallel streams |
| Lifecycle-1 | Grammar + `OperationIR.kind` | 1B | Locks form-binding semantics |
| M1 | P3 + P4 | 2.1 | Half-built type system otherwise |
| M2 | A1 + A2 + A3 | 2.2 | Authors need all three together |
| M3 | A4 alone | 2.2 | One coordinated fixture re-baseline |
| Tier-0 | execution-context before tiers 1–2 | 3.0 | Audit-record backbone |
| Auth-gate | multi-tenancy before authorization phase 1 | 3.2 | DataKey leftmost = TenantId |

---

## Parallelisation

Two-agent split:

- Agent A — Phase 0 seams → Phase 1A (storage) → Phase 2 → Phase 3.2 (auth).
- Agent B — Phase 0 reorgs → Phase 1B (lifecycle + forms) and/or 1C (inheritance) → Phase 3.0 → Phase 3.1 → Phase 4.

Storage post-foundation streams (A–O) absorb additional implementers
after F3.

---

## Critical files (cross-phase)

- Grammar: `src/language/ddd.langium`.
- Validators: `src/language/ddd-validator.ts`,
  `src/language/validators/*`.
- Type system: `src/language/type-system.ts`.
- IR: `src/ir/types/loom-ir.ts` (post-reorg), `src/ir/lower/*`,
  `src/ir/enrich/enrichments.ts`, `src/ir/validate/validate.ts`,
  recently-landed `src/ir/wire-types.ts`.
- Generators: `src/generator/<platform>/render-expr.ts`,
  `render-stmt.ts`, `emit/*.ts`, `*-builder.ts`. Reuse
  `tsxTarget` / `heexTarget`.
- Platform surface: `src/platform/surface.ts`, `registry.ts`,
  `<backend>.ts`.
- Already-shipped seams to extend, not rebuild:
  `src/generator/_obs/log-events.ts`,
  `src/generator/_obs/render-{hono,dotnet,phoenix}.ts`,
  `src/platform/hono/v4/observability-builder.ts`,
  `src/system/loomsnap.ts`, `src/ir/prov-id.ts`,
  `src/cli/main.ts` (`ddd snapshot`),
  `src/generator/_walker/target.ts` + `tsxTarget` + `heexTarget`.

---

## Verification

- Phase 0 — `npm test` + every `LOOM_*_BUILD=1` gate green; fixtures
  byte-identical.
- Phase 1A — F1/F2 parser+validator tests; F3–F8 byte-identical.
- Phase 1B — lifecycle parser+validator+per-backend route tests;
  forms walker-target-contract; coordinated fixture re-baseline.
- Phase 1C — inheritance parser+per-backend repository tests.
- Phase 2 — M3 coordinated re-baseline; OpenAPI parity; wire-spec
  diff reviewed.
- Phase 3 — extend `LOOM_OBS_E2E_*=1`; integration tests for
  audit-record shape, policy-decision-id linking, sensitivity
  narrowing, tenancy isolation.
- Phase 4.1 — `ddd i18n sync` round-trip on a fixture catalog.
- Phase 4.2 — pagination list-endpoint + React hook + cache test.
- Phase 5 — encrypted-at-rest gated on storage capability matrix.

---

## Appendix — Kitchen-sink example (DRAFT)

> **Known issues** (must be resolved before this example compiles):
>
> - The `storage` keyword is used for both physical declarations and
>   logical bindings. Per "Known undecided issues" above, one of them
>   will be renamed (likely the logical binding to `dataSource` or
>   similar).
> - `defaultLocale en` is placeholder syntax not pinned in `i18n.md`.
> - `mask … strategy: partial / redact` is placeholder syntax for
>   sensitivity phase 3.
> - `text "Country name"` and `text PromoBanner = "…"` follow draft
>   `i18n.md` syntax that has not been pinned.
>
> The example is illustrative — review it as a target shape for what
> the assembled system looks like, not as compilable Loom.

Demonstrates every in-scope feature with the recommended decision
outcomes baked in. Once the issues above are resolved, lives at
`examples/kitchen-sink.ddd`.

```loom
// Order management for a multi-tenant SaaS.

system AcmeOrders {
  tenancy by user.tenantId
  locales en, es, fr
  defaultLocale en                     // DRAFT
  modules Identity, Catalog, Sales
}

// Physical resources
storage pg           { type: postgres }
storage redisCache   { type: redis }
// Logical binding — keyword TBD (see Known issues)
storage orderEvents  { use: pg, for: [Sales.Order], kind: eventLog }

module Identity {
  aggregate User {
    persistenceStrategy: stateBased
    id: UserId
    email: Email                sensitive(pii)
    displayName: string
    tenantId: TenantId
    role: enum { admin | manager | viewer }
    audited(actions)
  }

  policy User {
    data    { reachable when self.tenantId = currentUser.tenantId }
    fields  { mask self.email for currentUser.role != admin
              strategy: partial }                 // DRAFT
    operations { promote when currentUser.role = admin }
  }
}

module Catalog {
  unpaged aggregate Country {
    crossTenant
    id: CountryCode
    name: text "Country name"                    // DRAFT
  }

  aggregate Product {
    persistenceStrategy: stateBased
    id: ProductId
    sku: string
    name: string
    price: Money
  }
}

module Sales {
  abstract aggregate Order {
    inheritanceStrategy: shareTable
    persistenceStrategy: eventSourced
    id: OrderId
    customerId: CustomerId
    items: OrderItem[]
    total: Money provenanced
    status: enum { draft | placed | fulfilled | cancelled }
    audited(actions, access)

    create place {
      params: customerId: CustomerId, items: OrderItem[]
      requires self.items.length > 0
        reject ValidationFailed "Order must have at least one item"
      this.status = .draft
    }

    operation cancel {
      params: reason: string
      when fromActiveStatus
      this.status = .cancelled
    }

    destroy archive {
      when self.status = .cancelled
    }
  }

  aggregate RetailOrder extends Order { deliveryAddress: Address }
  aggregate WholesaleOrder extends Order {
    purchaseOrderNumber: string
    netTerms: int
  }

  criterion fromActiveStatus of Order
    = self.status = .draft or self.status = .placed
  criterion havingTotalAbove(threshold: Money) of Order
    = self.total > threshold

  command updateShipping of RetailOrder {
    deliveryAddress: Address option
    expedited: bool option
  }

  payload OrderActivity =
      OrderPlaced
    | OrderCancelled(reason: string)
    | OrderFulfilled

  error AlreadyCancelled
  error InventoryUnavailable(sku: string)

  workflow fulfillOrder {
    on Order.placed
      reserveInventory ?
      chargePayment ?
      shipOrder
  }

  private workflow chargePayment { }

  policy Order {
    data    { reachable when self.tenantId = currentUser.tenantId }
    operations {
      place    when currentUser.role in [admin, manager, viewer]
      cancel   when currentUser.role in [admin, manager]
      archive  when currentUser.role = admin
    }
    fields {
      mask self.customerId.taxId for currentUser.role != admin
        strategy: redact                          // DRAFT
    }
  }
}

api SalesApi {
  expose Sales.Order, Sales.RetailOrder, Sales.WholesaleOrder
  urlStyle: resource

  query listOrders(
        filter: Order from fromActiveStatus,
        minTotal: Money from havingTotalAbove)
    -> Paged<Order>
    loads: self.customerId, self.items

  status NotFound            code 404
  status ValidationFailed    code 422
  status AlreadyCancelled    code 409
  status InventoryUnavailable code 409
}

// Aggregate-to-physical bindings (keyword TBD)
storage SalesApiBindings {
  use pg          for [Identity.User, Catalog.Product,
                       Sales.RetailOrder, Sales.WholesaleOrder]
  use orderEvents for [Sales.Order]
}

deployable salesBackend {
  platform: node { framework: hono }
  api: SalesApi
  style: layered
  persistence: drizzle
}

deployable salesAdmin {
  platform: dotnet
  api: SalesApi
  style: cqrs
  persistence: efCore
}

deployable salesUi {
  platform: react
  ui: SalesUi
  layout: standard
  i18n { runtime: react-intl }
}

ui SalesUi {
  layout AppShell {
    header  AppHeader
    sidebar AppNav
    main    sentinel
  }

  pages
    OrdersList {
      route: "/orders"
      layout: AppShell
      Heading "Orders"
      List of Order via listOrders(fromActiveStatus)
    }

    OrderDetail {
      route: "/orders/:id"
      layout: AppShell
      MasterDetail of Order
      OperationForm for cancel
    }

    NewRetailOrder {
      route: "/orders/new"
      layout: AppShell
      CreateForm of RetailOrder.place
    }
}

text PromoBanner =                                // DRAFT
  "Get 10% off your next ${count, plural, one {order} other {orders}}"
  notes: "Homepage banner — explicit named entry"

text EmptyOrders =                                // DRAFT
  "No orders yet. ${link, link, {Start one}}"
  notes: "Empty state on /orders"
```

### Feature → location map

| Feature (proposal) | Where in example |
|---|---|
| Multi-tenancy | `system.tenancy by user.tenantId`; `crossTenant` on `Country` |
| Aggregate inheritance + D-RENAME | `abstract aggregate Order { inheritanceStrategy: shareTable }`; `RetailOrder extends Order` |
| Per-aggregate persistence | `persistenceStrategy: eventSourced / stateBased` |
| Logical binding (keyword TBD) | `storage orderEvents { use: pg, for: [Sales.Order] }`; `storage SalesApiBindings` |
| Per-deployable `style` / `persistence` / `layout` | each `deployable { … }` |
| Lifecycle-operations + D-LIFECYCLE-VERB | `create place`, `operation cancel`, `destroy archive`; `urlStyle: resource` |
| Loom-forms | `CreateForm of RetailOrder.place`, `OperationForm for cancel` |
| Criterion | `criterion fromActiveStatus`, `criterion havingTotalAbove(...)`; `when fromActiveStatus`; `from fromActiveStatus` |
| Payload-transport (tagged union) | `payload OrderActivity = OrderPlaced \| …` |
| Exception-less (`error`, `?`, status mapping) | `error AlreadyCancelled`; `reserveInventory ?`; `status … code …` |
| Partial-update | `command updateShipping … option` |
| Load-specifications | `query listOrders(...) loads: self.customerId, self.items` |
| Pagination | `Paged<Order>` return; `unpaged` on `Country` |
| Provenance | `total: Money provenanced` |
| Audit (promoted) | `audited(actions, access)` |
| Sensitivity + masking | `sensitive(pii)`; `mask … strategy:` (DRAFT) |
| Authorization | each `policy { data, operations, fields }` block |
| i18n (DRAFT) | user-visible strings + `text PromoBanner = …`; `locales en, es, fr` |
| Private workflow + workflow-calls-workflow | `private workflow chargePayment`; `chargePayment ?` |
| Execution-context | compiler-emitted |
| Observability | compiler-emitted |
| Encrypted-at-rest | not authored — Phase 5 deferred |
