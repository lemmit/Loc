// Pinned gaps for the API-operation CALLER CENSUS (`api-caller-census.test.ts`).
//
// Each entry is one DERIVED api operation (`deriveContextOperations`) that NO
// `test e2e` block in its own system calls.  The census is a RATCHET: this map
// must equal the uncovered set EXACTLY, so
//
//   • a NEW derived operation with no caller fails until it is called or pinned;
//   • a pin that stops matching (the op gained a caller, or the op / fixture was
//     renamed or deleted) fails as STALE, so the drain deletes it in the same PR.
//
// The reasons are shared constants rather than 126 hand-written sentences —
// the gaps fall into a handful of classes, and the class is the honest
// explanation.  THREE classes are NOT un-authored tests: `gateProbe` (1 pin),
// `tenantRegistryRow` (10) and `unseedableAggregate` (4) name routes that
// **cannot be driven from the `test e2e` surface at all**, so no amount of test
// writing drains them.  Keeping that distinction is the point of writing the
// reason down: an un-authored pin is work, an unreachable pin is a finding.
//
// `autoFindAll` and `destroy` USED to be in the unreachable class — 104 of the
// 216 pins were those two routes, together the delete and list paths of every
// generated system.  Both became reachable (#2429: `api.x.all()` →
// `GET /api/<aggs>`, `api.x.destroy(id)` → `DELETE /api/<aggs>/{id}`), 6 were
// drained on the spot across three corpus fixtures, and the remaining 98 were
// re-tagged as UN-AUTHORED: an ordinary drain-list that shrinks by writing
// tests, exactly like `crudishUpdate` / `getById` / `create`.
//
// COUNT HISTORY.  216 (#2380, the census) → 210 (#2429, destroy + all reach
// their routes) → 126 (this change).  The 84 drained here are the whole
// `crudishUpdate` class that could be driven — 42 of its 45 pins, every one on
// an aggregate a `test e2e` block can seed — plus the 42 adjacent operations a
// real update scenario passes through anyway (the by-id read that proves the
// write landed, the create for a second aggregate the scenario needed, the
// declared find over the column the update moved, the domain op beside it).
// The three `crudishUpdate` pins left behind are NOT un-authored: they are the
// two tenant registries and the create-less soft-delete aggregate, re-tagged
// below as the unreachable classes they always were.
//
// WHAT IS LEFT, by class: autoFindAll 53, destroy 41, tenantRegistryRow 10,
// getById 9, domainOp 5, unseedableAggregate 4, declaredFind 3, gateProbe 1.
// The two big ones are #2429's re-tagged drain-list — the list and delete paths
// of every generated system — and they are the next drain, not a floor.

