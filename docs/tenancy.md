# Multi-tenancy — `tenancy by`, `tenantOwned`, `crossTenant`

First-class B2B tenant isolation. One system-level declaration names the
tenant claim and the tenant registry; every aggregate then declares its
stance explicitly, and the toolchain guarantees the read scope on every
generated query — the "forgot the filter on one query" cross-tenant leak
becomes a compile error instead of an incident.

Design record: [`proposals/multi-tenancy-design-note.md`](old/proposals/multi-tenancy-design-note.md)
(R1–R5); implementation plan: [`plans/multi-tenancy-implementation.md`](old/plans/multi-tenancy-implementation.md).

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
    dataKey: string? internal
    stamp onCreate {
      tenantId := currentUser.tenantId
      dataKey := currentUser.orgPath
    }
    filter this.tenantId == currentUser.tenantId
  }
  ```

  The `tenantId` column lands in the migrations automatically — **with a
  derived non-unique `<table>_tenant_id_idx`** (every tenant read prefixes on
  that column; derived in the shared `MigrationsIR`, so all DB backends emit
  it); `internal` keeps both columns out of create inputs (the client can
  never pass them); the filter is AND-ed into **every** generated read on all
  five backends; the stamp copies the claim at create.

  **`dataKey`** (multi-tenancy Phase 2, plan P2.3) is the materialized
  DataKey path, stamped unconditionally from `currentUser.orgPath` — the
  **same** claim-copy stamp mechanism as `tenantId`, riding the identical
  `contextStamp` pipeline (no per-backend code: every backend already renders
  `currentUser.orgPath` for the P2.1/P2.2 filter use-site; a stamp assignment
  is the same expression renderer, a different call site). It is stamped on
  every `tenantOwned` aggregate regardless of whether the registry has opted
  into `implements tenantRegistry` — under flat tenancy `orgPath` resolves to
  the tenancy claim itself (P2.1's fallback, a correct root-only path); once
  the registry opts into hierarchy, `orgPath` resolves to the real
  materialized path with nothing here needing to change. Unlike `tenantId`,
  `dataKey` is **not just `internal`** — `authorization.md §2` calls it a
  persistence column only, so `wireFieldsForAggregate`
  (`src/ir/enrich/enrichments.ts`) drops it from `wireShape` **entirely**: it
  never appears in `.loom/wire-spec.json`, a DTO, or any read response — a
  stricter exclusion than `tenantId`'s (which stays in `wireShape`, just
  filtered out of API reads). No read-side filtering rides `dataKey` yet —
  that is the `policy { data {} }` ladder, P2.4.
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
| linking error (`Could not resolve reference …`) | `user.<claim>` not on the `user {}` shape, or `of` names a non-existent aggregate — both bindings are real cross-references since 1b.1 (navigation / rename / find-refs work) | error |
| `loom.tenancy-duplicate` | more than one `tenancy by` | error |
| `loom.tenant-owned-without-tenancy` | `with tenantOwned` but no `tenancy by` | error |
| `loom.cross-tenant-without-tenancy` | `crossTenant` but no `tenancy by` | warning |
| `loom.tenancy-conflicting-stance` | both markers on one aggregate (or a marker on the registry) | error |
| `loom.tenancy-claim-type-mismatch` | the claim's type can't bind against the registry's `ids` type (see the id-vs-claim rule above) | error |
| `loom.tenant-owned-claim-type` | a `tenantOwned` aggregate exists but the claim isn't `string` (the capability's field is `tenantId: string`; a `guid` claim mis-compiles typed backends — declare the claim `string`, guid values round-trip as text) | error |

There is deliberately **no severity knob**: the escape hatch is writing
`crossTenant` — one keyword, intent declared. This is fail-closed without
magic: nothing is ever injected by the distant `tenancy by` line; the
capability the aggregate *wrote* carries the fields (unfoldable, reviewable).

## What each backend emits

The filter and stamp ride the standard capability-filter/stamp pipeline —
tenancy adds **no bespoke backend code**:

| Backend | Read scope | Create stamp (`tenantId` + `dataKey`) |
|---|---|---|
| node (Hono/Drizzle) | `.where(and(…, eq(t.tenantId, requireCurrentUser().tenantId)))` on every repository read | `stampInsert` copies both claims off the ambient principal — `tenantId: currentUser.tenantId, dataKey: currentUser.orgPath` (no-op for system/seed saves) |
| .NET (EF Core) | `HasQueryFilter(x => x.TenantId == RequestContext.Current!.CurrentUser!.TenantId)` | `SaveChangesInterceptor` sets both on `Added` — `x.TenantId` off `…CurrentUser!.TenantId`, `x.DataKey` off `…CurrentUser!.OrgPath` |
| elixir (Ecto) | fail-closed `^(current_user && current_user.tenant_id)` match in every read | `put_change(:tenant_id, current_user && current_user.tenant_id) \|> put_change(:data_key, current_user && current_user.org_path)` |
| python (FastAPI/SQLAlchemy) | `.where(...)` on every read | `self._tenant_id = current_user.tenant_id` + `self._data_key = current_user.org_path` in the create factory |
| java (Spring/JPA) | principal predicate composed into the repository specification | `@PrePersist` hook reading `CurrentUserAccessor.currentOrNull()`, setting `this.tenantId = currentUser.tenantId()` and `this.dataKey = currentUser.orgPath()` |

Frontends need nothing: enforcement is server-side, and neither `tenantId` nor
`dataKey` ever appears in create forms. `tenantId` (like `softDeletable`'s
`isDeleted`) is wire-visible on reads today — internals aren't hidden from
read DTOs by default. `dataKey` is the exception: it is dropped from
`wireShape` entirely (see above), so it never reaches any read DTO either.

Cross-tenant reads of another tenant's row return **404** (existence hidden),
falling out of the filter semantics: the row simply isn't found.

## Hierarchy — the registry tree (`implements tenantRegistry`, Phase 2)

The tenant registry opts into a hierarchy by carrying `implements
tenantRegistry` — a built-in prelude capability
(`src/macros/prelude.ts`, next to `tenantOwned`). It **provides** two managed
tree fields; the author writes neither (unfold the capability to see them):

```ddd
tenancy by user.tenantId of Organization

