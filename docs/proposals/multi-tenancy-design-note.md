# Multi-tenancy — design note for the implementing agent

> Status: **design agreed, not yet implemented.** This note captures the decisions
> reached so the implementer doesn't re-litigate them. It is a prerequisite for the
> real-time cache-invalidation ("magic caching") feature, which routes per-tenant and
> reuses the tenant-claim plumbing built here.

---

## Refinement (2026-06-17) — naming, registry-in-`tenancy by`, derived default, macro-first delivery

> A design session reworked four of the "Decisions locked" below. Where this
> section and the original decisions disagree, **this section wins** — the
> originals are kept for the reasoning trail. Net effect: a smaller surface, a
> safer default, and a Phase-1 that ships with **no grammar/IR/emitter change**.

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

### R2. The per-aggregate axis: "how many tenants own the row?"

Three values, read as **one / none / all**:

| Modifier | Tenant filter? | `TenantId` column | Default read access | Example |
|---|---|---|---|---|
| *(unmarked)* / `tenantOwned` | yes | yes (auto-stamped) | own tenant | `Invoice`, `Customer` |
| `crossTenant` | no | no | **open** — every tenant reads | `Country`, `Plan` (reference data) |
| `platform` | no | no | **admin-only (deny by default)** | cross-tenant audit trail, analytics projection |

Key points:

- **`crossTenant` ≠ `platform`.** They are identical on the *tenancy* axis
  (both unscoped, no `TenantId` column) and differ only on the **access
  default** — and that difference is the reason both exist under fail-closed
  reasoning: an unscoped aggregate defaulting to *open* is correct for a
  country list and a **catastrophic leak** for an audit trail. `crossTenant`
  fails open (safe for reference data); `platform` fails closed to admin-only.
- **`platform` is plural** (you can have an audit store *and* a projection);
  the registry is exactly one (named in `tenancy by`). They are not the same
  slot. `platform`'s deny-by-default access is best **baked into tenancy** (so
  it is safe before the authorization layer exists), with finer policy
  delegated to authorization.
