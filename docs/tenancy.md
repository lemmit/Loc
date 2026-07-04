# Multi-tenancy — `tenancy by`, `tenantOwned`, `crossTenant`

First-class B2B tenant isolation. One system-level declaration names the
tenant claim and the tenant registry; every aggregate then declares its
stance explicitly, and the toolchain guarantees the read scope on every
generated query — the "forgot the filter on one query" cross-tenant leak
becomes a compile error instead of an incident.

Design record: [`proposals/multi-tenancy-design-note.md`](proposals/multi-tenancy-design-note.md)
(R1–R5); implementation plan: [`plans/multi-tenancy-implementation.md`](plans/multi-tenancy-implementation.md).

## Surface

```ddd
system Billder {
  user { id: guid  email: string  tenantId: string }

  tenancy by user.tenantId of Organization      // claim + registry, one line

  subdomain Billing {
    context Catalog {
      aggregate Plan crossTenant { code: string  monthlyPrice: decimal }
    }
    context Invoicing {
      aggregate Invoice with tenantOwned { number: string  amountDue: decimal }
    }
    context Accounts {
      aggregate Organization { name: string }   // the registry — named in `of`, no marker
    }
  }
  // deployables need `auth: required` — the filter/stamp read the principal
}
```

- **`tenancy by user.<claim> of <Registry>`** — a `system` member (peer of
  `user {}` / `auth {}`). Names the user-shape field that carries the tenant id
  and the one aggregate that is the tenant registry. At most one per system;
  the claim field must exist on `user {}`; the registry must exist.
- **`with tenantOwned`** — a built-in prelude capability
  (`src/macros/prelude.ts`, next to `auditable` / `softDeletable`). Unfold it
  and you get exactly:

  ```ddd
  aggregate Invoice {
    number: string
    amountDue: decimal
    // — what `with tenantOwned` expands to —
    tenantId: string internal
    stamp onCreate { tenantId := currentUser.tenantId }
    filter this.tenantId == currentUser.tenantId
  }
  ```

  The column lands in the migrations automatically; `internal` keeps
  `tenantId` out of create inputs (the client can never pass it); the filter
  is AND-ed into **every** generated read on all five backends; the stamp
  copies the claim at create.
- **`crossTenant`** — an aggregate-header flag (like `abstract`), for shared
  reference data (`Plan`, `Country`). A stance marker: attaches nothing,
  generates nothing — it exists so "no tenant filter" is a declared decision,
  never an accident.
- **The registry** gets no marker — it is self-keyed (its "tenant" IS its own
  id), so neither stance fits it. Since Phase 1b it DOES get generated read
  behavior: the **derived self-scope filter** (below). Who may read or edit
  organizations beyond that is authorization's job.

## The registry: derived self-scope + claim-less bootstrap (Phase 1b)

`tenantId ≡ <Registry>.id` is a **derived type link** (capstone decision 4):
from the `tenancy by` declaration alone, every read of the registry is scoped
to the caller's own org. You never write this filter — enrichment appends it
to the registry's capability filters, so it rides the exact pipeline
`tenantOwned`'s predicate uses:

```ddd
aggregate Organization { name: string }   // you write only this
// derived by the toolchain (never in source):
//   filter this.id == currentUser.tenantId
```

```ts
// node — db/repositories/organization-repository.ts (generated)
async all(): Promise<Organization[]> {
  const rootRows = await this.db.select().from(schema.organizations)
    .where(eq(schema.organizations.id, requireCurrentUser().tenantId));
  ...
}
```

So `GET /organizations/<own id>` → 200, `GET /organizations/<other id>` →
404 (existence hidden), and the list contains exactly your own org.

**Claim-less signup bootstrap.** Filters never gate creates and the registry
carries no stamp, so `POST /organizations` works for any authenticated
principal — including one whose token has **no (or a foreign) tenant claim**.
The created org's `id` is then a valid `tenantId` claim value (that's the
identity), closing the signup loop: create org → issue token with
`tenantId = <org id>` → read it back. Pinned end-to-end by
`test/e2e/tenancy-isolation.test.ts` (`LOOM_TENANCY_E2E=1`).

**The id-vs-claim type rule.** The registry id is usually `guid`; JWT claims
are usually strings. The comparison binds the claim **as the id's value type
at each backend's accessor site**:

| Claim type vs `ids` | Result |
|---|---|
| same-typed (`guid`/`guid`, `string`/`string`, …) | compared directly on every backend |
| `string` claim, `ids guid` | bound as a guid at the accessor site: pg casts the text parameter (node/elixir/python), .NET wraps `Guid.Parse(...)`, Java converts in the SpEL principal expression (`T(java.util.UUID).fromString(...)`, null-guarded → fail-closed `= NULL`) |
| anything else | `loom.tenancy-claim-type-mismatch` (error, with the fix spelled out) |

A **malformed** tenant claim (not a parseable guid) under a guid-id registry
fails the registry read with a server error on every backend — no data is
returned (fail-closed), but it is a 500, not an empty list. A **missing**
principal claim binds null and matches no rows.

