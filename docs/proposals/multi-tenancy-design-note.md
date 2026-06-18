# Multi-tenancy — design note for the implementing agent

> Status: **design agreed, not yet implemented.** This note captures the decisions
> reached so the implementer doesn't re-litigate them. It is a prerequisite for the
> real-time cache-invalidation ("magic caching") feature, which routes per-tenant and
> reuses the tenant-claim plumbing built here.

---

## Refinement (2026-06-17) — naming, registry-in-`tenancy by`, explicit-stance scope, macro-first delivery

> A design session reworked the registry, scope, and default decisions and added
> the always-hierarchy-ready model (R1–R5 below). Where this section and the
> original "Decisions locked" disagree, **this section wins** — the originals are
> kept for the reasoning trail. In particular, **original decision #4 ("the
> tenant registry is a third mode: `platform`") is replaced**: the registry is
> named in `tenancy by … of Organization` and tagged `implements
> "tenantRegistry"` (R1/R5). **`platform` is dropped entirely as a scope** — once
> depth moved to authz access levels (R5) and the registry to the
> `tenantRegistry` capability (R1), it had no scope meaning left; "admin-only
> cross-tenant data" (audit trails, projections) is `crossTenant` + an
> authorization policy (R2). Net effect: a smaller surface (two scope values), an
> explicit scope (unmarked = unscoped + a recommended-error lint, R3), and a
> Phase-1 with **no field injection**
> (fields come from explicit, unfoldable capabilities).
>
> **Why Loom owns this rather than a hand-rolled filter:** the dangerous part of
> tenancy is the *universal, can't-be-forgotten* read scope — miss the filter on
> one query and you get a silent cross-tenant leak, ×5 backends. That guarantee
> (a predicate injected into *every* generated query) is exactly what Loom's
> capability-filter pipeline already provides and a human cannot reliably
> maintain. Hierarchy's reparent/path mechanics are the genuinely hard-by-hand
> part — which is why reparent is scoped out (R5) and hierarchy is gated.

### R1. The registry is named in `tenancy by …`, not marked on the aggregate

The original decision #4 made the tenant registry a third *aggregate* mode
(`platform`). That conflated two different roles. The registry is a
**system-level structural fact** (there is exactly one; it is the root the
tenant id points *into*), so it belongs in the system declaration:

```ddd
tenancy by user.tenantId of Organization
```

This names the claim **and** the registry in one line, and buys three things a
per-aggregate marker can't:

- **A checkable type link** — the values of the `user.tenantId` claim *are*
  `Organization` ids (`tenantId ≡ Organization.id`). The self-scope filter
  (`Organization.id == currentUser.tenantId`) is then **derived**, not
  hand-written.
- **"Exactly one registry" enforced structurally** — you name one aggregate.
- **No registry marker on the aggregate.** `Organization` carries no scope
  modifier; its registry-ness, its absence of a `TenantId` column, and its
  claim-less bootstrap `create` are all derived from being the named registry.

