// Pinned gaps for the AUTHORIZATION-GATE CENSUS (`authz-gate-census.test.ts`)
// — M-T9.28 slice 2.
//
// Slice 1 (#2515) minted the second principal in both auth flavours
// (`DEV_CLAIMS_UNAUTHORIZED`, `oidc.unauthorizedToken`) so the behavioural tier
// could finally express "authenticated but NOT authorized".  It did not answer
// the census question, which is the one #2446 got wrong: for every
// authorization gate the pipeline EMITS, is there a caller anywhere that must
// be REFUSED?  A gate emitted as a NO-OP passes every authorized-side
// assertion, every compile tier and every spec-parity diff identically — that
// is exactly how a guarded `create` shipped on an open route with every gate
// green.
//
// This register is the residue of that census: one entry per gated route
// surface with no refused caller, plus the reason.  It RATCHETS like
// `api-caller-census-pins.ts`, the file it is modelled on:
//
//   • a NEW gated surface with no refusal arm fails until it gets one or a pin;
//   • a pin that stops matching — the surface gained a refusal arm, or the
//     route was renamed / removed — fails as STALE, so a drain deletes its pin
//     in the same change.
//
// The per-class counts are NOT written in prose here.  `api-caller-census-pins`
// learned that the hard way (its header said 15 while the pins said 20, because
// a comment is not reachable from the thing it describes), so the tallies live
// in `PIN_CLASS_CENSUS` at the foot of this file and the gate recomputes them
// from the pins, both directions.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CENSUS, AS MEASURED (the gate recomputes every figure; these are the
// values at the time of writing, and the gate — not this comment — is what
// fails when they move):
//   87 sources censused (58 corpus fixtures, 5 shared behavioural systems,
//   23 `examples/*.ddd`, 2 booted `broad/` cases; 1 excluded as non-parsing).
//   125 gated route surfaces in them.  Of those: 31 inside fixtures already
//   exempt on `E2E_LESS_CORPUS_FIXTURES` (`projection-agg-filters`,
//   `tenancy-hierarchy`), 10 with a refused caller on record, 84 pinned below.
//   The refused count was 7 before this change — see findings 1 and 4.
//
// WHAT THE CENSUS FOUND (the reason to write it, recorded here because each
// item is a live gap nothing else surfaces):
//
//  1. `lifecycle-guard` carried THREE `requires` gates and the ladder refused
//     ONE of them.  `Shipment.create` — the principal-only create gate, the
//     literal #2446 shape, "a `requires` in a create parsed clean, emitted
//     nothing, and left the route OPEN" in that fixture's own words — had no
//     refusal arm on any leg.  Its `test e2e` drives the authorized side of all
//     three gates, so a no-op create gate was green everywhere.  DRAINED here:
//     the ladder now refuses the guarded create, and that arm is what the
//     mutation proof (finding 8) fires.
//
//  2. `Shipment.destroy` (the principal-AND-row gate) still has no refusal arm,
//     and the blocker is the HARNESS, not the fixture: a ladder spec carries
//     exactly ONE seeded id (`__authzLadder`'s `{id}` is the first id any seed
//     step returns) and `lifecycle-guard`'s is the crate's.  Addressing a second
//     row needs multi-id seeding in the shared recorder preamble.  Pinned as
//     `R.oneSeededId` — actionable, and it names the change.
//
//  3. The `policy` and `tenancy` classes are NOT DISCRIMINABLE by the second
//     principal, and the fixtures say so at the site.  `policy { deny … }` is
//     always-false for every caller (principal-FREE by construction — it routes
//     to each backend's STATIC filter path), and the tenant floor / `allow deep`
//     subtree scope keys on `tenantId`, which `DEV_CLAIMS_UNAUTHORIZED` SHARES
//     with `DEV_CLAIMS` deliberately.  So there is no 403 arm to assert, and the
//     refusal that IS assertable is the one each fixture's own `test e2e`
//     already makes (`toThrow(404)` on the denied surfaces).
//     `policy-document.ddd` states this verbatim — "NO ladder entry accompanies
//     this … both stances are principal-free with respect to the arms a ladder
//     varies" — and it is right: a second-identity 404 beside an existing
//     first-identity 404 asserts nothing.  These are pinned under
//     `R.principalFreeGate` / `R.sharedTenancyIdentity` rather than given
//     theatre arms.  (This is the one place this packet's plan row and the head
//     disagreed: the row named `policy-deny` and `policy-document` as ladder
//     work.  `policy-deny` got the arms that DO say something new — finding 4 —
//     and `policy-document` did not, because its own recorded argument holds.)
//
//  4. What a ladder on those fixtures CAN say — and what nothing said before —
//     is the CONTROL: on a surface with NO gate, the second principal must NOT
//     be refused.  Without it the whole ladder tier can be green for the wrong
//     reason: if the dev-stub verifier ever began answering 403 for an
//     unrecognised role, every `unauthorized: 403` arm in `auth-simple`,
//     `auth-oidc`, `read-gates` and `lifecycle-guard` would pass while proving
//     nothing about any gate.  Added on `field-mask` (auth-required, no gate on
//     the probed read) and on `policy-deny`'s write-denied `Account`, whose READ
//     seam must stay open while its writes are refused — one identity, one row,
//     both answers, which no single surface can show.
//
//  5. `mask unless` cannot be refused at the STATUS level at all — its refusal
//     is field-level redaction inside a 200 — and it cannot be discriminated
//     either: `field-mask`'s predicate reads `permissions.contains(unmask)`,
//     which NEITHER harness principal carries (deliberate; the fixture records
//     that the privileged side needs a claim shape only some backends map).  So
//     the mask surfaces are pinned `R.maskIsNotAStatus`, and the control arm at
//     least puts the redacted body on the wire for the second identity too,
//     where the golden pins it.
//
//  6. `union-find-absence` was on this packet's ladder list and CANNOT carry
//     one: it declares no authorization gate at all (so the census finds no
//     surface there to refuse), and its deployable declares no `auth`, so
//     `unauthorizedCredentials` returns `null` and every runner SKIPS the ladder
//     for it.  Recorded rather than silently dropped — a fixture that later
//     gains `auth: required` plus a gate becomes a real candidate.
//
//  7. HANDED OFF, both outside this packet's tree:
//     (a) `examples/sales-ui.ddd` DOES NOT PARSE on this head — 7 syntax errors
//         from line 133 (the `Dashboard(items: [ … ])` page body) and 12 link /
//         walker-stdlib / i18n errors behind them.  Nothing gates it:
//         `generated-react-build.yml` iterates `examples/acme.ddd` and
//         `web/src/examples/**`, never the rest of `examples/`.
//         `NON_PARSING_SOURCES` below is the ratchet that makes it loud.
//     (b) `web/src/examples/auth-capabilities.ddd` carries two `requires` gates
//         and no runner boots it, so it sits outside the census population
//         entirely (see the note at `loadPopulation`) — an authorization surface
//         with no runtime caller of either polarity.
//
//  8. MUTATION PROOF (the packet's required shape — the LADDER catches a no-op
//     `requires`, the e2e does not).  Seeded the #2446 defect in the Hono
//     create-route emitter: `src/platform/hono/v4/routes-builder.ts`'s
//     `lines.push(...lifecycleGateLines(agg.canonicalCreate, "      "))` — the
//     one line that renders a canonical create's gate — replaced by
//     `lines.push(...[])`, i.e. a `requires` that parses, lowers, type-checks
//     and emits NOTHING.  `npm run build` still exit 0.  Then the node
//     behavioural leg on `lifecycle-guard`:
//
//       ✓ [api] the manage permission opens all three gates, and the ungated
//           control needs none against d
//       ✗ [authz] authz ladder: guarded create (principal-only, no row yet) —
//           authenticated-but-unauthorized → 403
//               expected 403, got 201: {"id":"01a0689f-…"}
//       ✓ [authz] authz ladder: guarded destroy (principal-only, audited row) —
//           authenticated-but-unauthorized → 403
//       → 4 passed, 1 failed, 2 skipped
//
//     Exactly the split the census exists to create, and note WHICH assertion
//     failed: the fixture's own `test e2e` — the only thing watching this gate
//     before — passes with the gate gone, the sibling destroy arm passes
//     (the seed was scoped to the create), and the one arm this change added is
//     the one that fires.  With the emitter restored by FILE COPY (never
//     `git checkout -- <path>`, which would have discarded the census files in
//     the same tree — §84) the three ladder cases are green and their
//     rebaselined goldens match: 17 passed, 0 failed, 7 skipped, 3 cases
//     compared, 0 divergences.

