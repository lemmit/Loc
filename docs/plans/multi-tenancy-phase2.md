# Multi-tenancy Phase 2 — hierarchical tenancy: the unblock plan

> **Status:** Plan (2026-07-04). Phase 1 (flat tenancy) shipped; see
> [`multi-tenancy-implementation.md`](./multi-tenancy-implementation.md) and the
> user doc [`../tenancy.md`](../tenancy.md). This doc is the *unblock* plan for
> the hierarchy half the design note deliberately gated.
>
> **Reconciles two proposals.** It folds
> [`../proposals/multi-tenancy-design-note.md`](../proposals/multi-tenancy-design-note.md)
> (R5 hierarchy, the capstone's hard "no") and
> [`../proposals/authorization.md`](../proposals/authorization.md) (`policy {}`,
> the `DataKey` type, the `Self`/`Descendants`/`All` ladder) into one build
> order. `authorization.md §0` already adopted "option A (layered)": multi-tenancy
> owns the flat primitive, authorization contributes the hierarchical extension.
> This plan is that layering, made buildable.

## Why it was blocked, precisely

The capstone gated Phase 2 on "session enrichment + the `local`/`deep`/`global`
access ladder." A fresh-`main` code audit (2026-07-04) pinned three real gaps —
all on the *materialized-path performance road*, none on the *correctness road*:

| # | Blocker | State on `main` today |
|---|---------|-----------------------|
| **A** | `dataKey := currentUser.orgPath` needs `orgPath`/`dataKey` in the session | The `claims:` map is a **static token→field projection only**; the session is the raw access token in a cookie. `orgPath` is *derived* (the registry path for `currentUser.tenantId`), **not an IdP claim**, so it has no carrier. Both proposals assume a `dataKey` claim "just arrives" in `user {}` — it can't. |
| **B** | The `local`/`deep`/`global` read ladder | Fully specced in `authorization.md` (`policy {}` + `Self`/`Descendants`/`All` + the `DataKey` type) but **absent from grammar and code** ("Status: design proposal, no implementation"). |
| **C** | The registry's `dataKey := parent.dataKey ‖ "." ‖ id` — a stamp reading *another row* | Capability stamps have **no repo handle and no `let`**; load-by-id exists **only in the workflow tier** (`repo-let`/`if-let`). Concat (`+`) and the self-ref FK (`parent: Organization id?`) already work; the `text_pattern_ops` index is a separate perf gap. |

## The two insights that collapse the work

**1. Blockers A and C are one missing concept.** Both need "derive the org path
from `currentUser.tenantId` via a registry lookup." The mechanism Loom lacks is a
single one: **a computed principal value, `currentUser.orgPath`.** Build that one
keystone and every downstream slice rides an *existing* seam:

- `dataKey := currentUser.orgPath` becomes a pure claim-copy stamp (rides the
  existing `contextStamp` pipeline).
- `deep` = `this.dataKey LIKE currentUser.orgPath + '%'` rides the existing
  `contextFilters` seams — all **seven** backend read positions already AND-in
  capability filters (`repository-builder`/`capability-filter`/EF `HasQueryFilter`).
- The registry's *own* `dataKey` is built in the `signUp` **create factory** with
  workflow-tier `repo-let` on the parent — a mechanism that **already exists**, so
  blocker C never touches the stamp layer.

**2. `dataKey` is a performance optimization, not a correctness requirement.**
`deep` ("my org + all descendants") is *correct* on the registry `parent` tree
alone, via a recursive-descendant query keyed off `currentUser.tenantId` (which we
already have on the token) — needing none of A/C. The design chose the
materialized path only to turn that recursive CTE into a direct indexed `LIKE`.
Trade-off:

- **Road 1 (materialized `dataKey`, the design's choice):** one shared keystone
  (`orgPath`), then trivial `LIKE prefix%` filters everywhere. Fast reads.
- **Road 2 (registry-tree recursive CTE):** no keystone — but a hard per-backend
  recursive-descendant filter, and EF Core's *static* `HasQueryFilter` lambda
  cannot host a recursive CTE, concentrating the cost in .NET.

**Chosen: Road 1.** The keystone is shared and small; Road 2's per-read CTE fights
EF's static-filter model. The keystone is the whole game — spend the effort once.

## The one architecture decision — how to source `orgPath`

**Chosen: per-request memoized registry lookup** (not login-time token
enrichment). On first reference within a request, resolve
`SELECT dataKey FROM organizations WHERE id = currentUser.tenantId`, memoize it on
the request-scoped principal, and expose it as `currentUser.orgPath`. Rationale:

- **No new session store × 5 backends.** Token enrichment would need a writable
  login-time session in every backend's OIDC callback (the auth audit found none
  exist — the cookie is just the raw token). The per-request lookup threads only
  through the 5 principal-construction seams that already build `currentUser`.
- **No staleness-on-refresh reasoning.** `parent` is immutable ⇒ the path is
  permanent, so a per-request read is always correct; there is nothing a
  longer-lived token would cache more cheaply that immutability doesn't already
  give us.
- The design named this exact fallback ("a per-request cached registry lookup —
  same result, one cached read"). Token enrichment stays a later optimization
  (fold `orgPath` into the token once a session-enrichment surface exists), fully
  compatible because the read shape is identical.

This also **repairs both proposals' shared over-assumption** — that `dataKey`
arrives as an IdP claim. It doesn't; it's *derived*, and P2.1 is where it's derived.

## Honoring the capstone's hard "no"

`dataKey` is introduced **only once P2.1 supplies a real `orgPath`** — never a
day-one `dataKey := tenantId` placeholder (the value that "silently goes wrong the
moment the first sub-org appears"). P2.3 (the row stamp) and P2.4 (the `deep`
filter) both depend on P2.1; there is no slice that stamps a placeholder.

## Slice ladder

Each slice states what it builds, the existing seam it rides, and its gate. The
ladder is strictly ordered by dependency (P2.1 is the keystone; P2.3/P2.4 need it).

### P2.0 — reconcile the proposals (design, no code)

Merge the two proposals into one canonical spec per `authorization.md §0` option
A: multi-tenancy owns `tenancy by`/`tenantOwned`/`crossTenant`/`tenantRegistry`;
authorization owns `policy {}` + `DataKey` + the directional ladder. Delete the
duplicate `crossTenant`/flat-floor definitions from `authorization.md §2` (already
half-done by its reconciliation banner) and record the `orgPath`-is-derived
correction in both. **Deliverable:** one spec, so P2.1+ aren't built against two
conflicting docs. **Gate:** review only.

### P2.1 — the keystone: `currentUser.orgPath` as a computed principal value

A derived principal member resolved per-request from the registry (memoized on the
request-scoped `currentUser`), typed as the `DataKey` materialized path. Threads
through the 5 principal-construction seams the auth audit pinned
(`hono/v4/auth-emit.ts` `toUser`, `dotnet/auth-emit.ts`, `python/auth-emit.ts`,
`java/emit/auth.ts`, `elixir/auth-emit.ts` `build_user`). The registry repo must
be reachable from the principal builder (cross-context read keyed by the claim we
already hold). **Rides:** the existing per-backend `currentUser` threading
(`exprUsesCurrentUser` → trailing param). **Gate:** `npm test` + one
`LOOM_TS_BUILD=1`; an e2e that asserts `currentUser.orgPath` resolves to the
caller's org path.

### P2.2 — registry tree: `implements tenantRegistry`

The `tenantRegistry` capability provides `parent: Self id?` (immutable, null =
root) + the managed `dataKey`; the registry's own path is built at `signUp` create
via workflow-tier `repo-let` on the parent (`dataKey := parent.dataKey + "." +
string(id)`). Verify the structural facts the design lists (exactly one
`tenantRegistry`, `of …` targets it, claim exists). **Rides:** the capability
prelude (`src/macros/prelude.ts`) + existing `repo-let` lowering. **Gate:**
parsing + negative-validator + per-backend generator tests.

### P2.3 — stamp `dataKey` on every `tenantOwned` aggregate

Extend the `tenantOwned` capability to add a managed `dataKey` column (off
`wireShape`, per `authorization.md §2`) + `onCreate dataKey := currentUser.orgPath`.
Trivial once P2.1 lands — a second stamp assignment beside `tenantId`. **Rides:**
the existing `contextStamp` pipeline + `wireShape`/entity emitters. **Gate:**
generator tests per backend; wire-spec unchanged (dataKey off the wire).

### P2.4 — the `policy {}` ladder: `deep` / `global` — SHIPPED

> **Shipped.** `policy { allow <level> on <Aggregate> }` context member +
> the `local`/`deep`/`global` read ladder, lowering each level to a rewrite of
> the aggregate's `tenantOwned` capability filter on all five backends. Settled
> the three semantics calls authorization.md §9 left open: (1) the NULL-`dataKey`
> **OR-fallback** (legacy rows degrade to the `local` floor, never leaking);
> (2) the **delimiter-correct** descendant prefix (`path` or `path || '.%'`);
> (3) **`global` = the flat tenant floor** — root-subtree widening under a
> hierarchy is deferred to P2.5 (it needs a `currentUser.rootOrg` accessor, the
> first `orgPath` segment, kept out of P2.4's minimal surface). Full write-up:
> [`../tenancy.md`](../tenancy.md) → "The `policy {}` read ladder".

Land the `policy {}` context member + the `Self`/`Descendants`/`All` (≈
`local`/`deep`/`global`) directional levels from `authorization.md §3`. Each
direction lowers to a `contextFilters` entry: `local` = today's `tenantId ==`
floor; `deep` = `this.dataKey LIKE currentUser.orgPath + '%'`; `global` = no
filter (still tenant-root-floored). **Rides:** all seven `contextFilters` backend
seams. **Note:** this is the large language-feature slice regardless of road; it
is the read side and can be sequenced after P2.1–P2.3 land the write side.
**Gate:** the full language-feature checklist (grammar → IR → validate → 5
backends → tests), per `docs/technical.md`.

### P2.5 — materialized-path index (perf, non-blocking)

Extend `IndexShape` (`src/ir/types/migrations-ir.ts`) with an opclass/method slot
and emit a `text_pattern_ops` (or C-collation) index on `dataKey` in `sql-pg.ts` +
the Ecto emitter, so `LIKE 'prefix%'` uses the index under any locale. The
delimiter discipline (a path separator so `org_a` doesn't prefix-match `org_ab`)
already shipped in P2.4's `deep` prefix; P2.5 owns the index + full opclass
discipline. **Also here:** the `currentUser.rootOrg` derived principal accessor
(the first `orgPath` segment) that lets `global` widen from the flat tenant floor
to the caller's **root-org subtree** — P2.4 ships `global` at the tenant floor
(fail-closed) pending this accessor.
**Separable** — correctness is complete at P2.4; this is the read-perf follow-up.
**Gate:** `k8s-build` (kubeconform) unaffected; migration/system tests.

## Sequencing summary

```
P2.0 reconcile ─► P2.1 orgPath keystone ─┬─► P2.2 registry tree ─► P2.3 dataKey stamp ─┐
                                          └───────────────────────────────────────────► P2.4 policy ladder (deep/global) ─► P2.5 index perf
```

P2.1 is the single load-bearing unblock. P2.2/P2.3 are the write side (small, ride
existing seams). P2.4 is the read side (the big language-feature slice). P2.5 is a
detachable performance follow-up.