**Why the registry *must* be special** (the original note asserts this but
doesn't justify it): the registry is **self-keyed** — its "tenant" is its own
primary key — so it has **no `TenantId` column**. The standard global tenant
filter (`WHERE TenantId = claim`) therefore cannot even be emitted against it.
`crossTenant` is wrong too (it would expose every org to every tenant — a
leak). Neither existing mode works, which is exactly why it has to be lifted
out of the per-aggregate axis into the system declaration.

### R2. The per-aggregate axis: "is the row owned by a tenant, or not?"

**Two values** — `scope is tenancy's job; who-may-read is authorization's`:

| Modifier | Tenant filter? | `TenantId` column | Example |
|---|---|---|---|
| `tenantOwned` | yes | yes (stamped) | `Invoice`, `Customer` |
| `crossTenant` | no | no | `Country`, `Plan` (reference data) |

Key points:

- **No third scope.** "Admin-only cross-tenant data" (audit trails, cross-tenant
  projections) is **`crossTenant` + an authorization policy** restricting the
  read — *not* a tenancy marker. (An earlier draft added a `platform` scope for
  this; dropped — once depth moved to authz access levels (R5) and the registry
  to the `tenantRegistry` capability (R1), `platform` had no scope meaning left.
  `who may read` is authorization, exactly as for the `local`/`deep`/`global`
  levels.)
- **Safety note.** `crossTenant` is fail-**open** at the tenancy layer (readable
  by all). Sensitive cross-tenant data (an audit trail) therefore relies on an
  authorization **default-deny** policy (`enforcement: denyByDefault`) to stay
  admin-only — the fail-closed guarantee for it lives in authz, not in a tenancy
  scope. A reviewed trade, not a silent gap.
- **`tenantless` considered** as a more accurate name than `crossTenant` for
  reference data ("a `Country` has no tenant"). Deferred only because
  `crossTenant` is the keyword `authorization.md` already shares. Open naming
  question.

### R3. Unmarked = unscoped; an explicit-stance lint

No silent fail-closed default: "unmarked ⇒ `tenantOwned`" would mean Loom
*implicitly attaches* the `tenantOwned` capability — injecting
`tenantId`/`dataKey` — the distant-injection magic the capability model forbids.
So an **unmarked aggregate is unscoped**: no `tenantOwned` capability ⇒ no tenant
column ⇒ effectively `crossTenant`. (Writing `crossTenant` explicitly is the same
behaviour with the *intent* declared.) A **lint** then flags every unmarked
aggregate under a `tenancy by` system and **suggests the fix** — `with
tenantOwned` or an explicit `crossTenant`.

**The lint's severity is the fail-open / fail-closed knob — and it bites here**,
because the *common* case (most aggregates are tenant data) is the one that needs
`with tenantOwned`, so the unmarked fallback (unscoped) is the **dangerous** one:

- **warning** ⇒ fail-**open**: a forgotten `with tenantOwned` silently leaks
  tenant data across tenants, and the warning is suppressible.
- **error** ⇒ fail-**closed**: nothing builds until each aggregate declares its
  stance; the suggested-fix message keeps it a one-keyword fix, not a cryptic
  failure.

**Recommendation: error severity** — it's the friendly UX of a suggesting lint
with the safety of a hard gate, and tenancy is a security boundary where the
dangerous default is the *frequent* one. A team that accepts the leak risk can
relax it to a warning via explicit opt-out. Either way there is **no magic
default** (the capability is always written, never injected); the only question
is whether the tooling *blocks* or *warns* on the unmarked case.

| | no `tenancy by` | `tenancy by` present |
|---|---|---|
| *(unmarked)* | inert | unscoped + explicit-stance lint (**recommend error**) |
| `with tenantOwned` | error — needs `tenancy by` | tenant-scoped |
| `crossTenant` | no-op (lint: "no tenancy declared") | unscoped, lint silenced (intent declared) |

### R4. Delivery is macro-first — Phase 1 needs no grammar/IR/emitter change

`tenantOwned` decomposes to **a field + an `onCreate` stamp + a capability
filter** — structurally identical to `audit` (`createdBy := currentUser`
stamp) and `softDelete` (`!this.isDeleted` filter). So it ships as a **stdlib
capability macro**, built from the existing `contextStamp` / `contextFilter`
primitives, in the same split-into-two shape (per-aggregate *state* +
context-level *behavior*):

```ts
// per-aggregate state: the column + capability opt-in
tenantOwned   → [ field("tenantId", "string", { internal: true }),
                  implementsCapability("tenantOwned") ]

// context-level behavior: stamp on create + scope every read
tenantOwnership →
  contextStamp({ capability: "tenantOwned",
    onCreate: [{ field: "tenantId",
                 value: memberAccess(nameRef("currentUser"), "tenantId") }] }),
  contextFilter(
    eq(memberAccess(thisRef(), "tenantId"),
       memberAccess(nameRef("currentUser"), "tenantId")),
    { capability: "tenantOwned" })
```

Spelling: `aggregate Invoice with tenantOwned { … }`, alongside
`with audit, softDelete`. **No new IR, grammar, or backend emitter** — it
reuses the `contextStamps` / `contextFilters` pipeline verbatim.

The **only enabling work** under it is runtime, not language: the filter
`this.tenantId == currentUser.tenantId` is a **principal-referencing** filter,
and those are wired on .NET only today — node / elixir / java reject them
(`loom.context-filter-unsupported`, `LIMITED_FAMILIES` in
`src/ir/validate/checks/system-checks.ts`). That gate is **T2.j** in the global
plan. So "ship the `tenantOwned` macro" ⊇ "do T2.j"; they are nearly the same
effort.

**Fail-open hole gated by the R3 lint:** the capability is the explicit,
unfoldable vehicle for the fields, so nothing is ever injected from afar. Whether
a *forgotten* `with tenantOwned` silently leaks depends on R3's explicit-stance
lint severity — at the recommended **error** severity there is no silent-leak
hole (it won't build); at warning severity it's fail-open and suppressible (a
reviewed trade).

### Phasing

> **The model is always hierarchy-ready — there is no flat/hierarchical mode
> switch** (R5). "Flat" is the degenerate case (every org a root, every read
> `local`). Stamping `dataKey` from day one trades a slightly bigger Phase 1
> for **no migration when `deep` is later turned on**. This supersedes the
> earlier "cheapest Phase 1 = `tenantId` only" framing in R4 — the macro
> *insight* (tenantOwned = the audit+softDelete shape) still holds; the field
> set grows by the managed `dataKey`.

- **Phase 1 (now):** the tenancy core — `tenancy by user.tenantId of
  Organization` (R1, **declaration + verification only**), `tenantOwned` /
  `crossTenant` (R2), the explicit-stance scope + lint (R3), the
  registry (`implements "tenantRegistry"` + author-written **immutable**
  `parent`, *verified* per R5), and `tenantId` **+ `dataKey`** stamped on every
  `tenantOwned` aggregate **from the token** at create. `local` reads wired
  (`tenantId` equality); `deep` waits for authz. Runtime gate: **T2.j**
  (principal-referencing filters on node/elixir/java). `with tenantOwned` is
  the explicit, **unfoldable** capability that carries the fields (R4) —
  nothing is injected by the distant `tenancy by` line.
- **Phase 2:** the `deep` / `global` access levels in `authorization.md`'s
  `policy {}` (per role, per entity). **Migration-free** — `dataKey` is already
  stamped; `deep` is a direct `dataKey LIKE prefix%` scan.
- **Out of scope:** reparent — `parent` is immutable; the rare org move is an
  offline data migration, not a runtime feature.

### Worked example (Phase-2 surface)

```ddd
system Billder {
  user { id: string  email: string  role: string  tenantId: string }
  auth { provider: keycloak  oidc { issuer: env("OIDC_ISSUER"), clientId: env("OIDC_CLIENT_ID") } }

  tenancy by user.tenantId of Organization   // claim + registry; every aggregate must declare a scope

  subdomain Billing {
    context Catalog {
      aggregate Plan crossTenant    { code: string  monthlyPrice: decimal }   // shared, open
      aggregate Country crossTenant { iso2: string  name: string }
    }
    context Invoicing {
      aggregate Invoice  with tenantOwned { number: string  customerId: Customer id  amountDue: decimal }  // explicit (lint nudges)
      aggregate Customer with tenantOwned { name: string  email: string  countryRef: Country id }
    }
  }
  subdomain Platform {
    context Accounts {
      aggregate Organization implements tenantRegistry {       // registry — tree fields from the capability
        name: string  planRef: Plan id  active: bool = true
        // parent: Self id?  +  dataKey  — PROVIDED by tenantRegistry (immutable; null = root)
        create signUp(name: string, parent: Organization id?, planRef: Plan id)   // claim-less bootstrap
        operation suspend() { requires currentUser.role == "platformAdmin"  active := false } }
    }
    context Ops {
      aggregate AuditTrail crossTenant { actor: string  action: string  at: datetime }   // cross-tenant; admin-only via authz default-deny
    }
  }

  deployable Api { platform: dotnet  contexts: [Catalog, Invoicing, Accounts, Ops]  auth: required }
}
```

### R5. Hierarchical tenancy — always-ready, capability-provided, no reparent

> Supersedes the earlier "registry-only path / two-mode / generated reparent"
> design that previously sat here. Net of the design session: **one
> always-hierarchy-ready mechanism**, fields **from explicit capabilities (not
> the declaration)**, paths **immutable**, `deep` reads as **direct prefix
> scans**.

**Prior art.** MS Dynamics 365/Dataverse: a **Business Unit** tree, and an
access-level ladder on each privilege — **Basic (User) / Local (Business Unit) /
Deep (Parent-Child BU) / Global (Organization)** — plus a separate Hierarchy
Security model (Manager/Position). Salesforce: a **Role Hierarchy** with "Grant
Access Using Hierarchies" (records roll up). The decisive lesson: **none of them
mark the *entity* as hierarchical.** The table just lives in the tree; **how
deep you see is a property of the *role*, per entity** — a "Regional Manager"
sees `Project` Deep but `Invoice` Local. An entity-level flavor
(`subtenantScoped` / `cascading`) literally cannot express that asymmetry, so it
was the wrong axis. (`subtenantScoped` is dropped.)

**No flat/hierarchical mode.** `tenantOwned` means one thing — "scoped." "Flat"
is just the degenerate case: every org is a root (`parent` null), every read is
`local`, the tree is one level deep. You never *choose* flat; it falls out. This
deletes the mode flag, the `hierarchy via` opt-in, and the static-flat-filter
vs deep-filter swap conflict.

**The registry — its tree fields come from a capability, not the declaration.**
A system-level declaration must not silently mutate an aggregate's shape, so
`tenancy by … of Organization` is **declaration + verification only**; the tree
fields come from an explicit, local, **unfoldable** capability on the registry:

- the registry carries **`implements tenantRegistry`** (`ImplementsDecl`,
  `ddd.langium:909`) — a capability that **provides** `parent: Self id?`, the
  managed `dataKey` path, and the path-stamp behavior. The author opts in
  *locally* (and can unfold to see the fields); the distant `tenancy by` line
  injects nothing. This is the [`typed-capabilities.md`](./typed-capabilities.md)
  **pure-mixin** model — the capability *holds* `parent`; there is **no**
  host-supplied/verified field. (An earlier draft made `parent` a
  `requires`/`expects` contract; dropped — the capability provides it, so there's
  nothing to verify.)
- Loom **verifies** the structural facts that *aren't* field-presence: **exactly
  one** aggregate implements `tenantRegistry` (the registry is singular), the
  **`of …` target is that aggregate** (cross-link), and the **claim field
  exists** on `user`. Field-conformance is moot — the capability *provides*
  `parent`, so it exists by construction.
- `parent` is **immutable** (set at create, null = root). **Reparent is out of
  scope** — immutability makes every path permanent, which is what makes the
  rest cheap.

**Fields come from explicit capabilities, never from the declaration.**
`with tenantOwned` and the registry's `implements "tenantRegistry"` are local,
visible, **unfoldable** capabilities (the LSP "unfold macro" action) — the
anti-magic mechanism. They carry the fields; `tenancy by` only verifies.
`dataKey` is the one **managed** value — a derived materialized path, like an
index or `wireShape`, never hand-authored: its *presence* is an explicit
consequence of the capability, its *value* is computed by Loom.

**Stamp `dataKey` on every `tenantOwned` aggregate from day one**, so turning on
`deep` later is a pure read-shape change with **no schema/data migration**.
Immutable `parent` is what makes always-stamping cheap rather than expensive:

> permanent paths ⇒ carry `orgPath` in the token (it can never go stale) ⇒ the
> `dataKey` stamp is a **pure claim copy** (`dataKey := currentUser.orgPath`),
> exactly like `tenantId := currentUser.tenantId`. **No** per-create or per-read
> registry lookup. The *only* registry read is at `Organization` create, to read
> the parent's path (`dataKey := parent.dataKey ‖ "." ‖ id`).

> **Assumption to verify — `orgPath` in the token.** `orgPath` is a *derived*
> value (the registry path for `currentUser.tenantId`), **not** an IdP claim, so
> carrying it in the token requires the auth layer to **enrich the session** with
> a derived value at login — a capability `auth.md` (D-AUTH-OIDC) doesn't have
> today (its `claims:` map projects IdP claims only). It's *safe* because
> immutable `parent` makes the path permanent (it can't go stale between token
> refreshes). If session-enrichment isn't available, the fallback is a
> **per-request cached registry lookup** of the path — same result, one cached
> read, but then the stamp is **not** a pure claim copy. So the claim-copy framing
> is contingent on session-enrichment; verify against the auth model before
> relying on it.

Columns, all stamped at create from the token, present from v1:

| Column | Source at create | Used by |
|---|---|---|
| `tenantId` | `currentUser.tenantId` | `local` (equality, fail-closed floor) + `global` |
| `dataKey` | `currentUser.orgPath` (token) | `deep` (direct `LIKE prefix%`) |

**Depth is a per-role authorization access level** (Dynamics' ladder), set in
`authorization.md`'s `policy {}` — not an aggregate marker:

| Level (Dynamics) | Filter on a `tenantOwned` row |
|---|---|
| `local` (Business Unit) | `row.tenantId == currentUser.tenantId` |
| `deep` (Parent-Child BU) | `row.dataKey LIKE currentUser.orgPath ‖ '%'` — **direct indexed scan, no join** |
| `global` (Organization) | none |

> **Naming.** The canonical access-level vocabulary lives in `authorization.md` —
> the directional set `Self` / `Descendants` / `All` (`local` ≈ `Self`, `deep` ≈
> `Self`+`Descendants`, `global` ≈ `All`). The `local`/`deep`/`global` labels here
> are the Dynamics mnemonic for that same ladder, not a second vocabulary.

```ddd
tenancy by user.tenantId of Organization      // declaration; verifies ↓

aggregate Organization implements tenantRegistry {
  name: string
  // parent: Self id?  +  dataKey  — PROVIDED by tenantRegistry (immutable; null = root)
  //   unfold the capability to see them; the author writes neither
}

aggregate Project with tenantOwned { title: string }   // tenantId + dataKey via the capability

policy {                                                 // authorization.md
  role Manager { Project read deep   Invoice read local }
  role Clerk   { Project read local  Invoice read local }
}
```

**Why a direct prefix scan, not a subquery.** Because `dataKey` lives on the row
(stamped from the token), `deep` is a single indexed `LIKE prefix%` — not a
join-through-the-registry on every read. The denormalisation costs nothing to
maintain *precisely because* `parent` is immutable (the path never changes). Two
materialized-path footguns Loom owns so users never see them: a path **delimiter**
(so `org_a` doesn't prefix-match `org_ab`) and a **`text_pattern_ops`/C-collation
index** (so `LIKE 'x%'` actually uses the index).

---

## Goal

Add first-class multi-tenancy (B2B isolation) to Loom so generated backends scope data
by `TenantId` automatically. The developer writes plain domain logic; the generator emits
claim extraction, query scoping, write-stamping, and schema (column + index) across all
backends.

## Decisions locked

1. **System-level declaration of the tenant key.** One statement names the claim that
   carries the tenant id, e.g.:

   ```ddd
   system Acme {
     tenancy by user.tenantId
     ...
   }
   ```

   The `user.<field>` reference points into the existing token/user shape (see auth, below).
   No `tenancy` statement ⇒ system is single-tenant; the whole feature is inert.

2. **Default tenant-scoped — fail closed.** **⚠ MECHANISM SUPERSEDED by R3
   (Refinement, top of file).** The fail-closed *goal* survives, but **not as a
   silent default** — "unmarked ⇒ tenant-scoped" would implicitly attach the
   `tenantOwned` capability (injecting `tenantId`/`dataKey`), the magic the
   capability model forbids. Instead: **unmarked = unscoped + an explicit-stance
   lint at the recommended `error` severity** — fail-closed without magic. The
   opt-out-over-opt-in reasoning below is exactly what motivates that recommended
   error severity. *(Original text:)* Every aggregate is tenant-scoped *by
   default*. A forgotten annotation therefore leaves an aggregate **isolated**
   (over-restrictive), never leaked. This is the deciding reason we chose opt-out
   over the opt-in `tenantScoped`/`IMultiTenant` style: opt-in fails *open* (a
   forgotten marker = cross-tenant leak).

3. **`crossTenant` marks the exceptions.** Aggregates that are NOT tenant-owned — shared
   reference data (country/plan catalogs), system config — are marked `crossTenant`:

   ```ddd
   aggregate Country crossTenant { ... }   # global, no tenant filter
   ```

   (Name chosen over `global`/`shared` because it stays in the tenancy vocabulary and reads
   as the literal opposite of "scoped.")

4. **The tenant registry is a third mode: `platform`.** **⚠ SUPERSEDED by R1/R2/R5
   (Refinement, top of file).** The registry is now named in `tenancy by … of
   Organization` + tagged `implements "tenantRegistry"`; `platform` is **dropped
   as a scope** — admin-only cross-tenant data (audit trails, projections) is
   `crossTenant` + an authorization policy. The reasoning below (why the registry can't
   be plain `tenant`-scoped or `crossTenant`) still holds — it's *why* the registry
   needs its own treatment — but the mechanism is R1/R5, not a `platform` mode.
   The `Tenant` aggregate itself cannot
   be plain tenant-scoped (chicken-and-egg: a tenant is created before its own tenant context
   exists; auto-stamping from a claim has no claim to read) and cannot be `crossTenant`
   (that exposes every org to every tenant). It is **dual-mode**:
   - self-service slice ("edit my own org") — conceptually self-scoped (`TenantId == own Id`),
   - bootstrap + cross-tenant listing — privileged, governed by a **role** claim, not a tenant claim.

   Model the registry as a distinct `platform` aggregate (likely its own generated module)
   whose access is role-gated rather than tenant-scoped. Do **not** try to make `Tenant` an
   ordinary aggregate.

5. **Defaults for scoped aggregates** (keep the surface to the `crossTenant` keyword + the `tenantOwned`/`tenantRegistry` capabilities; everything else implicit):
   - Cross-tenant access returns **404** (hide existence), not 403.
   - `TenantId` is **auto-stamped** from the claim on create; callers never pass it.
   - Column name **`TenantId`**, indexed.
   - These stay implicit until someone needs to override them — consistent with how `requires`
     is one keyword, not a policy language.

## Where it plugs in (integration seams found during exploration)

> **⚠ Pre-refinement + path-rot.** This section predates the R1–R5 refinement
> *and* later code moves. `platform` is no longer a scope (use the
> `tenantRegistry` capability), and several paths below are stale
> (`src/ir/loom-ir.ts` → `src/ir/types/loom-ir.ts`, `src/ir/lower.ts` →
> `src/ir/lower/lower.ts`; the .NET `templates/*.tpl.ts` predate the
> procedural-emit refactor — backends emit via `lines(...)` now). Treat the
> *seams* as indicative, not the exact paths.

Language:
- `src/language/ddd.langium` — add `tenancy by <user-field>` (system level) and the
  `crossTenant` modifier + the `tenantOwned`/`tenantRegistry` capabilities. Prefer a
  discriminator field over inferred actions (see CLAUDE.md grammar conventions).
- `src/ir/types/loom-ir.ts` — carry tenancy on the system + a per-aggregate scope
  (`crossTenant`; `tenantOwned` via capability).
- `src/ir/lower/lower.ts` — lower the new syntax (structural).
- validators (`src/ir/validate/checks/*` + `src/language/validators/*`) — validate the
  tenant-key field exists on the user shape; validate exactly one `tenantRegistry`
  aggregate when tenancy is on; the explicit-stance lint (R3), etc.

.NET (`src/generator/dotnet/`):
- Claim extraction: extend the JWT/user plumbing in `auth-emit.ts:41-198`
  (`ICurrentUserAccessor`) to expose the current `TenantId`.
- Query scoping: inject `WHERE TenantId = @currentTenant` for scoped aggregates in
  `templates/repository.tpl.ts` (consider EF `HasQueryFilter` global filter in
  `templates/efcore.tpl.ts` instead of hand-threading every query).
- Schema: add the `TenantId` column + index + EF config in `templates/efcore.tpl.ts`
  (today it does `b.Ignore(x => x.DomainEvents)` ~line 86 — same file).
- Write-stamping: set `TenantId` from the claim on create (operation/workflow create paths).

Parity (must match, or wire shape diverges):
- TS/Hono backend — `src/platform/hono/...` + `src/generator/ts/`.
- Phoenix/Ash — `src/generator/phoenix-live-view/` (Ash has first-class multitenancy; map to it).

React: **no isolation work needed** — the frontend already refetches through gated HTTP
endpoints, so tenant scoping is enforced server-side. Query keys are unaffected.

## Open items / things to decide while implementing

- Global EF query filter vs. explicit per-query `WHERE` (global filter is less error-prone but
  needs `IgnoreQueryFilters()` escape hatch for the admin / `crossTenant` paths).
- Bootstrap/signup flow for the registry (unauthenticated or platform-admin create path).
- Scale-out: tenant scoping is per-request and stateless, so no special concern here — but the
  real-time feature layered on top *will* need a backplane (see below).
- Tests: one parsing test, one negative validator test (e.g. tenant-key field missing), one
  generator test per backend asserting the `WHERE`/column/stamp appear; an e2e cross-tenant
  isolation test (Firm A cannot read Firm B's row → 404).

## Why the real-time caching feature depends on this

The "magic caching" feature (separate plan) routes change-tickets to a per-tenant SSE room
`tenant-{id}`. It reads the **same tenant claim** this feature plumbs, at SSE connect time.
So this is a hard code dependency, not just a conceptual one: build tenancy first, then the
real-time layer can be tenant-safe from day one (no "single-tenant first, add rooms later"
detour).