Per-backend registry read scope (all five compile-gated; node also
runtime-gated by the isolation e2e):

| Backend | Registry read scope |
|---|---|
| node (Hono/Drizzle) | `eq(schema.organizations.id, requireCurrentUser().tenantId)` AND-ed into every root read |
| .NET (EF Core) | `HasQueryFilter("IdFilter", x => x.Id == new OrganizationId(Guid.Parse(RequestContext.Current!.CurrentUser!.TenantId)))` |
| elixir (Ecto) | `record.id == ^(current_user && current_user.tenant_id)` (pinned, fail-closed) |
| python (SQLAlchemy) | `OrganizationRow.id == require_current_user().tenant_id` (id column is `Uuid(as_uuid=False)` — string-mapped) |
| java (Spring/JPA) | `e.id.value = :#{… T(java.util.UUID).fromString(@currentUserAccessor.user().tenantId()) …}` scoped `@Query` overrides on findAll/findById + every find |

The derived filter is provenance-tagged `tenancy` in
`contextFilterOrigins`. `tenancy` is not a capability, so a named
`ignoring tenancy` is rejected (`loom.filter-bypass-unknown-capability`);
only an explicit `ignoring *` read — the same authored escape hatch that
drops `tenantOwned`'s filter — bypasses it.

## The explicit-stance rule (the safety story)

Under a system with `tenancy by`, **every persisted aggregate must declare a
stance** — `with tenantOwned` or `crossTenant` (the registry and abstract
bases are exempt). An unmarked aggregate is a hard error:

| Code | Fires when | Severity |
|---|---|---|
| `loom.tenancy-stance-unmarked` | unmarked aggregate under a `tenancy by` system | error |
| `loom.tenancy-unknown-claim` | `user.<claim>` not on the `user {}` shape | error |
| `loom.tenancy-registry-unknown` | `of` names a non-existent aggregate | error |
| `loom.tenancy-duplicate` | more than one `tenancy by` | error |
| `loom.tenant-owned-without-tenancy` | `with tenantOwned` but no `tenancy by` | error |
| `loom.cross-tenant-without-tenancy` | `crossTenant` but no `tenancy by` | warning |
| `loom.tenancy-conflicting-stance` | both markers on one aggregate (or a marker on the registry) | error |
| `loom.tenancy-claim-type-mismatch` | the claim's type can't bind against the registry's `ids` type (see the id-vs-claim rule above) | error |

There is deliberately **no severity knob**: the escape hatch is writing
`crossTenant` — one keyword, intent declared. This is fail-closed without
magic: nothing is ever injected by the distant `tenancy by` line; the
capability the aggregate *wrote* carries the fields (unfoldable, reviewable).

## What each backend emits

The filter and stamp ride the standard capability-filter/stamp pipeline —
tenancy adds **no bespoke backend code**:

| Backend | Read scope | Create stamp |
|---|---|---|
| node (Hono/Drizzle) | `.where(and(…, eq(t.tenantId, requireCurrentUser().tenantId)))` on every repository read | `stampInsert` copies the claim off the ambient principal (no-op for system/seed saves) |
| .NET (EF Core) | `HasQueryFilter(x => x.TenantId == RequestContext.Current!.CurrentUser!.TenantId)` | `SaveChangesInterceptor` sets the claim on `Added` |
| elixir (Ecto) | fail-closed `^(current_user && current_user.tenant_id)` match in every read | `put_change(:tenant_id, current_user && current_user.tenant_id)` |
| python (FastAPI/SQLAlchemy) | `.where(...)` on every read | `self._tenant_id = current_user.tenant_id` in the create factory |
| java (Spring/JPA) | principal predicate composed into the repository specification | `@PrePersist` hook reading `CurrentUserAccessor.currentOrNull()` |

Frontends need nothing: enforcement is server-side, and `tenantId` never
appears in create forms. (It does appear in read DTOs, like `softDeletable`'s
`isDeleted` — internals are wire-visible today.)

Cross-tenant reads of another tenant's row return **404** (existence hidden),
falling out of the filter semantics: the row simply isn't found.

## Scope and roadmap

Phase 1 is flat tenancy (`local` reads — tenant-id equality). The registry
self-scope + claim-less bootstrap shipped as Phase 1b (above). Deferred:

- **The `claim`/`registry` cross-reference upgrade** (capstone decision 5) —
  byte-identical surface, tooling win (navigation/rename); still open.
- **`tenant_id` index** — blocked on the index surface
  ([`proposals/uniqueness-and-indexes.md`](proposals/uniqueness-and-indexes.md)).
- **Hierarchy** (`tenantRegistry` capability, `parent`, the managed `dataKey`
  materialized path, `deep`/`global` access levels) — Phase 2, blocked on
  auth session-enrichment and [`proposals/authorization.md`](proposals/authorization.md).
  See the design note's R5.