/**
 * Reason classes.  Shared constants rather than 84 hand-written sentences: the
 * gaps fall into a handful of classes and the CLASS is the honest explanation.
 * The distinction that matters is the one `api-caller-census-pins` draws — an
 * un-authored pin is work, an unreachable pin is a finding.  Every class below
 * is currently a finding; none of them is "nobody wrote the test".
 */
export const R = {
  /** UNREACHABLE (harness).  `__authzLadder` substitutes ONE `{id}`, taken from
   *  the first seed step's response, so one spec cannot address two different
   *  aggregates' rows.  Drain = multi-id seeding in the shared recorder
   *  preamble (`test/behavioral/wire-differential.mjs`), then the arm. */
  oneSeededId:
    "the ladder spec carries ONE seeded id and this surface addresses a different aggregate's " +
    "row; needs multi-id seeding in `__authzLadder` before an arm can be written",
  /** UNREACHABLE (by construction).  `policy { deny … }` is always-false for
   *  every caller — it routes to each backend's STATIC (principal-free) filter
   *  path — so the second principal is refused exactly as the first is, and a
   *  ladder arm would restate the fixture's own `toThrow(404)`.  The refusal IS
   *  asserted: by that `test e2e`. */
  principalFreeGate:
    "principal-FREE gate (`policy deny` renders an always-false filter for every caller), so a " +
    "second principal cannot be discriminated; the refusal is asserted by the fixture's own " +
    "`test e2e` (`toThrow(404)`) — see the note at the site in the .ddd",
  /** UNREACHABLE (harness identity).  A tenant floor, a registry self-scope or
   *  an `allow deep`/`global` subtree scope keys on `tenantId`, and
   *  `DEV_CLAIMS_UNAUTHORIZED` shares it with `DEV_CLAIMS` by design — that is
   *  what makes a 403 elsewhere mean "the gate denied" rather than "the tenant
   *  differs".  Discriminating these needs a second TENANCY identity, which is
   *  `tenancy-e2e.yml`'s shape, not this tier's. */
  sharedTenancyIdentity:
    "tenancy predicate keyed on a claim `DEV_CLAIMS_UNAUTHORIZED` SHARES with `DEV_CLAIMS` by " +
    "design; discriminating it needs a second tenancy identity — `tenancy-e2e.yml`'s shape",
  /** UNREACHABLE (shape).  A read mask redacts a FIELD inside a 200; there is no
   *  refusal status to assert.  Nor are the two identities distinguishable here
   *  — neither carries the unmasking claim. */
  maskIsNotAStatus:
    "`mask unless` refuses a FIELD inside a 200, not a request — no refusal status exists to " +
    "assert, and neither harness principal carries the unmasking claim",
  /** UNREACHABLE (population).  Nothing boots this source, so no ladder can name
   *  a caller for it at all; its gates are watched at the COMPILE tier only. */
  notABehaviouralCase:
    "not a behavioural case — no runner boots this source, so no ladder can name a caller of " +
    "either polarity; its gates are watched at the compile tier only",
} as const;