/** Why an operation is pinned.  Grouped by CLASS — see the header. */
export const R = {
  /**
   * UN-AUTHORED — the auto-`findAll` (`GET /api/<aggs>`, the bare collection
   * root; the paged envelope, or a bare array where `all` is typed `T[]` —
   * event-sourced / document / subtype).  Reachable since #2429 as
   * `api.<aggs>.all()`, optionally `all({ page, pageSize, sort, dir })`:
   * `renderFindCall` routes the `all` find to the root rather than to
   * `/<aggs>/all`, which is the path no backend mounts and the reason this
   * class was previously UNREACHABLE.
   * Drained where written: `corpus/core-domain`, `corpus/single-containment`,
   * `corpus/value-collections`.
   */
  autoFindAll: "un-authored: reachable as api.x.all() — the root list route GET /api/<aggs>",
  /**
   * UNREACHABLE — a route on the TENANT REGISTRY (`tenancy by user.<claim> of
   * <Registry>`).  Enrichment appends the derived self-scope filter `this.id ==
   * currentUser.<claim>` to the registry's context filters, so EVERY read — and
   * every write's load-before-save — is narrowed to the single row whose id IS
   * the principal's claim.  The behavioural harness authenticates with
   * `tenantId/orgId: "acme"` (`cases.mjs` DEV_CLAIMS), which is not a row id, so
   * a registry row created through the api can never be read, updated or
   * deleted back: `getById`/`update`/`destroy` 404 and `all` is empty.  `create`
   * itself succeeds (a create applies no read filter) but has nothing
   * observable to assert, which is the same gap wearing a different hat.
   *
   * Draining these needs a HARNESS change, not a test: a principal whose claim
   * is a real registry id (the signup-bootstrap path `tenancy-e2e` drives),
   * which is that suite's job, not this fixture's.
   */
  tenantRegistryRow:
    "unreachable: registry self-scope `this.id == currentUser.<claim>` — the harness principal's claim is not a row id",
  /**
   * UNREACHABLE — an aggregate the api cannot SEED.  `with crudish(updateOnly:
   * true)` emits `update` but no canonical `create`, so no `POST /api/<aggs>`
   * route exists and no row can be minted through the api at all; every
   * id-taking route on it (`getById`, `update`, and here the `softDelete` /
   * `restore` ops the fixture exists to cover) is therefore undrivable from a
   * `test e2e` block.  Found by this drain: `corpus/scaffold-macros`' `Item` —
   * the aggregate whose whole point is the soft-delete lifecycle — has no
   * api-reachable row, so that lifecycle has never run at runtime on any
   * backend.  The exit is a fixture change (give `Item` a create path, or drive
   * it through a seed dataset), not a caller.
   */
  unseedableAggregate:
    "unreachable: crudish(updateOnly:) emits no create route, so no row can be minted through the api",
  /**
   * UN-AUTHORED — the canonical destroy (`DELETE /api/<aggs>/{id}`, 204 empty).
   * Reachable since #2429 as `api.<aggs>.destroy(id)`.  Previously
   * UNREACHABLE for a subtler reason than a wrong path: the canonical destroy
   * is not in `agg.operations` at all (lowering keeps it on
   * `agg.canonicalDestroy`), so the verb was rejected as an unknown method and
   * the test could not even be written.  The write-path-never-driven class of
   * `experience_gathered.md` §59.  Drained where written: `corpus/core-domain`,
   * `corpus/single-containment`, `corpus/value-collections`.
   */
  destroy: "un-authored: reachable as api.x.destroy(id) — the canonical DELETE (204, no body)",
  /**
   * UNREACHABLE — the `when`-gate probe (`GET /api/<aggs>/{id}/can_<op>`).  The
   * e2e DSL exposes no `can*` verb; the gate itself IS exercised (the corpus
   * `state-gate` fixture asserts the 409 on the gated operation), but the probe
   * endpoint a UI polls is never called.
   */
  gateProbe:
    "unreachable: e2e has no can_<op> probe verb (the gate's 409 is exercised via the operation)",
  /**
   * UN-AUTHORED — `crudish`'s canonical `update` (`POST /api/<aggs>/{id}/update`).
   * Reachable today (`api.<aggs>.update(id, { … })`), simply never written.
   * This is the exact route #2342 found carrying TWO contract bugs (a PATCH the
   * spec never advertised, and a 200-with-body against a declared 204) — found
   * by hand precisely because no test called it.  It WAS the highest-value
   * drain in this file: 42 of its 45 pins were drained by writing real callers
   * (one per aggregate a `test e2e` block can seed), each asserting a read-back
   * that proves the write landed rather than only that the route answered.  The
   * three that remain are re-tagged `tenantRegistryRow` / `unseedableAggregate`
   * — they were never un-authored, and this drain is what showed it.  So NO PIN
   * carries this reason today; it is kept (like `create` below, also at zero)
   * because the class recurs the moment a new fixture adds a `crudish`
   * aggregate without a caller, and the census will name it here.
   */
  crudishUpdate: "un-authored: reachable as api.x.update(id, {…}) — the zero-caller route of #2342",
  /** UN-AUTHORED — `GET /api/<aggs>/{id}`.  Reachable as `api.x.getById(id)`;
   *  usually uncalled because the fixture asserts through a find instead. */
  getById: "un-authored: reachable as api.x.getById(id)",
  /** UN-AUTHORED — `POST /api/<aggs>` create.  Reachable as `api.x.create({…})`;
   *  uncalled on aggregates the fixture never seeds (a subtype, a second
   *  aggregate the scenario reads only). */
  create: "un-authored: reachable as api.x.create({…})",
  /** UN-AUTHORED — a declared repository find.  Reachable as
   *  `api.x.<find>({…})`. */
  declaredFind: "un-authored: reachable as api.x.<find>({…})",
  /** UN-AUTHORED — a declared domain operation.  Reachable as
   *  `api.x.<op>(id, {…})`. */
  domainOp: "un-authored: reachable as api.x.<op>(id, {…})",
} as const;

