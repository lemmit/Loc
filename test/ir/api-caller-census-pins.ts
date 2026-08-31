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
// The reasons are shared constants rather than 18 hand-written sentences —
// the gaps fall into a handful of classes, and the class is the honest
// explanation.  Keeping that distinction is the point of writing the reason
// down: an un-authored pin is work, an unreachable pin is a finding.
//
// UNREACHABLE from the `test e2e` surface as it stands — no amount of test
// writing drains these; each needs a change to the harness, an emitter, or the
// DSL: `tenantRegistryRow` (15) and `gateProbe` (1).
//
// UN-AUTHORED — writable today, nobody has written them:
// `seededListReadUnwritten` (2).
//
// That second class was empty until M-T6.37 and is the interesting movement
// here.  `unseededListRead` exited by having its HARNESS fixed (#2517): the node
// leg now runs the emitted first-boot seeder, so the ORACLE reads the same table
// as its four peers.  Fixing it exposed the next leg along — elixir emitted no
// seeder at all (B19) — and the same two routes stayed pinned as UNREACHABLE
// under the successor reason, with the seeded-value assertions living in the
// sibling `corpus/seed-values` fixture that leg was held off.  M-T6.37 has now
// landed that seeder and deleted the `seed-values` skip, so all five legs seed
// identically and the two routes became writable: they are RECLASSIFIED, not
// re-caused.  Draining them rebaselines `corpus/seeding`'s wire golden on every
// leg, which wants its own PR — see `seededListReadUnwritten`.
//
// `autoFindAll` and `destroy` USED to be in the unreachable class — 104 of the
// 216 pins were those two routes, together the delete and list paths of every
// generated system.  Both became reachable (#2429: `api.x.all()` →
// `GET /api/<aggs>`, `api.x.destroy(id)` → `DELETE /api/<aggs>/{id}`), and both
// are now fully drained.
//
// COUNT HISTORY.  216 (#2380, the census) → 210 (#2429, destroy + all reach
// their routes) → 126 (the `crudishUpdate` drain) → 13 (the destroy/all drain)
// → 18 (#2517: +5 for `policy-deny`'s registry, which joined the census when the
// fixture gained its first `test e2e` block; the 2 seeded list reads stayed, with
// their cause corrected from the node harness to the missing Elixir seeder).  A
// pin count that goes UP is not a regression when the population grows — but a
// pin whose REASON is wrong is, which is what the re-cause fixes.
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
// WHAT IS LEFT, by class: tenantRegistryRow 15, seededListReadUnwritten 2, gateProbe 1.

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
   *
   * THE SHAPE THAT WORKS, scouted while draining `unseededListRead` (#2517), so
   * the next agent starts from a checked design rather than from scratch:
   *   1. the registry row cannot be MINTED with a known id through the api (the
   *      create input has no `id` — identity is always a server-side `guid`,
   *      `docs/language.md` "there is no `ids` clause"), and it cannot be a
   *      readable string either, so `tenantId: "acme"` can never BE a row id;
   *   2. it CAN be seeded with a fixed one: `seed default raw { Org { id:
   *      "<fixed guid>", … } }` — `raw` is required for an explicit id
   *      (`loom.seed-explicit-id-needs-raw`), and `default` is the dataset that
   *      always runs.  That only became viable on all five legs once the node
   *      leg ran the seeder at all, which is why the two classes were coupled;
   *   3. so the fix is: seed the row, and point `DEV_CLAIMS`' claim at that same
   *      guid (`cases.mjs`).  It is a SHARED principal, so the change lands on
   *      every fixture at once — `tenancy-filter` asserts the literal `"acme"`
   *      as an explicit user-set field and would move with it, and the
   *      `tenancy-*` wire goldens are re-recorded.  That blast radius (plus the
   *      five-leg reverify and `tenancy-e2e`, which drives the same `.ddd` with
   *      its own claims) is why it is its own slice and not a footnote in this
   *      one.
   * Blocked on nothing except that work; `seeding`'s Elixir gap (B19) is the
   * one thing that must land first, since a seeded registry row is exactly what
   * the Elixir backend would silently drop.
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
   * WAS UNREACHABLE — a COLLECTION read on an aggregate carrying first-boot
   * SEED data.  Not a property of the route: a property of the harness.  The
   * four cross-backend behavioural legs boot the generated entrypoint, which
   * calls `runSeeds` after migrating (`index.ts` / `app/main.py` / …), while the
   * node leg — the wire-golden ORACLE — composed `createApp` directly and never
   * reached it.  So the same table started with the `default` dataset's rows on
   * four legs and empty on the fifth, and a collection read (the only route
   * class that can SEE seed data) would have recorded that harness gap as a
   * wire divergence on four backends at once.
   *
   * THE HARNESS HALF IS FIXED — `run.mjs` now imports the EMITTED `db/seed.ts`
   * and runs `runSeeds(db)` between the DDL and `createApp`, exactly where the
   * generated entrypoint does, so the ORACLE no longer starts from a different
   * table than its four peers.  The seeded VALUES are asserted (the int + enum
   * columns the seeder writes) plus the dataset GATE (`demo` / `wired raw` are
   * opt-in, so their rows must be absent) — but in a SIBLING fixture,
   * `corpus/seed-values`, because fixing node exposed a fifth leg that still
   * starts empty: see `seededListReadUnwritten`, which is why `corpus/seeding`'s own two
   * list routes stay pinned.
   *
   * What the drain found, and why this class was worth writing down twice:
   *   • `seed raw` INSERTs were NOT schema-qualified on node or .NET (python and
   *     java always were), so `INSERT INTO "widgets"` could never resolve a
   *     table created as `"catalog"."widgets"` — a first-boot break in shipped
   *     output for any `default` dataset carrying raw rows.  Fixed.
   *   • the Elixir backend emits NO seeder at all — a silent gap, now an honest
   *     `BEHAVIOURAL_SKIP` entry (B19) with the case named.
   *   • the node leg's TWO schema sources disagree on `version`: the migration
   *     DDL says `NOT NULL DEFAULT 1`, the emitted drizzle column says only
   *     `.notNull()`, so a raw row (which omits `version`) inserts fine against
   *     a migrated Postgres and violates the constraint on the PGlite schema
   *     synthesized from drizzle metadata.  Same class as items (4) and (6) in
   *     the header; recorded, not fixed (no shipped app hits it — the
   *     repositories always write `version` explicitly).
   *   • the MikroORM adapter ignores the dataSource `schema:` altogether: its
   *     `EntitySchema`s are mapped `tableName: "<plural>"` with no schema and it
   *     creates them with `orm.schema.updateSchema()` instead of running the
   *     emitted migration chain — so the same `.ddd` puts its tables in
   *     `"<ctx>"` on drizzle and in `public` on mikroorm.  A THIRD source of
   *     truth for one table.  Its raw seed INSERT is therefore left unqualified
   *     ON PURPOSE (`emitMikroSeeds`); the divergence itself is recorded, not
   *     fixed — found because qualifying it broke that adapter's own test,
   *     which is the test doing its job.
   *
   * Kept at zero as a class because it recurs the moment a leg stops running the
   * emitted seeder; today the live shape is its successor below.
   */
  unseededListRead:
    "unreachable: the node leg never runs runSeeds, so a collection read starts from a different table than the other four legs",
  /**
   * UN-AUTHORED — the successor to `unseededListRead`.  A collection read is the
   * only route class that can SEE seed data, and the wire golden compares whole
   * bodies — so such a read belongs only in a fixture whose table starts the SAME
   * on every leg that boots it.  Fixing the node leg's missing `runSeeds` (#2517)
   * turned out to expose the next leg along: elixir emitted no seeder at all
   * (B19), so its tables still started empty and these two reads stayed
   * UNREACHABLE.
   *
   * M-T6.37 closed that: the Ecto seeder ships, the `seed-values` behavioural
   * skip is deleted, and all five legs now start from the same seeded table.  So
   * the blocker is gone and the class changed — writable, unwritten.
   *
   * The assertions still live in the sibling `corpus/seed-values` — which carries
   * ONLY the collection reads — while `corpus/seeding` keeps its list routes
   * pinned here and its
   * CRUD / enum write-back / cross-aggregate FK / FK-ordered destroys / 404 bodies
   * armed on all five backends.  Skipping the whole of `corpus/seeding` on elixir
   * instead would have been the cheap move and a bad trade: `BEHAVIOURAL_SKIP` is
   * keyed by fixture id, so it drops the ENTIRE case, and the FK-ordering half it
   * would have silently taken away is B10's exact class — an elixir bug already
   * found and fixed once.
   *
   * The old note here said draining these two was M-T6.37's job and offered two
   * exits — the reads move back into `corpus/seeding`, or `seed-values` simply
   * stops being skipped.  M-T6.37 took the SECOND.  So the pins survive their
   * cause, and the honest change is the CLASSIFICATION: no longer UNREACHABLE
   * (a finding), now UN-AUTHORED (work) — `corpus/seeding` still declines to
   * call `all()`, and nothing but the fixture stops it.
   *
   * Left pinned rather than drained in the seeder PR on purpose.  Adding the
   * two calls rebaselines `seeding`'s wire golden on all five legs, and that
   * is a reviewed wire-contract change (see test/behavioral/wire-golden/) that
   * wants its own diff — not a rider on an emitter fix.  Renamed so the pin
   * stops asserting something false in the meantime: the reason a reader acts
   * on is now "write the calls", not "wait for the backend".
   */
  seededListReadUnwritten:
    "un-authored: all five legs now seed identically (M-T6.37 landed the elixir seeder), so these two collection reads are writable — but adding them rebaselines corpus/seeding's wire golden on every leg, which wants its own PR",
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
  // ── The THREE TENANT REGISTRIES ──────────────────────────────────────────
  // Fifteen pins, one cause: the derived self-scope filter narrows every read
  // (and every write's load-before-save) to the row whose id IS the principal's
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
  // Both aggregates' by-id routes ARE driven (create / getById / update /
  // destroy); only the two list reads are held, and the seeded VALUES they would
  // assert are covered by the sibling `corpus/seed-values` — which is held off
  // the elixir leg alone rather than costing this fixture its five-backend CRUD /
  // FK / 404 coverage.  See `R.seededListReadUnwritten`.
  "corpus/seeding": {
    allWidget: R.seededListReadUnwritten,
    allGadget: R.seededListReadUnwritten,
  },
  // ── The DENY fixture's tenant registry ───────────────────────────────────
  // `policy-deny` declares `tenancy by user.tenantId of Org`, so `Org` is a
  // third TENANT REGISTRY and its five routes join the ten above under the same
  // one cause — not a deny question at all (the deny stances themselves are
  // fully driven: read-denied with and without a tenant floor, write-denied, and
  // the undenied control).  Asserting the 404s these routes DO answer would pin
  // the harness artefact rather than the feature, and would have to be inverted
  // by the same harness fix that drains the other ten.
  "corpus/policy-deny": {
    createOrg: R.tenantRegistryRow,
    getOrgById: R.tenantRegistryRow,
    destroyOrg: R.tenantRegistryRow,
    updateOrg: R.tenantRegistryRow,
    allOrg: R.tenantRegistryRow,
  },
  // ── The DOCUMENT-crossing fixture's tenant registry ──────────────────────
  // `policy-document` declares `tenancy by user.tenantId of Org` too, so its
  // `Org` is a fourth tenant registry joining the same one cause as `policy-deny`
  // directly above: the deny/deep stances are fully driven by the fixture's own
  // caller, and asserting the 404s these five routes DO answer would pin the
  // harness artefact rather than the feature.
  "corpus/policy-document": {
    createOrg: R.tenantRegistryRow,
    getOrgById: R.tenantRegistryRow,
    destroyOrg: R.tenantRegistryRow,
    updateOrg: R.tenantRegistryRow,
    allOrg: R.tenantRegistryRow,
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
  // The by-id-follow join's read — same `notLifted` class, third shape.
  "corpus/projection-join": ["api.orderWithCustomer.list (no such aggregate)"],
  "corpus/projection-groupby": [
    // All four are projection READS — the not-yet-lifted route class this map
    // exists for, not a call that fails to find its operation.  `ordersByTotal`
    // joined them with the money-grouping-key witness (#2549 follow-up).
    "api.ordersByTotal.list (no such aggregate)",
    "api.revenueByDay.list (no such aggregate)",
    "api.salesByStatus.list (no such aggregate)",
    "api.volumeByCustomerAndStatus.list (no such aggregate)",
  ],
  // Both projection kinds again, this time as the GATED read surfaces
  // (`projection … requires`).  Same `notLifted` class as the four entries
  // above; the denial half of these reads is the authz ladder's, which is not
  // an `api.*` call at all.
  "corpus/read-gates": [
    "api.openOrders.list (no such aggregate)",
    "api.orderBook.byKey (no such aggregate)",
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
// Each entry carries WHY it is still here, checked against the emitted routes
// rather than assumed — the three classes are "needs a sidecar the behavioural
// leg does not stand up", "needs a second deployable", and "needs a fixture
// change before any caller is even expressible".  Written down because the
// classes decide the ORDER of the remaining drain, and re-deriving them costs
// the next agent an hour (#2517).
export const E2E_LESS_CORPUS_FIXTURES: readonly string[] = [
  // COMPILE-TIER WITNESS (generator review A5/A10–A14) — the previously
  // unwitnessed collection-op shapes (arithmetic-lambda `sum`, `distinct` over
  // money, argless `any()`, descending `sortBy`, unary minus on money, `-=` on
  // an int[]).  The bugs it pins were compile/runtime-value defects proven by
  // the per-backend compile tiers; a behavioural block would add uncalled
  // routes and unrecorded goldens for no additional oracle.
  "collection-op-shapes",
  // COMPILE + UNIT-TIER WITNESS (numeric-types audit F7 / M-T6.44) — the
  // right-hand money/decimal operand shapes (`int * money`, `int + decimal`,
  // `int < decimal`) the leftType-only TS/Elixir gates broke on.  The pure-
  // domain `test` block is the runtime oracle (the elixir ExUnit run proves
  // the term-ordering comparison flipped); a `test e2e` block would mint a
  // wire golden whose derived decimal values sit inside the UN-RULED
  // cross-backend decimal-arithmetic divergence (F11 / M-T5.22) — that golden
  // waits for the owner ruling, not for this fixture.
  "numeric-operands",
  // COMPILE-TIER WITNESS (generator review A1) — a projection aggregation over
  // a `tenantOwned` + `softDeletable` source; pins that the emitted aggregation
  // read carries the capability predicates.  The runtime half needs the
  // two-principal harness (`tenancy-e2e.yml` owns that shape).
  "projection-agg-filters",
  // COMPILE-TIER WITNESS (generator review A1, document half) — the row count
  // over a `shape: document` source, the one aggregation that shape can express.
  // The gate it exists for is a GENERATION one (four backends emit it, java is
  // refused), and asserting the number needs seeded rows the behavioural runners
  // set up per-fixture; `document.ddd` already drives the document write path at
  // runtime.
  "projection-document-aggregation",
  // TWO DEPLOYABLES — the caller's client is derived from the callee's served
  // operation set (see the manifest note), and the behavioural corpus requires
  // exactly one `platform: node` deployable per case so dispatch is unambiguous.
  // Its own runtime leg is `api-call-e2e.yml` (label/post-merge).
  "api-call",
  // BROKER SIDECAR — redis/rabbitmq/kafka; the node leg boots in-process on
  // PGlite with no broker. Runtime home: `channels-e2e.yml` (label/post-merge).
  "channels-broker",
  // FIXTURE CHANGE FIRST — `Order` carries no `crudish` and no author-declared
  // create, so the emitted route set is getById/all/confirm/flag/cancel with NO
  // `POST /api/orders`: nothing can mint a row, so no caller is expressible at
  // all (the `unseedableAggregate` shape wearing a different hat).  The drain is
  // therefore: give `Order` a create — the precedent is `scaffold-macros`' `Item`
  // (#2468) and `eventsourced-workflow`'s `Order` (M-T9.12) — then drive the half
  // that IS meaningful: the PRECONDITIONS gating the user handler (422 on
  // `riskScore < 80` and on a non-`Draft` status) plus the non-extern `cancel` as
  // the control.  The handler bodies stay uncalled on purpose: an unimplemented
  // `extern` throws honest fail-fast, and asserting that 500 would pin the
  // scaffold instead of the feature.
  "extern",
  "extern-handlers",
  // SIDECAR-BOUND, like `channels-broker`/`outbox`: the two routed handlers
  // exist precisely to issue objectStore / queue / mailer I/O, and the node
  // behavioural leg boots in-process on PGlite with no minio, no rabbitmq and
  // no smtp — so a caller would exercise the connection failure, not the
  // feature.  This fixture's job is therefore the COMPILE tier, which is where
  // its whole bug class lived: four of five emitters could not render a
  // resource-op in a handler body at all (node/python emitted the helper call
  // with no import → TS2304 / F821; .NET and java THREW at generate time), and
  // the five compile legs now prove all five render.  Structural coverage is
  // `test/generator/handler-resource-clients.test.ts` (per backend, per verb,
  // mutation-proven).  The runtime drain belongs with the `resources` fixture's
  // own sidecar leg, not here.
  "handler-resource-ops",
  // COMPILE-TIER WITNESS, and UNSEEDABLE besides.  Two of its three defects were
  // "the emitted project does not exist / does not compile" on .NET and java
  // (a dropped aggregate-less handler + route; a declared `byId` find renamed
  // and its already-typed argument re-wrapped) — and the behavioural tier boots
  // NODE, the one backend neither defect touched, so a caller would witness the
  // one leg that was always green.  The two find-backed routes are unseedable on
  // top of that: `Order` carries no `crudish` and no author-declared create, so
  // nothing can mint a row for `LoadOrder` / `CodeStatus` to read (the same
  // shape as `extern`'s pin).  The oracles that DO reach the bugs are the five
  // compile legs plus `test/generator/handler-triad.test.ts` (per backend,
  // mutation-proven).  Drain: give `Order` a create, then drive `Echo` / `Sum`
  // — the two pure-computation routes need no data at all.
  "handler-triad",
  // The lifecycle `requires` gate.  ENFORCEMENT is pinned structurally per
  // backend in `test/generator/lifecycle-guard-render.test.ts` (mutation-proven
  // against ten seeded emitter defects), but no RUNTIME caller exercises it.
  //
  // ONE of the two blockers this used to name is now STALE, retired here so it
  // is not re-derived: "the e2e DSL has no negative-status assertion form" is
  // false — `expect(<call>).toThrow(404)` is the form, and `policy-deny` spells
  // every one of its denials with it.
  //
  // The BINDING blocker stands, and it is the CLAIM-SET one below: this fixture
  // gates on `currentUser.permissions.contains(...)` over
  // `user { id: string  permissions: string[] }`, and `DEV_CLAIMS` mints no
  // `permissions`.  Worse for this entry specifically, the claim is an ARRAY and
  // `DEV_CLAIMS` is pinned to STRING claims because the non-node backends honour
  // only strings — so this one needs the claim-injection path widened, not just
  // a key added.  Until then an e2e here would 403 on every call and assert the
  // denial twice rather than pinning the gate from both sides (the two-halves
  // rule `read-gates` states).  The runtime negative-authz proof for `requires`
  // meanwhile lives in the M-T3.13 OIDC e2e legs.
  "lifecycle-guard",
  // BROKER SIDECAR (the outbox relay's delivery half). Same home as
  // `channels-broker`.
  "outbox",
  // `policy-deny` DRAINED in #2517 — the fixture now drives all four deny
  // stances over HTTP (read-denied with and without a tenant floor, write-denied,
  // and the undenied control), so "a denied read 404s / lists empty" is proven
  // rather than assumed.  Its five registry routes are pinned above.
  //
  // `policy-document` DRAINED — but only after the defect it was hiding was
  // FIXED, which is the whole argument for this register.  Writing the caller
  // and booting it (node leg) produced:
  //
  //     POST /api/things            -> 201  (aggregate_created)
  //     GET  /api/things/{that id}  -> 404
  //
  // `tenantOwned`'s `onCreate` stamps (`tenantId := currentUser.tenantId`,
  // `dataKey := currentUser.orgPath`) never reached the `shape: document` write
  // path: the relational repository lands them via `db/audit-stamp.ts`
  // `stampInsert(row)`, and the document repository never imported it.  So every
  // tenant-owned document row was written with an EMPTY tenant and was invisible
  // to every principal INCLUDING ITS CREATOR — read, update and destroy all 404,
  // silently, behind a 201.  The read filter was correct the whole time; nothing
  // had ever written a real row through the real create path for it to filter,
  // which is exactly why `test/generator/policy-document-inapp.test.ts` (which
  // runs the predicate over FABRICATED rows) stayed green through it.
  //
  // The fix stamps the doc payload on the INSERT branch only — the update writes
  // the whole blob, so `stampUpdate`'s create-field STRIP would delete the
  // tenant.  The caller now drives `allow deep` (admit, incl. the author's own
  // `where`) and `deny` (nothing, and 404 on both mutations) over HTTP, and its
  // first read is the stamp's regression test.
  //
  // What the caller still does NOT prove is stated in the fixture beside it: the
  // deep rung HIDING an out-of-subtree row needs a second tenancy identity the
  // behavioural tier does not have (`DEV_CLAIMS_UNAUTHORIZED` shares the tenant
  // by design).  That half belongs to `tenancy-e2e`.  Its five registry routes
  // are pinned below.
  // SIDECARS — `objectStore` (S3/minio), `queue`, an http `api` peer and a
  // `mailer` (mailpit).  A put→get round-trip needs them standing up, which is
  // `email-e2e.yml`'s and `channels-e2e.yml`'s shape, not this leg's.
  "resources",
  // NEEDS THE REGISTRY-PRINCIPAL HARNESS FIX — subtree scoping is a statement
  // about two principals in different parts of the tree, and the behavioural
  // suite authenticates as one whose claim is not a registry id at all.  Same
  // blocker as `R.tenantRegistryRow`; drain them together.  Runtime home today:
  // `tenancy-e2e.yml`'s hierarchy legs (label/post-merge).
  "tenancy-hierarchy",
];