/**
 * `<case key> → { <surface key>: reason }`.
 *
 * Case keys match `POPULATION` in `authz-gate-census.test.ts`; surface keys are
 * `<route class> <METHOD> <path>` exactly as the census prints them, so a
 * failure message can be pasted here verbatim.
 */
export const AUTHZ_GATE_PINS: Record<string, Record<string, string>> = {
  // ── mask unless — no status to refuse ────────────────────────────────────
  // Every read surface that projects `salary` / `nationalId`.  The ladder's
  // control arm drives two of them with the second identity and records the
  // redacted body; what it cannot do is assert a refusal, because there is not
  // one.  See `R.maskIsNotAStatus` and finding 5.
  "corpus/field-mask": {
    "find GET /api/employees": R.maskIsNotAStatus,
    "find GET /api/employees/by_name": R.maskIsNotAStatus,
    "getById GET /api/employees/{id}": R.maskIsNotAStatus,
    // The audit-history read projects the same masked shape (`historyFind`
    // copies the list read's gate at enrichment), so it inherits the mask.
    "history GET /api/employees/{id}/history": R.maskIsNotAStatus,
  },

  // ── the one refusal arm the HARNESS blocks ───────────────────────────────
  // The other two `requires` gates in this fixture ARE refused by the ladder
  // (the guarded create's arm is new — finding 1).  This third needs a second
  // addressable row: `R.oneSeededId`.
  "corpus/lifecycle-guard": {
    "destroy DELETE /api/shipments/{id}": R.oneSeededId,
  },

  // ── `policy { deny … }` + the tenant floor around it ─────────────────────
  // `Secret` / `Note` are read-denied and `Account` is write-denied: all three
  // sentinels are principal-free, so the fixture's own `test e2e` is the
  // refusal and a ladder arm would restate it.  What the ladder DOES add is on
  // `Account`: its write surfaces refused and its READ seam open, for the second
  // identity — so those two writes are not pinned.  `Ledger` (the control
  // aggregate) and `Org` (the tenant registry) carry only the tenant floor.
  "corpus/policy-deny": {
    "create POST /api/accounts": R.principalFreeGate,
    "create POST /api/ledgers": R.sharedTenancyIdentity,
    "create POST /api/notes": R.principalFreeGate,
    "create POST /api/orgs": R.sharedTenancyIdentity,
    "create POST /api/secrets": R.principalFreeGate,
    "destroy DELETE /api/ledgers/{id}": R.sharedTenancyIdentity,
    "destroy DELETE /api/notes/{id}": R.principalFreeGate,
    "destroy DELETE /api/orgs/{id}": R.sharedTenancyIdentity,
    "destroy DELETE /api/secrets/{id}": R.principalFreeGate,
    "find GET /api/accounts": R.sharedTenancyIdentity,
    "find GET /api/ledgers": R.sharedTenancyIdentity,
    "find GET /api/notes": R.principalFreeGate,
    "find GET /api/orgs": R.sharedTenancyIdentity,
    "find GET /api/secrets": R.principalFreeGate,
    "find GET /api/secrets/by_code": R.principalFreeGate,
    "getById GET /api/accounts/{id}": R.sharedTenancyIdentity,
    "getById GET /api/ledgers/{id}": R.sharedTenancyIdentity,
    "getById GET /api/notes/{id}": R.principalFreeGate,
    "getById GET /api/orgs/{id}": R.sharedTenancyIdentity,
    "getById GET /api/secrets/{id}": R.principalFreeGate,
    "operation POST /api/ledgers/{id}/update": R.sharedTenancyIdentity,
    "operation POST /api/notes/{id}/update": R.principalFreeGate,
    "operation POST /api/orgs/{id}/update": R.sharedTenancyIdentity,
    "operation POST /api/secrets/{id}/update": R.principalFreeGate,
  },

  // ── the same two stances on a `shape: document` aggregate ────────────────
  // `Note` is the deny carve-out (principal-free); `Thing` carries `allow deep`
  // — principal-REFERENCING, but anchored on the claim the two harness
  // identities share, so still not discriminable — and `Org` is the hierarchy
  // registry's self-scope.  This fixture is the one whose `.ddd` argues at the
  // site for no ladder at all, and that argument holds; see finding 3.
  "corpus/policy-document": {
    "create POST /api/notes": R.principalFreeGate,
    "create POST /api/orgs": R.sharedTenancyIdentity,
    "create POST /api/things": R.sharedTenancyIdentity,
    "destroy DELETE /api/notes/{id}": R.principalFreeGate,
    "destroy DELETE /api/orgs/{id}": R.sharedTenancyIdentity,
    "destroy DELETE /api/things/{id}": R.sharedTenancyIdentity,
    "find GET /api/notes": R.principalFreeGate,
    "find GET /api/orgs": R.sharedTenancyIdentity,
    "find GET /api/things": R.sharedTenancyIdentity,
    "find GET /api/things/by_label": R.sharedTenancyIdentity,
    "getById GET /api/notes/{id}": R.principalFreeGate,
    "getById GET /api/orgs/{id}": R.sharedTenancyIdentity,
    "getById GET /api/things/{id}": R.sharedTenancyIdentity,
    "operation POST /api/notes/{id}/update": R.principalFreeGate,
    "operation POST /api/orgs/{id}/update": R.sharedTenancyIdentity,
    "operation POST /api/things/{id}/update": R.sharedTenancyIdentity,
  },

  // ── the tenancy cluster ──────────────────────────────────────────────────
  // Three fixtures, one cause: every route of a `tenantOwned` aggregate (and of
  // the registry itself) is narrowed by a predicate keyed on the tenancy claim
  // both harness identities hold.  A refusal here is a statement about two
  // TENANTS, which is `tenancy-e2e`'s two-principal shape, not this tier's.
  "corpus/tenancy-claim-name": {
    "create POST /api/invoices": R.sharedTenancyIdentity,
    "create POST /api/organizations": R.sharedTenancyIdentity,
    "destroy DELETE /api/invoices/{id}": R.sharedTenancyIdentity,
    "destroy DELETE /api/organizations/{id}": R.sharedTenancyIdentity,
    "find GET /api/invoices": R.sharedTenancyIdentity,
    "find GET /api/invoices/by_number": R.sharedTenancyIdentity,
    "find GET /api/organizations": R.sharedTenancyIdentity,
    "getById GET /api/invoices/{id}": R.sharedTenancyIdentity,
    "getById GET /api/organizations/{id}": R.sharedTenancyIdentity,
    "operation POST /api/invoices/{id}/update": R.sharedTenancyIdentity,
    "operation POST /api/organizations/{id}/update": R.sharedTenancyIdentity,
  },
  "corpus/tenancy-filter": {
    "create POST /api/accounts": R.sharedTenancyIdentity,
    "destroy DELETE /api/accounts/{id}": R.sharedTenancyIdentity,
    "find GET /api/accounts": R.sharedTenancyIdentity,
    "find GET /api/accounts/by_min_balance": R.sharedTenancyIdentity,
    "getById GET /api/accounts/{id}": R.sharedTenancyIdentity,
    "operation POST /api/accounts/{id}/update": R.sharedTenancyIdentity,
  },
  "corpus/tenancy-owned": {
    "create POST /api/invoices": R.sharedTenancyIdentity,
    "create POST /api/organizations": R.sharedTenancyIdentity,
    "destroy DELETE /api/invoices/{id}": R.sharedTenancyIdentity,
    "destroy DELETE /api/organizations/{id}": R.sharedTenancyIdentity,
    "find GET /api/invoices": R.sharedTenancyIdentity,
    "find GET /api/invoices/by_number": R.sharedTenancyIdentity,
    "find GET /api/organizations": R.sharedTenancyIdentity,
    "getById GET /api/invoices/{id}": R.sharedTenancyIdentity,
    "getById GET /api/organizations/{id}": R.sharedTenancyIdentity,
    "operation POST /api/invoices/{id}/update": R.sharedTenancyIdentity,
    "operation POST /api/organizations/{id}/update": R.sharedTenancyIdentity,
  },

  // ── the showcase example — five `requires` and no runtime caller ─────────
  // `examples/showcase.ddd` is the repo's broadest sample and no runner boots
  // it, so its two guarded operations, two guarded workflow starters and one
  // `tenantOwned` aggregate have no caller of EITHER polarity.  Pinned per
  // surface rather than per file on purpose: adding a `requires` to a sample
  // then fails here until someone writes it down.
  "examples/showcase": {
    "create POST /api/engineers": R.notABehaviouralCase,
    "destroy DELETE /api/engineers/{id}": R.notABehaviouralCase,
    "find GET /api/engineers": R.notABehaviouralCase,
    "find GET /api/engineers/by_handle": R.notABehaviouralCase,
    "getById GET /api/engineers/{id}": R.notABehaviouralCase,
    "operation POST /api/builds/{id}/promote": R.notABehaviouralCase,
    "operation POST /api/engineers/{id}/update": R.notABehaviouralCase,
    "operation POST /api/projects/{id}/archive": R.notABehaviouralCase,
    "operation POST /api/projects/{id}/rename": R.notABehaviouralCase,
    "workflow POST /api/workflows/promote_to_production": R.notABehaviouralCase,
    "workflow POST /api/workflows/register_project": R.notABehaviouralCase,
  },
};