/** `<case key> → { <derived operationId>: reason }`.  Case keys match
 *  `POPULATION` in `api-caller-census.test.ts`. */
export const UNCALLED_PINS: Record<string, Record<string, string>> = {
  "systems/ledger": {
    allAccount: R.autoFindAll,
  },
  "systems/payments": {
    byNetworkCreditCard: R.declaredFind,
    getPaymentMethodById: R.getById,
    destroyCreditCard: R.destroy,
    allCreditCard: R.autoFindAll,
    destroyBankAccount: R.destroy,
    allBankAccount: R.autoFindAll,
  },
  "systems/sales": {
    destroyCustomer: R.destroy,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    allProduct: R.autoFindAll,
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "systems/shapes": {
    getCustomerById: R.getById,
    allCustomer: R.autoFindAll,
    allCart: R.autoFindAll,
    allWishlist: R.autoFindAll,
  },
  "systems/wire-contract": {
    destroyListing: R.destroy,
    allListing: R.autoFindAll,
  },
  "broad/sales-system": {
    destroyCustomer: R.destroy,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    allProduct: R.autoFindAll,
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "broad/storefront-system": {
    destroyCustomer: R.destroy,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    allProduct: R.autoFindAll,
    destroyWallet: R.destroy,
    allWallet: R.autoFindAll,
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  // DRAINED: `destroyOrder` + `allOrder` now have callers (the list/delete
  // block added to this fixture's `test e2e`).
  "corpus/core-domain": {
    byStatusOrder: R.declaredFind,
  },
  "corpus/state-gate": {
    destroyOrder: R.destroy,
    canCancelOrder: R.gateProbe,
    allOrder: R.autoFindAll,
  },
  "corpus/operation-returns": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/union-find-absence": {
    maybeFirstOrder: R.declaredFind,
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/paged": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  // FULLY DRAINED — every derived operation of these two fixtures now has a
  // caller (`destroy` + `all` in #2429, `update` here), so they carry no pins
  // at all.  Deliberately absent rather than present-and-empty: an empty record
  // would read as "checked, nothing to say" when the truth is "nothing left".
  "corpus/document": {
    destroyArticle: R.destroy,
    allArticle: R.autoFindAll,
  },
  "corpus/embedded": {
    destroyOrder: R.destroy,
    retotalOrder: R.domainOp,
    allOrder: R.autoFindAll,
  },
  "corpus/embedded-optional": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/inheritance": {
    byEmailCustomer: R.declaredFind,
    getPartyById: R.getById,
    destroyCustomer: R.destroy,
    allCustomer: R.autoFindAll,
    getVendorById: R.getById,
    allVendor: R.autoFindAll,
    getMachineById: R.getById,
    allMachine: R.autoFindAll,
    getVehicleById: R.getById,
    allVehicle: R.autoFindAll,
  },
  "corpus/tph": {
    destroyCar: R.destroy,
    allCar: R.autoFindAll,
    destroyTruck: R.destroy,
    allTruck: R.autoFindAll,
  },
  "corpus/event-sourcing": {
    allAccount: R.autoFindAll,
  },
  "corpus/eventsourced-workflow": {
    allOrder: R.autoFindAll,
  },
  "corpus/saga": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
    markTrackedShipment: R.domainOp,
    allShipment: R.autoFindAll,
  },
  "corpus/projection": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/auth-oidc": {
    destroyTicket: R.destroy,
    allTicket: R.autoFindAll,
  },
  "corpus/auth-simple": {
    destroyTicket: R.destroy,
    allTicket: R.autoFindAll,
  },
  "corpus/tenancy-filter": {
    destroyAccount: R.destroy,
    allAccount: R.autoFindAll,
  },
  "corpus/tenancy-owned": {
    destroyInvoice: R.destroy,
    allInvoice: R.autoFindAll,
    destroyPlan: R.destroy,
    allPlan: R.autoFindAll,
    // `Organization` is this system's TENANT REGISTRY — see `R.tenantRegistryRow`.
    createOrganization: R.tenantRegistryRow,
    getOrganizationById: R.tenantRegistryRow,
    destroyOrganization: R.tenantRegistryRow,
    updateOrganization: R.tenantRegistryRow,
    allOrganization: R.tenantRegistryRow,
  },
  "corpus/stamps": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/seeding": {
    destroyWidget: R.destroy,
    allWidget: R.autoFindAll,
    destroyGadget: R.destroy,
    allGadget: R.autoFindAll,
  },
  "corpus/provenance": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/audited": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
    destroyShipment: R.destroy,
    allShipment: R.autoFindAll,
  },
  "corpus/criterion-filter": {
    destroyOrder: R.destroy,
    allOrder: R.autoFindAll,
  },
  "corpus/domain-services": {
    destroyAccount: R.destroy,
    withdrawAccount: R.domainOp,
    depositAccount: R.domainOp,
    allAccount: R.autoFindAll,
  },
  "corpus/scaffold-macros": {
    destroyProduct: R.destroy,
    allProduct: R.autoFindAll,
    // `Item` is `with crudish(updateOnly: true), softDeletable, softDelete` —
    // no canonical create, hence no `POST /api/items`, hence no row to address.
    // See `R.unseedableAggregate`; `allItem` stays an ordinary un-authored pin
    // (a list read of an empty table is drivable, just not worth asserting
    // until the aggregate can be seeded).
    getItemById: R.unseedableAggregate,
    updateItem: R.unseedableAggregate,
    softDeleteItem: R.unseedableAggregate,
    restoreItem: R.unseedableAggregate,
    allItem: R.autoFindAll,
  },
  // ── fixtures added on main 2026-08-03 (post-census; pinned at rebase) ──
  "corpus/tenancy-claim-name": {
    destroyInvoice: R.destroy,
    allInvoice: R.autoFindAll,
    // Same registry class as `corpus/tenancy-owned`, under the `orgId` claim.
    createOrganization: R.tenantRegistryRow,
    getOrganizationById: R.tenantRegistryRow,
    destroyOrganization: R.tenantRegistryRow,
    updateOrganization: R.tenantRegistryRow,
    allOrganization: R.tenantRegistryRow,
  },
  "corpus/field-defaults": {
    destroyItem: R.destroy,
    allItem: R.autoFindAll,
  },
  "corpus/audit-history": {
    byReferenceOrder: R.declaredFind,
    getOrderById: R.getById,
    allOrder: R.autoFindAll,
  },
};

