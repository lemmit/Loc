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
- **The registry** gets no marker and no generated behavior in Phase 1: it is
  self-keyed (its "tenant" is its own id), so neither stance fits it. Who may
  read or edit organizations is authorization's job.

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

Phase 1 is flat tenancy (`local` reads — tenant-id equality). Deferred:

- **Registry self-scope + bootstrap** ("edit my own org", claim-less
  `signUp`) — Phase 1b, rides the `ignoring` filter bypass.
- **`tenant_id` index** — blocked on the index surface
  ([`proposals/uniqueness-and-indexes.md`](proposals/uniqueness-and-indexes.md)).
- **Hierarchy** (`tenantRegistry` capability, `parent`, the managed `dataKey`
  materialized path, `deep`/`global` access levels) — Phase 2, blocked on
  auth session-enrichment and [`proposals/authorization.md`](proposals/authorization.md).
  See the design note's R5.
