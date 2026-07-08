# `organizationContext` — principal vs. operating tenant scope

**Status:** PROPOSED
**Builds on:** the execution-context / scope-frame backbone (per-request
context, shipped on all five backends).
**Consumed by:** [`expressible-builtins.md`](./expressible-builtins.md)
(the tenancy `dataKey` reduction), the multi-tenancy plans, and the
authorization / read-write ladder.

## Problem

The ambient `currentUser.orgPath` accessor conflates **two different
things**:

1. **Principal identity** — who the caller is, their home org, their
   permissions.
2. **Operating tenant scope** — which org's data this request is acting
   *in*.

They coincide for the 90% self-service case, so the conflation is
invisible — until you need a request whose operating scope is *not* the
caller's home org:

- **hierarchy building** — an admin in org P creating a sub-org under P;
- **act-on-behalf** — a parent-org / support user creating or reading data
  scoped to a descendant org;
- **cross-org operations** generally.

Today these force a per-write **repo read of the target org** (to compute
its `dataKey`) inside a hand-written create factory or workflow — because
`currentUser.orgPath` can only ever be the *caller's* path. That read is
the symptom of the missing concept.

## Proposal

Add **`organizationContext`** — an ambient accessor (a peer of
`currentUser`, a frame on the existing execution-context backbone) carrying
the **operating tenant scope**:

- `organizationContext.orgId` / `.tenantId` — the operating org's id;
- `organizationContext.orgPath` — its materialized path.

