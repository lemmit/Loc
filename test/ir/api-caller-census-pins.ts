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
// The reasons are shared constants rather than 13 hand-written sentences —
// the gaps fall into a handful of classes, and the class is the honest
// explanation.  EVERY remaining pin is now in a class that is NOT an
// un-authored test: `tenantRegistryRow` (10), `unseededListRead` (2) and
// `gateProbe` (1) name routes that **cannot be driven from the `test e2e`
// surface as it stands**, so no amount of test writing drains them — each needs
// a change to the harness, the fixture set, or the DSL.  Keeping that
// distinction is the point of writing the reason down: an un-authored pin is
// work, an unreachable pin is a finding.
//
// `autoFindAll` and `destroy` USED to be in the unreachable class — 104 of the
// 216 pins were those two routes, together the delete and list paths of every
// generated system.  Both became reachable (#2429: `api.x.all()` →
// `GET /api/<aggs>`, `api.x.destroy(id)` → `DELETE /api/<aggs>/{id}`), and both
// are now fully drained.
//
// COUNT HISTORY.  216 (#2380, the census) → 210 (#2429, destroy + all reach
// their routes) → 126 (the `crudishUpdate` drain) → 13 (this change).
//
// The 113 drained here are the two big remaining classes and their tails —
// `destroy` (41), `autoFindAll` (53), plus the `getById` (9), `domainOp` (5)
// and `declaredFind` (3) the list/delete scenarios pass through — plus the
// `unseedableAggregate` class (4), whose EXIT is a fixture change: `corpus/
// scaffold-macros`' `Item` gained an author-declared `create`, because
// `crudish(updateOnly: true)` suppresses the canonical create as well as the
// canonical destroy and `softDeletable` supplies neither, so the aggregate had
// no api-mintable row and its soft-delete lifecycle had never run at runtime on
// any backend.  (Seeding it instead does not work — see `unseededListRead`.)
//
// WHAT THE 113 CALLERS FOUND — the reason to write them, recorded here because
// each is a live gap the census surfaced and nothing else could:
//
//   1. `deriveContextOperations` declared TWO route families no backend mounts,
//      and the five typed in-system api-clients render their method lists from
//      it — so each generated client carried callers that could only ever 404:
//        • `GET /api/<bases>/{id}` for ABSTRACT aggregates.  `docs/inheritance.md`
//          says an abstract base "owns no table, repository, controller, or
//          routes" and every backend skips one before its controller emitter.
//        • `POST /api/<aggs>/{id}/<op>` for PRIVATE operations.  `docs/
//          language.md` defines one as "only callable from within the same
//          aggregate root"; every route emitter filters `visibility === "public"`.
//      Both fixed in `src/ir/util/api-surface.ts` (the derivation was the lone
//      outlier against a declared contract, with all five backends agreeing).
//      Pins removed as STALE rather than drained: `getPartyById`/`getAssetById`
//      (inheritance), `getVehicleById` (tph + inheritance),
//      `getPaymentMethodById` (payments), `recalcOrder` (audited).
//   2. `softDelete`'s `restore()` cannot be invoked.  `softDeletable`
//      contributes `filter !this.isDeleted`, every backend narrows an
//      operation's load-before-write by the capability filters (that is what
//      makes a cross-tenant `update`/`destroy` 404 in the tenancy fixtures), so
//      a soft-deleted row can never come back: `POST /api/items/{id}/restore`
//      answers the RS-27 404 on every backend.  No backend is an outlier, and
//      the repair turns on whether a capability read filter should scope an
//      operation load at all — `softDeletable` and `tenantOwned` want opposite
//      answers from one mechanism — so it is REPORTED, not fixed here.
//      `corpus/scaffold-macros` pins the wrong answer out loud, with the wanted
//      assertion commented beside it, so a fix must flip it.
//   3. The behavioural legs disagree about first-boot SEEDS — see
//      `unseededListRead` below; two pins stay because of it.
//   4. Referential integrity is invisible on the oracle backend.  A cross-
//      aggregate `X id` is emitted as a foreign key with ON DELETE RESTRICT
//      (`migrations-builder.ts`), but the node behavioural leg builds its PGlite
//      schema from the DRIZZLE metadata (`web/src/runtime/ddl.ts`), which
//      carries no foreign keys at all — so `DELETE` of a referenced row answers
//      204 there and is refused on the four legs that run the emitted migration
//      chain.  Every destroy caller below is therefore written on an
//      UNREFERENCED row, and `corpus/saga` records the reproducer at the site.
//   5. java answered an EMPTY BODY on every find-absence 404 — the `T option`
//      and `T?` arms returned `ResponseEntity.notFound().build()`, Spring's own
//      bare 404, which never reaches the `@RestControllerAdvice`.  A straight
//      RS-22 violation and the identical defect RS-27 fixed on the by-id read,
//      at the two arms nobody had converted; RS-27's own scope note had recorded
//      this path as agreed because no test drove it.  A LONE OUTLIER against a
//      declared rule, so FIXED (`emit/common.ts` → `JAVA_FIND_ABSENCE_THROW`);
//      one java generator test had pinned the bare 404 AS INTENT and is
//      inverted, with the old contract left visible.
//   6. An ENUM column has two different types depending on which schema source
//      is read, so `ORDER BY` over it disagrees.  The emitted migration chain
//      says `TEXT` (lexicographic); the emitted Drizzle schema says `pgEnum`, a
//      native pg type (declaration order); the node behavioural leg uses the
//      latter and every other leg the former — so the node COMPOSE stack sorts
//      like python, not like its own behavioural leg.  Same root as (4): one
//      backend, two schema sources, no gate between them.  Reported, not fixed
//      (a representation decision); the two sorted reads that hit it now sort by
//      a timestamp instead, with the finding written down at both sites.
//
// WHAT IS LEFT, by class: tenantRegistryRow 10, unseededListRead 2, gateProbe 1.

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
   *
   * FULLY DRAINED — no pin carries this reason.  Kept, like `crudishUpdate` and
   * `create` below, because the class recurs the moment a new fixture adds an
   * aggregate whose list route nothing reads, and the census will name it here.
   *
   * Two rules the 53 callers had to obey, both learned the hard way and worth
   * repeating for the next one:
   *   • a read returning MORE THAN ONE row passes `{ sort, dir }`, because the
   *     wire golden compares whole bodies and diffs item ORDER as its own
   *     divergence kind.  A bare-ARRAY `all` (event-sourced / document /
   *     embedded / inheritance subtype) has no sort param at all, so those are
   *     written to read 0 or 1 rows — see `systems/ledger` and `corpus/tph`.
   *   • the count beside the page (`total`) is a SECOND query, so a
   *     capability-filtered fixture asserts it explicitly: a count that skipped
   *     the tenant/criterion predicate is a leak no `items`-only assertion sees.
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
   * id-taking route on it (`getById`, `update`, and the `softDelete`/`restore`
   * ops) is therefore undrivable from a `test e2e` block.
   *
   * EXITED — no pin carries this reason.  The four that did were
   * `corpus/scaffold-macros`' `Item`, the aggregate whose whole point is the
   * soft-delete lifecycle, which had therefore never run at runtime on any
   * backend.  Of the two exits available:
   *   • SEED the rows — ruled out empirically.  The node behavioural leg
   *     composes `createApp` directly and never calls `runSeeds`, which the
   *     generated entrypoints run at boot, so a seeded row would exist on four
   *     legs and be missing on the oracle (see `unseededListRead`).
   *   • give `Item` a create — taken.  It costs no coverage: what
   *     `crudish(updateOnly:)` uniquely promises (emits `update`, suppresses
   *     create + destroy) is pinned at the AST level on its own inline fixture
   *     in `test/macro/crudish.test.ts`, which is a stronger statement than any
   *     route-level observation, and the corpus fixture is freed to prove the
   *     thing only a booted backend can.
   * Driving it immediately found that `restore()` cannot be invoked at all —
   * see item 2 in the header.  Kept as a class because the shape recurs.
   */
  unseedableAggregate:
    "unreachable: crudish(updateOnly:) emits no create route, so no row can be minted through the api",
  /**
   * UNREACHABLE — a COLLECTION read on an aggregate carrying first-boot SEED
   * data.  Not a property of the route: a property of the harness.  The four
   * cross-backend behavioural legs boot the generated entrypoint, which calls
   * `runSeeds` after migrating (`index.ts` / `app/main.py` / …), while the node
   * leg — the wire-golden ORACLE — composes `createApp` directly and never
   * reaches it.  So the same table starts with the `default` dataset's rows on
   * four legs and empty on the fifth.
   *
   * A by-id read cannot see that; a collection read sees nothing else.  And the
   * wire golden compares whole bodies, so writing `api.widgets.all()` would
   * encode a harness gap as a wire divergence on four backends at once — the
   * shape the ratchet exists to keep out.
   *
   * Draining these needs the harness fixed (run the seeder on the node leg, or
   * make the seed application explicit and uniform), not a test.  It is also a
   * coverage finding in its own right: `seed` datasets have NO runtime coverage
   * on the oracle backend today.
   */
  unseededListRead:
    "unreachable: the node leg never runs runSeeds, so a collection read starts from a different table than the other four legs",
  /**
   * UN-AUTHORED — the canonical destroy (`DELETE /api/<aggs>/{id}`, 204 empty).
   * Reachable since #2429 as `api.<aggs>.destroy(id)`.  Previously
   * UNREACHABLE for a subtler reason than a wrong path: the canonical destroy
   * is not in `agg.operations` at all (lowering keeps it on
   * `agg.canonicalDestroy`), so the verb was rejected as an unknown method and
   * the test could not even be written.  The write-path-never-driven class of
   * `experience_gathered.md` §59.
   *
   * FULLY DRAINED — no pin carries this reason.  Kept because the class recurs
   * on the next `crudish` aggregate nothing deletes.
   *
   * The rule the 41 callers had to obey: delete an UNREFERENCED row.  A
   * cross-aggregate `X id` is emitted as a foreign key with ON DELETE RESTRICT,
   * a containment's is ON DELETE CASCADE — and the node leg's PGlite schema,
   * synthesized from the Drizzle metadata, has NEITHER (item 4 in the header).
   * So a destroy of a referenced row 204s on the oracle and is refused on the
   * other four.  Where the referenced row was the interesting one
   * (`corpus/saga`), the caller deletes an unreferenced sibling and the site
   * carries the reproducer instead of an assertion.
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
   *  usually uncalled because the fixture asserts through a find instead.
   *  At zero: the destroy scenarios all read the row back after the DELETE, so
   *  the by-id route came free with the 404 probe. */
  getById: "un-authored: reachable as api.x.getById(id)",
  /** UN-AUTHORED — `POST /api/<aggs>` create.  Reachable as `api.x.create({…})`;
   *  uncalled on aggregates the fixture never seeds (a subtype, a second
   *  aggregate the scenario reads only).  At zero. */
  create: "un-authored: reachable as api.x.create({…})",
  /** UN-AUTHORED — a declared repository find.  Reachable as
   *  `api.x.<find>({…})`.  At zero: a delete is only proven by re-reading
   *  through EVERY route that used to answer, the declared finds included. */
  declaredFind: "un-authored: reachable as api.x.<find>({…})",
  /** UN-AUTHORED — a declared domain operation.  Reachable as
   *  `api.x.<op>(id, {…})`.  At zero. */
  domainOp: "un-authored: reachable as api.x.<op>(id, {…})",
} as const;

