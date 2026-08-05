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
// The reasons are shared constants rather than 210 hand-written sentences —
// the gaps fall into a handful of classes, and the class is the honest
// explanation.  ONE class (`gateProbe`, 1 pin) is still NOT an un-authored test:
// that route is **unreachable from the `test e2e` surface**, so it cannot be
// drained by writing a test.  That distinction is the point of writing the
// reason down.
//
// `autoFindAll` and `destroy` USED to be in that unreachable class — 104 of the
// 216 pins were those two routes, together the delete and list paths of every
// generated system.  Both became reachable (`api.x.all()` → `GET /api/<aggs>`,
// `api.x.destroy(id)` → `DELETE /api/<aggs>/{id}`), 6 were drained on the spot
// across three corpus fixtures, and the remaining 98 are re-tagged as
// UN-AUTHORED: an ordinary drain-list that shrinks by writing tests, exactly
// like `crudishUpdate` / `getById` / `create`.

/** Why an operation is pinned.  Grouped by CLASS — see the header. */
export const R = {
  /**
   * UN-AUTHORED — the auto-`findAll` (`GET /api/<aggs>`, the bare collection
   * root; the paged envelope, or a bare array where `all` is typed `T[]` —
   * event-sourced / document / subtype).  Reachable since this PR as
   * `api.<aggs>.all()`, optionally `all({ page, pageSize, sort, dir })`:
   * `renderFindCall` routes the `all` find to the root rather than to
   * `/<aggs>/all`, which is the path no backend mounts and the reason this
   * class was previously UNREACHABLE.
   * Drained where written: `corpus/core-domain`, `corpus/single-containment`,
   * `corpus/value-collections`.
   */
  autoFindAll: "un-authored: reachable as api.x.all() — the root list route GET /api/<aggs>",
  /**
   * UN-AUTHORED — the canonical destroy (`DELETE /api/<aggs>/{id}`, 204 empty).
   * Reachable since this PR as `api.<aggs>.destroy(id)`.  Previously
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
   * by hand precisely because no test called it.  The highest-value drain in
   * this file.
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
    getPaymentMethodById: R.getById,
    byNetworkCreditCard: R.declaredFind,
    destroyCreditCard: R.destroy,
    updateCreditCard: R.crudishUpdate,
    allCreditCard: R.autoFindAll,
    destroyBankAccount: R.destroy,
    updateBankAccount: R.crudishUpdate,
    allBankAccount: R.autoFindAll,
  },
  "systems/sales": {
    destroyCustomer: R.destroy,
    updateCustomer: R.crudishUpdate,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    updateProduct: R.crudishUpdate,
    allProduct: R.autoFindAll,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "systems/shapes": {
    getCustomerById: R.getById,
    allCustomer: R.autoFindAll,
    allCart: R.autoFindAll,
    allWishlist: R.autoFindAll,
  },
  "systems/wire-contract": {
    bySkuListing: R.declaredFind,
    destroyListing: R.destroy,
    updateListing: R.crudishUpdate,
    allListing: R.autoFindAll,
  },
  "broad/sales-system": {
    getCustomerById: R.getById,
    destroyCustomer: R.destroy,
    updateCustomer: R.crudishUpdate,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    updateProduct: R.crudishUpdate,
    allProduct: R.autoFindAll,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "broad/storefront-system": {
    getCustomerById: R.getById,
    destroyCustomer: R.destroy,
    updateCustomer: R.crudishUpdate,
    allCustomer: R.autoFindAll,
    destroyProduct: R.destroy,
    updateProduct: R.crudishUpdate,
    allProduct: R.autoFindAll,
    byOwnerWallet: R.declaredFind,
    openByOwnerWallet: R.declaredFind,
    destroyWallet: R.destroy,
    debitWallet: R.domainOp,
    freezeWallet: R.domainOp,
    updateWallet: R.crudishUpdate,
    allWallet: R.autoFindAll,
    createOrder: R.create,
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    addLineOrder: R.domainOp,
    confirmOrder: R.domainOp,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  // DRAINED: `destroyOrder` + `allOrder` now have callers (the list/delete
  // block added to this fixture's `test e2e`).
  "corpus/core-domain": {
    byStatusOrder: R.declaredFind,
  },
  "corpus/state-gate": {
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    canCancelOrder: R.gateProbe,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/operation-returns": {
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/union-find-absence": {
    maybeFirstOrder: R.declaredFind,
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/paged": {
    inRegionOrder: R.declaredFind,
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  // DRAINED: `destroy` + `all` (the two verbs this PR made reachable).
  "corpus/single-containment": {
    updateOrder: R.crudishUpdate,
  },
  // DRAINED: `destroy` + `all`.
  "corpus/value-collections": {
    updateInvoice: R.crudishUpdate,
  },
  "corpus/document": {
    popularArticle: R.declaredFind,
    destroyArticle: R.destroy,
    bumpArticle: R.domainOp,
    updateArticle: R.crudishUpdate,
    allArticle: R.autoFindAll,
  },
  "corpus/embedded": {
    byCustomerOrder: R.declaredFind,
    destroyOrder: R.destroy,
    retotalOrder: R.domainOp,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/embedded-optional": {
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/inheritance": {
    getPartyById: R.getById,
    byEmailCustomer: R.declaredFind,
    destroyCustomer: R.destroy,
    raiseLimitCustomer: R.domainOp,
    updateCustomer: R.crudishUpdate,
    allCustomer: R.autoFindAll,
    getVendorById: R.getById,
    allVendor: R.autoFindAll,
    getAssetById: R.getById,
    getMachineById: R.getById,
    allMachine: R.autoFindAll,
    getVehicleById: R.getById,
    allVehicle: R.autoFindAll,
  },
  "corpus/tph": {
    getVehicleById: R.getById,
    destroyCar: R.destroy,
    refitCar: R.domainOp,
    updateCar: R.crudishUpdate,
    allCar: R.autoFindAll,
    createTruck: R.create,
    getTruckById: R.getById,
    destroyTruck: R.destroy,
    updateTruck: R.crudishUpdate,
    allTruck: R.autoFindAll,
  },
  "corpus/event-sourcing": {
    allAccount: R.autoFindAll,
  },
  "corpus/eventsourced-workflow": {
    allOrder: R.autoFindAll,
  },
  "corpus/saga": {
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
    getShipmentById: R.getById,
    markTrackedShipment: R.domainOp,
    allShipment: R.autoFindAll,
  },
  "corpus/projection": {
    getOrderById: R.getById,
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/auth-oidc": {
    destroyTicket: R.destroy,
    updateTicket: R.crudishUpdate,
    allTicket: R.autoFindAll,
  },
  "corpus/auth-simple": {
    destroyTicket: R.destroy,
    updateTicket: R.crudishUpdate,
    allTicket: R.autoFindAll,
  },
  "corpus/tenancy-filter": {
    getAccountById: R.getById,
    destroyAccount: R.destroy,
    updateAccount: R.crudishUpdate,
    allAccount: R.autoFindAll,
  },
  "corpus/tenancy-owned": {
    getInvoiceById: R.getById,
    destroyInvoice: R.destroy,
    updateInvoice: R.crudishUpdate,
    allInvoice: R.autoFindAll,
    destroyPlan: R.destroy,
    updatePlan: R.crudishUpdate,
    allPlan: R.autoFindAll,
    createOrganization: R.create,
    getOrganizationById: R.getById,
    destroyOrganization: R.destroy,
    updateOrganization: R.crudishUpdate,
    allOrganization: R.autoFindAll,
  },
  "corpus/stamps": {
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/seeding": {
    destroyWidget: R.destroy,
    updateWidget: R.crudishUpdate,
    allWidget: R.autoFindAll,
    createGadget: R.create,
    getGadgetById: R.getById,
    destroyGadget: R.destroy,
    updateGadget: R.crudishUpdate,
    allGadget: R.autoFindAll,
  },
  "corpus/provenance": {
    byReferenceOrder: R.declaredFind,
    destroyOrder: R.destroy,
    applyDiscountOrder: R.domainOp,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/audited": {
    byReferenceOrder: R.declaredFind,
    destroyOrder: R.destroy,
    recalcOrder: R.domainOp,
    allOrder: R.autoFindAll,
    createShipment: R.create,
    byCodeShipment: R.declaredFind,
    getShipmentById: R.getById,
    destroyShipment: R.destroy,
    dispatchShipment: R.domainOp,
    retagShipment: R.domainOp,
    updateShipment: R.crudishUpdate,
    allShipment: R.autoFindAll,
  },
  "corpus/criterion-filter": {
    destroyOrder: R.destroy,
    updateOrder: R.crudishUpdate,
    allOrder: R.autoFindAll,
  },
  "corpus/domain-services": {
    getAccountById: R.getById,
    destroyAccount: R.destroy,
    withdrawAccount: R.domainOp,
    depositAccount: R.domainOp,
    updateAccount: R.crudishUpdate,
    allAccount: R.autoFindAll,
  },
  "corpus/scaffold-macros": {
    destroyProduct: R.destroy,
    updateProduct: R.crudishUpdate,
    allProduct: R.autoFindAll,
    getItemById: R.getById,
    updateItem: R.crudishUpdate,
    softDeleteItem: R.domainOp,
    restoreItem: R.domainOp,
    allItem: R.autoFindAll,
  },
  // ── fixtures added on main 2026-08-03 (post-census; pinned at rebase) ──
  "corpus/tenancy-claim-name": {
    getInvoiceById: R.getById,
    destroyInvoice: R.destroy,
    updateInvoice: R.crudishUpdate,
    allInvoice: R.autoFindAll,
    createOrganization: R.create,
    getOrganizationById: R.getById,
    destroyOrganization: R.destroy,
    updateOrganization: R.crudishUpdate,
    allOrganization: R.autoFindAll,
  },
  "corpus/field-defaults": {
    destroyItem: R.destroy,
    updateItem: R.crudishUpdate,
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