aggregate Organization ids guid {
  name: string
  implements tenantRegistry
  // — what `implements tenantRegistry` provides —
  //   parent: Organization id?   immutable   // self-FK; null = root org
  //   dataKey: string?           managed     // the materialized path
}
```

- **`parent: Self id?`** — an immutable, nullable self-FK (`Self` resolves to
  the registry aggregate). `immutable` keeps it settable at create (the signup
  bootstrap passes it) but frozen after — **reparent is out of scope** (immutable
  paths are what make `deep` a cheap prefix scan). It lands in migrations as a
  nullable self-referential FK (`parent uuid null references organizations(id)`)
  plus an `organizations_parent_idx`.
- **`dataKey: string?`** — the managed materialized path (`data_key text null`,
  off create/update inputs, present on reads). Its **value** is computed
  server-side in the author-written `signUp` create factory via the workflow-tier
  `repo-let` on the parent (`dataKey := parent.dataKey + "." + <segment>`); a
  capability is a pure mixin, so it carries the field but cannot inject a
  repo-reading create body. Root orgs get a root-segment path; children extend
  the parent's.

Structural verification (`src/ir/validate/checks/tenancy-checks.ts`): only under
a `tenancy by` system (`loom.tenant-registry-without-tenancy`), **exactly one**
aggregate (`loom.tenancy-registry-duplicate`), and it must be the `of <Registry>`
target (`loom.tenancy-registry-not-target`). `parent`'s immutability and
self-reference are structural (the access modifier + `Self`), so neither needs a
check.

### `currentUser.orgPath` under hierarchy

`orgPath` (the P2.1 principal member) is the caller's materialized path. With no
`tenantRegistry` (flat tenancy) it is the tenancy claim itself — the
root-segment path, since there is no `dataKey` column to read. Once the registry
`implements tenantRegistry`, the principal resolves `orgPath` from the registry's
`data_key` column, **memoized per request**, keyed by the tenancy claim:

```sql
select data_key from organizations where id = <currentUser.tenantId>
```

**Fail-safe:** a missing row, a null `data_key` (pre-tree data), or any lookup
error falls back to the claim value — never null, never a crash. Wired on **all
five backends**, each through its own request-scoped principal seam:

| Backend | Registry read | Memoization |
|---|---|---|
| node (Hono/Drizzle) | boot registers `registerOrgPathResolver` (a db-backed closure — the auth layer can't reach the injected db); middleware `await`s it | once in middleware, on the request principal |
| .NET (EF Core) | `IOrgPathResolver`/`EfOrgPathResolver` (`IgnoreQueryFilters().Where(id).Select(DataKey)`), method-injected into `UserMiddleware` | scoped resolver; `user.OrgPath` slot set once per request |
| Java (Spring/JPA) | `OrgPathResolver` holder + a boot `@Component` registering a `JdbcTemplate` `SELECT data_key … WHERE id = ?` closure | per-request `ThreadLocal` memo, cleared in `UserFilter` |
| Python (FastAPI/SQLAlchemy) | Starlette middleware queries `text("SELECT data_key … WHERE id = :claim")` via the module-level `session_factory` | written once onto the frozen principal (off `asdict()`/wire) |
| Elixir (Ecto) | `put_org_path/1` reads via `Repo.one(from o in <Registry>, where: o.id == ^claim, select: o.data_key)` (schema-prefix + binary_id cast) | the plug runs once per request → memoized on the principal map |

## The `policy {}` read ladder (`local` / `deep` / `global`, Phase 2 P2.4)

A `policy {}` context member selects a per-aggregate **read reachability level**
for tenant-owned aggregates — the directional ladder from
[`proposals/authorization.md`](old/proposals/authorization.md) §3 (`Self` /
`Descendants` / `All` ≈ `local` / `deep` / `global`). It is the read side of the
hierarchy: P2.1–P2.3 wrote `dataKey`; P2.4 reads by it.

```loom
context Ledger {
  aggregate Invoice with tenantOwned { amount: Money }
  aggregate Org ids guid { name: string  implements tenantRegistry }
  // …
  policy {
    allow deep on Invoice        // caller's org + all descendant orgs
  }
}
```

Each rule rewrites the aggregate's `tenantOwned` capability filter (its
`contextFilters` entry), riding the exact per-backend query seams the flat
tenant floor already uses (Drizzle `.where`, EF `HasQueryFilter`, SQLAlchemy
conjunction, JPA `@Query`/`Specification`, pinned Ecto `where:`) — no new backend
plumbing. The levels:

| Level | Emitted scope |
|---|---|
| `local` | `tenantId == currentUser.tenantId` — the caller's own org node. **The default** (an omitted / `local` aggregate keeps today's flat floor). |
| `deep` | descendant-or-self on the materialized path: `dataKey = orgPath OR dataKey LIKE orgPath \|\| '.%'` — the caller's org and every org beneath it. |
| `global` | the caller's **root-org subtree** (P2.5): the same descendant-or-self prefix scan as `deep` but anchored at `currentUser.rootOrg` (the first `orgPath` segment) — `dataKey = rootOrg OR dataKey LIKE rootOrg \|\| '.%'`. Under flat tenancy `rootOrg == orgPath == the tenant floor`, so all three levels coincide (see the decision below). |

Generated `deep` filter, one line per backend (for `allow deep on Account`):

| Backend | Emitted predicate |
|---|---|
| node (Hono/Drizzle) | `or(and(isNotNull(t.dataKey), or(eq(t.dataKey, p.orgPath), like(t.dataKey, p.orgPath + ".%"))), and(isNull(t.dataKey), eq(t.tenantId, p.tenantId)))` |
| .NET (EF Core) | `(x.DataKey != null && (x.DataKey == u.OrgPath \|\| x.DataKey.StartsWith(u.OrgPath + "."))) \|\| (x.DataKey == null && x.TenantId == u.TenantId)` |
| Python (SQLAlchemy) | `or_(and_(R.data_key.isnot(None), or_(R.data_key == u.org_path, R.data_key.startswith(u.org_path + "."))), and_(R.data_key.is_(None), R.tenant_id == u.tenant_id))` |
| Java (JPA) | `(e.dataKey is not null and (e.dataKey = :#{…orgPath} or e.dataKey like concat(:#{…orgPath}, '.%'))) or (e.dataKey is null and e.tenantId = :#{…tenantId})` |
| Elixir (Ecto) | `fragment("(? IS NOT NULL AND (? = ? OR ? LIKE ? \|\| '.%')) OR (? IS NULL AND ? = ?)", …)` with `^`-pinned fail-closed principal |

**Three settled semantics decisions** (authorization.md §9 leaves them to P2.4):

1. **NULL-`dataKey` fallback (OR-fallback, not pure fail-closed LIKE).** Rows
   stamped before P2.3 — or by a principal-less save — carry a NULL `data_key`,
   which a bare prefix LIKE silently hides. `deep` therefore ORs in
   `dataKey IS NULL AND tenantId == currentUser.tenantId`: NULL rows degrade to
   exactly the `local` floor, staying visible to their own tenant and **never
   widening past it** (no cross-tenant leak). This preserves flat-tenancy
   correctness for legacy rows while the tree fills in.
2. **Delimiter-correct prefix.** The descendant match is `path` exactly OR
   `path || '.%'` (the `.` segment separator), so `org_a` never prefix-matches
   `org_ab`. The full opclass/`text_pattern_ops` index discipline is P2.5; the
   *correct* prefix ships here.
3. **`global` = the caller's root-org subtree (P2.5).** authorization.md §2 says
   "all in my tenant, never the whole table." Under a hierarchy `global` is the
   full **root subtree** — every org descending from the caller's *root* org —
   emitted as the same descendant-or-self prefix scan as `deep` but anchored at
   `currentUser.rootOrg` (the first `orgPath` segment) instead of `orgPath`. The
   accessor is a pure string derivation off the already-resolved `orgPath` (no
   extra DB read); every backend exposes it beside `orgPath`. Under **flat**
   tenancy every org is its own root, so `rootOrg == orgPath == the tenant floor`
   and `global == deep == local` all coincide — and `global`/`deep` still
   require a `tenantRegistry` hierarchy (`loom.policy-level-requires-hierarchy`),
   so a flat model keeps the fail-closed floor. It never leaks past the tenant
   root.

**Validation (fail closed).** `deep`/`global` need a `tenantRegistry` hierarchy
(`loom.policy-level-requires-hierarchy`); the target must be a tenant-owned
aggregate in the same context (`loom.policy-unknown-aggregate`,
`loom.policy-target-not-tenant-owned`); one level per aggregate
(`loom.policy-duplicate-target`). The minimal surface is the read ladder only —
operation/view/field gates, `deny`, and policy `function`/`let` helpers stay
later proposal work.

## Scope and roadmap

Phase 1 is flat tenancy (`local` reads — tenant-id equality). The registry
self-scope + claim-less bootstrap shipped as Phase 1b (above). The registry tree
(`implements tenantRegistry` → `parent` + managed `dataKey`) + the `orgPath`
registry read on all five backends shipped as Phase 2 P2.2 (above). Stamping
`dataKey` on every `tenantOwned` aggregate (P2.3, above) shipped too. The
`deep`/`global` `policy {}` read ladder (P2.4, above) shipped. The
materialized-path `dataKey` prefix index (`text_pattern_ops`) + the
`currentUser.rootOrg` accessor that widens `global` to the root-org subtree
shipped as P2.5 (above) — **closing multi-tenancy Phase 2**. Also shipped since:

- **The `claim`/`registry` cross-reference upgrade** (capstone decision 5) —
  the `tenancy by` bindings are now real Langium cross-references
  (`claim=[UserField:UserFieldName] 'of' registry=[Aggregate:ID]` in
  `src/language/ddd.langium`), so an unknown claim/registry is a linking error
  (with navigation/rename) rather than a themed validator code. Byte-identical
  surface.
- **`tenant_id` index** — the derived non-unique `<table>_tenant_id_idx` is
  emitted for every `tenantOwned` table (via `derive("tenant_id")` in
  `withTenantIndex`, `src/system/migrations-builder.ts`), riding the shared
  `MigrationsIR` directly like the `dataKey` prefix index — a derived,
  non-authored index that needed no `index:` surface. (Consistent with the
  `tenant_id_idx` note under `with tenantOwned` above.)
