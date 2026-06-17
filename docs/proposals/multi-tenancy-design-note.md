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

- **Phase 1 (now):** `with tenantOwned` stdlib capability macro → `internal
  tenantId` + `onCreate` stamp + principal filter. Lands on/with **T2.j**.
  Explicit, fail-open + lint. Proves the column/stamp/filter runtime
  end-to-end behind the smallest surface.
- **Phase 2:** promote to first-class — `tenancy by user.tenantId of
  Organization` (R1), `crossTenant` / `platform` markers (R2), the derived
  fail-closed default (R3), typed `tenantId ≡ Organization id`. The macro keeps
  working as the explicit form.

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
      aggregate Organization { name: string  planRef: Plan id  active: bool = true   // the registry
        create signUp(name: string, planRef: Plan id)        // claim-less bootstrap
        operation suspend() { requires currentUser.role == "platformAdmin"  active := false } }
    }
    context Ops {
      aggregate AuditTrail platform { actor: string  action: string  at: datetime }   // all tenants, admin-only
    }
  }

  deployable Api { platform: dotnet  contexts: [Catalog, Invoicing, Accounts, Ops]  auth: required }
}
```

> **DataKey note.** The hierarchical-scoping extension (`authorization.md` §2:
> sub-tenant `Self`/`Children`/`Descendants` via a materialized-path column)
> is the *depth-N generalization* of `tenantOwned` and is **out of scope for
> Phases 1–2** — flat tenancy covers the common case. See that doc + the
> reconciliation thread for how DataKey's leftmost segment is exactly the
> `tenantId` defined here.

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