/**
 * Sources in the census POPULATION that do not parse on this head.
 *
 * Recorded rather than skipped: a `.ddd` in the repo the toolchain cannot read
 * is a bigger finding than an ungated route, and it is invisible today —
 * `generated-react-build.yml` iterates `examples/acme.ddd` plus
 * `web/src/examples/**`, so nothing else under `examples/` is parsed by any
 * gate.  Ratchets both ways: a repaired source drops out (and joins the census
 * with its own pins), a newly-broken one fails here first.
 */
export const NON_PARSING_SOURCES: readonly string[] = [
  // 7 syntax errors from `examples/sales-ui.ddd:133` (the `Dashboard(items:
  // [ … ])` page body — `Expecting token of type ')' but found ':'`), then 12
  // link / walker-stdlib / i18n errors behind them (`MasterDetail`, `List` and
  // `Detail` are not walker primitives; the `scaffold` macro args name a
  // `Catalog` subdomain and `Customer` / `Product` aggregates the file does not
  // declare).  HANDED OFF — the repair is a page-DSL question outside this
  // packet's tree.
  "examples/sales-ui",
];

/**
 * How many pins each reason class carries.  Recomputed from the pins by the
 * gate and compared BOTH ways, so adding a pin without raising its count is as
 * loud as draining one without lowering it — the mistake
 * `api-caller-census-pins`' prose tallies made twice.
 *
 * Only classes with at least one pin appear; a class that drains to zero is
 * deleted from here while its `R.*` reason stays, documenting the class for
 * when it recurs.
 */
export const PIN_CLASS_CENSUS: Readonly<Record<string, number>> = {
  maskIsNotAStatus: 4,
  notABehaviouralCase: 11,
  oneSeededId: 1,
  principalFreeGate: 17,
  sharedTenancyIdentity: 51,
};