/** `<case key> → { <derived operationId>: reason }`.  Case keys match
 *  `POPULATION` in `api-caller-census.test.ts`. */
export const UNCALLED_PINS: Record<string, Record<string, string>> = {
  // ── The two TENANT REGISTRIES ────────────────────────────────────────────
  // Ten pins, one cause: the derived self-scope filter narrows every read (and
  // every write's load-before-save) to the row whose id IS the principal's
  // claim, and the harness principal's claim is not a row id.  See
  // `R.tenantRegistryRow` — draining them needs a harness change, not a test.
  "corpus/tenancy-owned": {
    // `Organization` is this system's TENANT REGISTRY.
    createOrganization: R.tenantRegistryRow,
    getOrganizationById: R.tenantRegistryRow,
    destroyOrganization: R.tenantRegistryRow,
    updateOrganization: R.tenantRegistryRow,
    allOrganization: R.tenantRegistryRow,
  },
  "corpus/tenancy-claim-name": {
    // Same registry class, under the `orgId` claim.
    createOrganization: R.tenantRegistryRow,
    getOrganizationById: R.tenantRegistryRow,
    destroyOrganization: R.tenantRegistryRow,
    updateOrganization: R.tenantRegistryRow,
    allOrganization: R.tenantRegistryRow,
  },
  // ── The SEEDED collection reads ──────────────────────────────────────────
  // The only fixture whose tables do not start empty, and the behavioural legs
  // disagree about that — so a collection read here would record a harness gap
  // as a wire divergence on four backends at once.  Both aggregates' by-id
  // routes ARE driven (create / getById / update / destroy); only the two list
  // reads are held.  See `R.unseededListRead`.
  "corpus/seeding": {
    allWidget: R.unseededListRead,
    allGadget: R.unseededListRead,
  },
  // ── The `when`-gate probe ────────────────────────────────────────────────
  // The one route with no `test e2e` verb at all.  The gate itself is
  // exercised: the 409 on the gated operation, and — added by this drain — the
  // canonical DELETE on the very row the gate refused, which must NOT inherit
  // it.  Only the `can_<op>` endpoint a UI polls stays uncalled.
  "corpus/state-gate": {
    canCancelOrder: R.gateProbe,
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
  // The QUERY-TIME projection reads (`GET /api/projections/<snake>`) — same
  // `notLifted` class as the folded projection above, one shape further along:
  // a singleton whole-table aggregation and the grouped read models.  The
  // derivation lists aggregate routes; a projection is not an aggregate, so
  // these credit no derived operation even though they are the whole point of
  // their fixtures.
  "corpus/projection-aggregation": [
    "api.orderVolume.list (no such aggregate)",
    "api.salesTotals.list (no such aggregate)",
  ],
  "corpus/projection-groupby": [
    "api.revenueByDay.list (no such aggregate)",
    "api.salesByStatus.list (no such aggregate)",
    "api.volumeByCustomerAndStatus.list (no such aggregate)",
  ],
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
  // The lifecycle `requires` gate.  ENFORCEMENT is pinned structurally per
  // backend in `test/generator/lifecycle-guard-render.test.ts` (mutation-proven
  // against ten seeded emitter defects), but no RUNTIME caller exercises it, and
  // the two reasons are worth stating rather than hiding: an e2e proving the 403
  // needs a principal whose `permissions` claim the behavioural harness does not
  // mint (the OIDC fixture's mock issuer supplies `realm_access.roles` and
  // nothing else), and the e2e DSL has no negative-status assertion form to
  // spell a denial with — every emitted block asserts a SUCCESSFUL path.  The
  // runtime negative-authz proof for `requires` lives in the M-T3.13 OIDC e2e
  // legs; extending it to the lifecycle gate is M-T9.13's drain, not this
  // slice's.
  "lifecycle-guard",
  "outbox",
  // `deny` compiles on all five backends (that is what the fixture was added
  // for — see docs/new-plan T3 M-T3.3), but nothing calls a denied aggregate's
  // routes at runtime, so "a denied read 404s / lists empty over HTTP" is still
  // unproven.  Registered rather than silently absent: before this fixture the
  // feature had no `.ddd` at all, so it could not even appear on this list.
  "policy-deny",
  // The `shape: document` × authz crossing (pairwise F1).  Codegen CRASHED on
  // node/java/python until the in-app desugar landed, so the fixture's first job
  // is the compile tier — but "the deep ladder actually hides an out-of-subtree
  // document row over HTTP" is still unproven at runtime.  A runtime caller here
  // needs an AUTHENTICATED principal (the ladder is meaningless without one),
  // which is the multi-principal harness work, not this fixture's.  The emitted
  // predicate IS executed against fabricated rows in
  // `test/generator/policy-document-inapp.test.ts`, so the filtering semantics
  // are proven — just not end-to-end over the wire.
  "policy-document",
  // `read-gates` exists for the COMPILE tier: it carries the three read
  // surfaces that take a `requires` gate (the gated list read, a folded
  // projection, a query-time projection) so every backend's emitted guard is
  // proven to compile — the failure mode that unit assertions over generated
  // TEXT cannot see (a missing `java.util.Objects` import, a `ForbiddenError`
  // python never imported, a bound-and-unused `current_user` that trips
  // `--warnings-as-errors`).
  //
  // The runtime half needs a principal the harness does not have. Asserting a
  // read gate means asserting the 403, and that takes an AUTHENTICATED-BUT-
  // UNAUTHORIZED caller; `DEV_CLAIMS` is a single authorized principal, so the
  // only thing an e2e block here could assert is that the gate lets the
  // authorized caller through — which is what `auth-simple`'s guarded
  // operation already proves for the write side. M-T9.28 (multi-principal
  // behavioural harness) is what makes the denial assertable; this entry
  // drops when it lands.
  "read-gates",
  "resources",
  "tenancy-hierarchy",
];