> ⚠️ **BLOCKING PREREQUISITE — this is a cross-tenant security control.**
> Today the tenant read `filter` and write `stamp` anchor on
> `currentUser.orgPath`, a JWT **claim the caller cannot forge**
> (`prelude.ts:126`, `tenant-stance.ts:129`). This proposal repoints them
> onto a value the caller *submits*. So the **authorization gate is the
> load-bearing part, not an open detail** — the surface (`organizationContext`)
> must NOT be admitted until the gate is a concrete, **fail-closed**,
> validator-enforced, **per-backend** mechanism with a parity test (a sibling
> of `tenancy-e2e`) asserting a switch outside the write-ladder is *rejected
> on all five backends*. A backend that ships the switch but forgets the gate
> is a silent cross-tenant read **and** write hole — precisely the failure
> mode this whole effort exists to prevent. The gate is a hard dependency on
> the authorization work (Tier 4 #3), sequenced *with* it, never before.

Semantics:

- **Defaults to the principal's home org**, so
  `organizationContext.orgPath == currentUser.orgPath` unless explicitly
  switched. This is *functionally* additive (the default case is unchanged),
  but it is **not additive for the trust model** — the *basis* of the tenant
  filter shifts from claim-derived (unforgeable) to context-derived
  (submitted-then-validated). That shift is the whole reason the gate above
  is mandatory; do not describe this feature as "purely additive."
- **Settable per request, authorization-gated** — a principal may set the
  context only to an org within its authorized **write-scope** (its own
  subtree, per the `deep`/`global` write ladder). An unvalidated switch is
  a cross-tenant write hole, so the gate is mandatory, not optional.
- **Reads stay principal-anchored by default; a switch is an explicit
  widening.** Do *not* blanket-repoint every read onto `organizationContext`.
  Keep the tenant read `filter` anchored on `currentUser` (the unforgeable
  claim), and treat a validated context switch as a *separately-authorized
  widening* of the read scope — not a silent global repoint. The write
  `stamp` follows the operating context (that is the point); reads widen only
  when the switch is validated. (This is open question 4, and it must
  reconcile with `expressible-builtins.md`'s `deep`/`global` anchor — see its
  "Cross-proposal seam".)

`currentUser` keeps identity/permissions/home-org; `organizationContext` is
the operating lens over the tenant tree.

### Shape decision — two flat accessors, one context underneath

Should `currentUser` and `organizationContext` be **two separate flat
accessors**, or facets of **one unified `context.*` root** (`context.user`
/ `context.org`)? Recommendation: **two flat accessors on the surface,
backed by the one execution-context object underneath.**

- **Surface consistency.** Loom's ambient identifiers are already flat —
  `currentUser`, `now()`, `this`, `id`. A flat `organizationContext` matches
  them; a `context.*` root is a *new* pattern that clashes (or forces
  migrating `currentUser`/`now()` too, plus the more-verbose
  `context.user.tenantId`).
- **The relationship doesn't force unification.** `organizationContext` is
  authorized-against and defaults-from `currentUser`, but that is enforced
  once at **context establishment** (the gate), not in the surface syntax —
  two accessors express it fine.
- **Unify underneath.** Both are frames on the single execution-context
  object, so state is not fragmented; only the *surface* is two accessors.
- **When to revisit.** The one real case for a unified `context.*` root is
  **anti-sprawl** — if ambient frames proliferate (trace/correlation id,
  clock, locale, idempotency), many top-level magic identifiers become the
  namespace bloat this direction is trying to avoid. *Then* introduce
  `context.*` and alias `currentUser → context.user` for ergonomics. Two
  frames don't justify it; six would.

## What it collapses

Every tenant `dataKey` computation becomes the **same unconditional
stamp** — the context varies, the stamp doesn't:

| Case | Stamp |
|---|---|
| self-scope create | `dataKey := organizationContext.orgPath` |
| sub-org create (registry) | `dataKey := organizationContext.orgPath + "." + id` |
| cross-scope create | *same* — set the context to the target org first |

Consequences (each removes machinery that exists today):

- **No repo-let.** The registry no longer reads the parent row to build a
  child's path — the parent *is* the operating context.
- **No cross-scope workflow** for path purposes — a cross-scope write is
  "set context, then create normally," not orchestration.
- **No stamp-override rule.** There is nothing to override: the stamp is
  always `organizationContext.orgPath`; *switching context* is how you go
  cross-scope. (This dissolves `expressible-builtins.md` open question 4.)
- **Reads follow writes.** The tenant read `filter`s move from
  `currentUser.orgPath` to `organizationContext.orgPath`, so a context
  switch re-scopes reads consistently.

## The cost — moved, not deleted

The idea does not delete the hard part; it relocates it from *per-write* to
*once-per-request*:

1. **Context establishment** — middleware resolves an org selector → the
   org row → its `orgPath`, **and authorizes** that the principal may
   operate there. One lookup + one auth check per request, versus a
   repo-let in every factory.
2. **The authorization gate is the security crux.** It reuses the tenant
   **write-scope ladder** (`local`/`deep`/`global`): the context may be set
   to org X iff X is within the principal's write reach. Get this wrong and
   it is a cross-tenant write vulnerability — so it is the part that most
   needs a validator + tests.

## Open questions

1. **How the context is set** — an `X-Org-Context` header, an explicit
   `act as <org>` action, a URL path segment, or a combination. Auth /
   transport design choice.
2. **The authorization gate mechanism** — reuse the `policy` write-scope
   ladder directly, or a dedicated "may-operate-in" check? Where is it
   emitted (the same per-request seam the tenant filter uses)?
3. **`currentUser.orgPath` disposition** — keep it as the principal's
   *home* path (distinct from the operating context), or deprecate it in
   favor of `organizationContext` to avoid two similar accessors? Migration
   for the `tenantOwned` prelude stamps/filters either way.
4. **Which reads move** — do *all* tenant `filter`s switch to
   `organizationContext`, or only the write-side stamp, leaving reads on
   `currentUser`? (Coherence argues all; confirm no flow wants the split.)
5. **Re-entrancy** — may the context switch *within* a request (e.g. a
   workflow touching several orgs in sequence), or is it fixed at request
   entry? A nested/scoped frame vs. a single request-level value.
6. **Default-only systems** — a system with no hierarchy (`tenancy by`
   without a registry) never switches context; confirm the accessor is a
   no-op-cost identity over `currentUser` there.

## Why it's its own proposal

`organizationContext` is an **execution-context / authorization** feature,
not a "de-magic the built-ins" one. Tenancy is its first consumer (it makes
`expressible-builtins.md`'s `dataKey` reduction land cleanly), but the
principal-vs-operating-scope split is a general capability that any
scope-sensitive feature (audit-on-behalf, support tooling, cross-org
reporting) would reuse.
