# Multi-tenancy — design note for the implementing agent

> Status: **design agreed, not yet implemented.** This note captures the decisions
> reached so the implementer doesn't re-litigate them. It is a prerequisite for the
> real-time cache-invalidation ("magic caching") feature, which routes per-tenant and
> reuses the tenant-claim plumbing built here.

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