/**
 * `api.<slug>.<method>` calls that map to NO derived operation, per case.
 *
 * Such a call credits no coverage, so it must be an explicit, reviewed entry
 * rather than something the census silently drops: a projection read or a
 * workflow run (`apiSurfaceCoverage.notLifted` — the derivation does not cover
 * those route classes yet) is legitimate; anything else means the attribution
 * is broken and an operation is about to look uncovered for the wrong reason.
 */
export const UNATTRIBUTED_CALLS: Record<string, readonly string[]> = {
  // `api.orderBoard.byKey(...)` reads a folded PROJECTION
  // (`GET /api/projections/order_board/{key}`), which `deriveContextOperations`
  // lists under `apiSurfaceCoverage.notLifted`.  Lifting projection queries into
  // the derivation would make this attributable — and this entry stale.
  "corpus/projection": ["api.orderBoard.byKey (no such aggregate)"],
  // `api.orders.history(...)` reads the entity-history endpoint over
  // `audit_records` (#2378) — a machinery read `deriveContextOperations` does
  // not lift (same class as projection reads).  Lifting it would make this
  // attributable — and this entry stale.
  "corpus/audit-history": ["api.orders.history (no derived operation)"],
};

/**
 * Corpus fixtures carrying NO `test e2e` block at all.  They are OUT of the
 * census population — nothing to attribute a caller to — but they are listed
 * here rather than silently skipped, because "no e2e block" is a bigger gap
 * than "one uncovered operation": the whole feature has no runtime caller.
 * Authoring those blocks is M-T9.13's drain, not this gate's.
 *
 * Ratchets the other way: when a fixture gains a `test e2e` block it drops out
 * of this list, the census gains a case, and BOTH halves fail until the entry
 * is deleted and the new case's pins are written.
 */
export const E2E_LESS_CORPUS_FIXTURES: readonly string[] = [
  "api-call",
  "channels-broker",
  "extern",
  "extern-handlers",
  "field-mask",
  "outbox",
  "projection-aggregation",
  "projection-groupby",
  "resources",
  "tenancy-hierarchy",
];