- **`tenantless` considered.** It is arguably a more accurate name than
  `crossTenant` for reference data ("a `Country` has no tenant" vs. "crosses
  tenants"), giving a clean *one / none / all* trio. Deferred only because
  `crossTenant` is the keyword `authorization.md` already shares, so switching
  means re-reconciling that doc. Open naming question.

### R3. The default is **derived** from `tenancy by`, never separately configurable

The presence of `tenancy by` *is* the switch:

- **`tenancy by` present** ⇒ an unmarked aggregate is `tenantOwned` (fail-closed).
- **`tenancy by` absent** ⇒ the tenancy axis is inert (no `TenantId`, no filter —
  today's single-tenant behaviour, unchanged).

So adding the one `tenancy by …` line is the **safest possible migration**: it
flips every unmarked aggregate to isolated-by-default, and you opt the
reference data back out with `crossTenant`. A forgotten marker during that
migration leaves an aggregate over-isolated (empty), never leaked.

The default is **not** a knob on `tenancy by`. Its only alternative value would
be `crossTenant`, which reintroduces fail-**open** (forget a marker on real
tenant data ⇒ shared ⇒ leak) — the exact failure the design exists to avoid.
The presence of `tenancy by` already declares "default = `tenantOwned`";
restating it would be redundant, changing it would be unsafe.

Validation corners that fall out:

| | no `tenancy by` | `tenancy by` present |
|---|---|---|
| *(unmarked)* | unscoped / inert | **`tenantOwned`** (default) |
| `tenantOwned` written | **error** — "requires a `tenancy by` declaration" | explicit form of the default (allowed for clarity) |
| `crossTenant` written | inert — lint "no effect; no tenancy declared" | the real exception marker |

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

**Trade made consciously:** the explicit macro is **fail-open** (forget
`with tenantOwned` ⇒ unscoped ⇒ leak) — the opposite of R3's fail-closed
default. Phase 1 accepts this for obviousness, mitigated by a lint ("aggregate
on a tenant system has no tenancy capability — did you mean `with
tenantOwned`?"). The fail-closed guarantee is bought back when R3's derived
default lands in Phase 2.

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
  `crossTenant` / `platform` (R2), the fail-closed derived default (R3), the
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

  tenancy by user.tenantId of Organization   // claim + registry, fail-closed default

  subdomain Billing {
    context Catalog {
      aggregate Plan crossTenant    { code: string  monthlyPrice: decimal }   // shared, open
      aggregate Country crossTenant { iso2: string  name: string }
    }
    context Invoicing {
      aggregate Invoice  { number: string  customerId: Customer id  amountDue: decimal }  // default: tenantOwned
      aggregate Customer tenantOwned { name: string  email: string  countryRef: Country id }
    }
  }
  subdomain Platform {
    context Accounts {
      aggregate Organization implements "tenantRegistry" {     // the registry — verified, not injected
        name: string  planRef: Plan id  active: bool = true
        parent: Organization id?                               // YOU write it; immutable; null = root
        // dataKey: managed path — value computed by Loom, never authored
        create signUp(name: string, parent: Organization id?, planRef: Plan id)   // claim-less bootstrap
        operation suspend() { requires currentUser.role == "platformAdmin"  active := false } }
    }
    context Ops {
      aggregate AuditTrail platform { actor: string  action: string  at: datetime }   // all tenants, admin-only
    }
  }

  deployable Api { platform: dotnet  contexts: [Catalog, Invoicing, Accounts, Ops]  auth: required }
}
```

### R5. Hierarchical tenancy — always-ready, verify-don't-inject, no reparent

> Supersedes the earlier "registry-only path / two-mode / generated reparent"
> design that previously sat here. Net of the design session: **one
> always-hierarchy-ready mechanism**, fields **verified not injected**, paths
> **immutable**, `deep` reads as **direct prefix scans**.

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

**The registry — verified, not injected.** A system-level declaration must not
silently mutate an aggregate's shape, so `tenancy by … of Organization` is
**declaration + verification only**:

- the registry carries the explicit string capability **`implements
  "tenantRegistry"`** (the existing capability-tag mechanism, `ImplementsDecl`,
  `ddd.langium:909`);
- the registry **author writes** `parent: <self> id?` — Loom does **not** inject
  it;
- Loom **verifies** conformance: the `of …` target carries `"tenantRegistry"`,
  has a self-referential optional `parent`, exactly one such aggregate exists,
  and the claim field exists on `user`. Capability-*conformance* ("a
  `"tenantRegistry"` aggregate must have a self-ref `parent`") is a small,
  general extension to the capability system — not tenancy-specific magic. It is
  exactly the kind of contract a **typed capability/interface** would formalise
  (see the follow-up note / new proposal).
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

```ddd
tenancy by user.tenantId of Organization      // declaration; verifies ↓

aggregate Organization implements "tenantRegistry" {
  name: string
  parent: Organization id?       // author-written, immutable; verified as the self-ref edge
  // dataKey — managed path; value computed by Loom, presence via the capability
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

2. **Default tenant-scoped — fail closed.** Every aggregate is tenant-scoped *by default*.
   A forgotten annotation therefore leaves an aggregate **isolated** (over-restrictive),
   never leaked. This is the deciding reason we chose opt-out over the
   opt-in `tenantScoped`/`IMultiTenant` style: opt-in fails *open* (a forgotten marker =
   cross-tenant leak).

3. **`crossTenant` marks the exceptions.** Aggregates that are NOT tenant-owned — shared
   reference data (country/plan catalogs), system config — are marked `crossTenant`:

   ```ddd
   aggregate Country crossTenant { ... }   # global, no tenant filter
   ```

   (Name chosen over `global`/`shared` because it stays in the tenancy vocabulary and reads
   as the literal opposite of "scoped.")

4. **The tenant registry is a third mode: `platform`.** The `Tenant` aggregate itself cannot
   be plain tenant-scoped (chicken-and-egg: a tenant is created before its own tenant context
   exists; auto-stamping from a claim has no claim to read) and cannot be `crossTenant`
   (that exposes every org to every tenant). It is **dual-mode**:
   - self-service slice ("edit my own org") — conceptually self-scoped (`TenantId == own Id`),
   - bootstrap + cross-tenant listing — privileged, governed by a **role** claim, not a tenant claim.

   Model the registry as a distinct `platform` aggregate (likely its own generated module)
   whose access is role-gated rather than tenant-scoped. Do **not** try to make `Tenant` an
   ordinary aggregate.

5. **Defaults for scoped aggregates** (keep the surface to two keywords; everything else implicit):
   - Cross-tenant access returns **404** (hide existence), not 403.
   - `TenantId` is **auto-stamped** from the claim on create; callers never pass it.
   - Column name **`TenantId`**, indexed.
   - These stay implicit until someone needs to override them — consistent with how `requires`
     is one keyword, not a policy language.

## Where it plugs in (integration seams found during exploration)

Language:
- `src/language/ddd.langium` — add `tenancy by <user-field>` (system level) and the
  `crossTenant` / `platform` aggregate modifiers. Prefer a discriminator field over inferred
  actions (see CLAUDE.md grammar conventions).
- `src/ir/loom-ir.ts` — carry tenancy on the system + a per-aggregate scope kind
  (`tenant` | `crossTenant` | `platform`).
- `src/ir/lower.ts` — lower the new syntax (structural).
- `src/language/ddd-validator.ts` — validate the tenant-key field exists on the user shape;
  validate exactly one registry/`platform` aggregate when tenancy is on, etc.

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
  needs `IgnoreQueryFilters()` escape hatch for the `platform`/admin paths).
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
