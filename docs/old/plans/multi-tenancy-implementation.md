# Multi-tenancy — implementation plan (Phase 1a)

> Status: **Phases 1a (#1634) and 1b (#1654 — registry self-scope + bootstrap
> + cross-references) SHIPPED; 1b-tail IN PROGRESS (claimed on this branch)** —
> 1b-tail = the derived `tenant_id` index on every `tenantOwned` table
> (unblocked by #1648's `IndexShape` machinery; every tenant read prefixes on
> that column) + the tenantOwned claim-type gate (a `guid` claim against the
> capability's `tenantId: string` field mis-compiles typed backends — error
> with a suggested fix until the capability learns claim-typed fields).
> Original 1a plan text follows.
>
> Original status: plan — awaiting sign-off on the surface below. Derived from
> [`docs/old/proposals/multi-tenancy-design-note.md`](../proposals/multi-tenancy-design-note.md)
> (R1–R5 controlling) via a state audit + design review on `main` @ `bb043de`
> (2026-07-03). Review verdict: **GO WITH CHANGES** — the changes are recorded
> here and in §5. All generated fragments below are **real output** from today's
> substrate (the hand-written equivalent of `tenantOwned` run through
> `generate system`), except where marked *extrapolated*.

## 0. Verdicts from the audit

- **Surface: not started.** No `tenancy`/`tenantOwned`/`crossTenant`/`tenantRegistry`/`dataKey`
  in grammar or IR; no in-flight PR overlaps.
- **Substrate: shipped, 5/5 backends.** Principal-referencing capability filters
  (`this.tenantId == currentUser.tenantId`) are wired on all five backends
  (`system-checks.ts` — the design note's "wired on .NET only / gate T2.j" is stale;
  T2.j is drained). Typed capabilities live in `src/macros/prelude.ts`
  (`buildAuditable`/`buildSoftDeletable`) — *not* `src/macros/stdlib/audit/`
  (CLAUDE.md drift). Capability fields flow into migrations automatically.
- **One real substrate bug found (blocks 1a on two backends):** a *claim-valued*
  lifecycle stamp (`tenantId := currentUser.tenantId`) is mis-emitted on **node**
  and **java**. Node collapses ANY `currentUser`-using stamp value to
  `ctx.actorId` (`src/generator/typescript/emit/audit-stamp.ts:51`) — it stamps
  the principal's *id*, while the read filter compares
  `requireCurrentUser().tenantId`, so created rows are invisible to every read.
  Java maps any principal stamp to `@CreatedBy`/`@LastModifiedBy`
  (`AuditorAware<UUID>` — the actor id again; `src/generator/java/emit/entity.ts` ~290).
  Implementation found it worse than audited: **.NET was broken too** — the
  interceptor emitted `currentUser.TenantId` with no `currentUser` binding in
  scope (doesn't compile), and **elixir** claim stamps lacked the bare-path's
  nil-guard. Only **python** was correct as-is. Same bug family as the
  `ownerStamped` finding in the 2026-07 DDD review (PR #1631). Fixed as slice
  **1a.0** (node, java, dotnet, elixir + pin tests on all five).

## 1. What you write (the Phase-1a surface)

```ddd
system Billder {
  user { id: guid  email: string  tenantId: string }

  tenancy by user.tenantId of Organization      // claim + registry, one line

  subdomain Billing {
    context Catalog {
      aggregate Plan crossTenant { code: string  monthlyPrice: decimal }   // shared reference data — no filter
    }
    context Invoicing {
      aggregate Invoice with tenantOwned { number: string  amountDue: decimal }
      aggregate Customer with tenantOwned { name: string  email: string }
    }
    context Accounts {
      aggregate Organization { name: string  active: bool = true }        // the registry — named in `of`, verified, no scope marker
    }
  }

  deployable api { platform: node  contexts: [Catalog, Invoicing, Accounts]  auth: required  ... }
}
```

`with tenantOwned` is an ordinary prelude capability — **unfold** shows exactly
what it attaches (the anti-magic story):

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

### What gets rejected (the safety story)

| Source | Diagnostic | Severity |
|---|---|---|
| unmarked `aggregate Shipment { … }` under a `tenancy by` system | `loom.tenancy-stance-unmarked` — "aggregate 'Shipment' declares no tenancy stance; add `with tenantOwned` (tenant data) or `crossTenant` (shared data)" | **error** |
| `tenancy by user.orgId of …` when `user {}` has no `orgId` | linking error — `Could not resolve reference to UserField named 'orgId'.` (real `[UserField:UserFieldName]` cross-reference since 1b.1; formerly `loom.tenancy-unknown-claim`) | error |
| `of Organization` when no such aggregate exists | linking error — `Could not resolve reference to Aggregate named 'Organization'.` (real `[Aggregate:ID]` cross-reference since 1b.1; formerly `loom.tenancy-registry-unknown`) | error |
| two `tenancy by` declarations | `loom.tenancy-duplicate` | error |
| `with tenantOwned` but no `tenancy by` in the system | `loom.tenant-owned-without-tenancy` | error |
| `crossTenant` but no `tenancy by` | `loom.cross-tenant-without-tenancy` (intent declared, nothing to opt out of) | warning |
| `aggregate X crossTenant with tenantOwned` | `loom.tenancy-conflicting-stance` | error |
| the `of`-target itself marked `crossTenant` or `with tenantOwned` | `loom.tenancy-registry-marked` (the registry is self-keyed; neither marker fits) | error |

The registry (`of`-target) is **exempt** from the stance lint — it is
self-keyed; neither marker fits it (see the proposal's R1). In Phase 1a it gets
**no generated behavior** — named, verified singular, done. Who-may-read/edit it
is authorization's job.

## 2. What you get (real generated output)

All fragments below were generated on today's `main` from the hand-written
equivalent (scratchpad sim, `generate system`, node + dotnet deployables).

**node (Hono/Drizzle)** — every repository read AND-s the tenant filter; the
migration carries the column; `internal` keeps the field out of create inputs:

```ts
// db/repositories/invoice-repository.ts (real)
async all(): Promise<Invoice[]> {
  const rootRows = await this.db.select().from(schema.invoices)
    .where(eq(schema.invoices.tenantId, requireCurrentUser().tenantId));
  ...
}
```

```sql
-- db/migrations/20260101000000_billing_initial.sql (real)
CREATE TABLE invoices (
  id UUID NOT NULL, number TEXT NOT NULL, amount_due INTEGER NOT NULL,
  tenant_id TEXT NOT NULL, PRIMARY KEY (id)
);
```

```ts
// http/invoice.routes.ts (real) — the client can never pass tenantId
const CreateInvoiceRequest = z.object({ number: z.string(), amountDue: z.coerce.number().int() });
```

The node stamp today (real, **the 1a.0 bug**): `stampInsert` returns
`{ ...row, tenantId: ctx.actorId }` — wrong value; after 1a.0 it reads the
ambient principal's claim (`requireCurrentUser().tenantId`-equivalent, guarded
for non-request saves).

**.NET (EF Core)** — a real global query filter + save interceptor (both real):

```csharp
// Infrastructure/Persistence/Configurations/InvoiceConfiguration.cs
builder.HasQueryFilter("TenantIdFilter", x => x.TenantId == RequestContext.Current!.CurrentUser!.TenantId);

// Infrastructure/Persistence/AuditableInterceptor.cs
case Invoice e:
    if (entry.State == EntityState.Added)
        ctx.Entry(e).Property(x => x.TenantId).CurrentValue = currentUser.TenantId;
```

**elixir / python / java** — same pipeline (verified by the audit via the
`tenancy-filter.ddd` / `embedded-tenancy.ddd` corpus gates): elixir pipes a
fail-closed `^(current_user && current_user.tenant_id)` match into every Ecto
read; python adds the SQLAlchemy `.where(...)`; java composes the JPA
specification. Java's *stamp* is the other half of 1a.0.

**Frontends:** zero work — enforcement is server-side; `tenantId` never appears
in create forms. (It does appear in read responses today, like `softDeletable`'s
`isDeleted` — see fork (e) in §5.)

### Behavioural sketch (*extrapolated — see fork (d)*)

`test e2e` has **no principal-switching surface today**; the generated dev-stub
verifier accepts per-request claim overrides via the base64
`x-loom-dev-claims` header, which is enough for a harness-level isolation test
without new DSL syntax:

```
POST /api/invoices   (claims {tenantId:"org-a"})   → 201, id X
GET  /api/invoices/X (claims {tenantId:"org-b"})   → 404   ← the leak test
GET  /api/invoices   (claims {tenantId:"org-b"})   → 200, X absent
```

Phase 1a ships this as a conformance-fixture assertion (all 5 backends via the
docker conformance leg), not as new `test e2e` grammar.

## 3. The slices

**1a.0 — stamp-claim groundwork (bug fix, no new surface).**
Fix claim-valued lifecycle stamps on node (`audit-stamp.ts`: render
`currentUser.<member>` stamp values from the ambient principal instead of
collapsing to `ctx.actorId`; keep bare `currentUser` → actor id) and java
(claim-valued stamps can't ride `@CreatedBy` — emit a lifecycle-hook arm
reading the request principal instead). Pin tests on elixir/python/dotnet that
`x := currentUser.<claim>` renders the member access. This also fixes a slice
of #1631's `ownerStamped` P0.

**1a.1 — grammar + IR.** `TenancyDecl` as a `SystemMember`
(`'tenancy' 'by' 'user' '.' claim=ID 'of' registry=ID` — the `user.` prefix is
fixed, not a general ref); `crossTenant?='crossTenant'` flag on the `Aggregate`
header (the `isAbstract` pattern); `npm run langium:generate` + commit;
print-structural arms for both (print-completeness gates); lower to
`TenancyIR { claimField, registryName }` on `SystemIR` + `crossTenant: boolean`
on `AggregateIR`.

**1a.2 — the `tenantOwned` prelude capability.** Third entry in
`src/macros/prelude.ts` next to `buildAuditable`/`buildSoftDeletable`:
`field("tenantId", primType("string"), { access: "internal" })` +
`contextStamp({ onCreate: [{ field: "tenantId", value: memberAccess(nameRef("currentUser"), "tenantId") }] })` +
`contextFilter(eq(memberAccess(thisRef(), "tenantId"), memberAccess(nameRef("currentUser"), "tenantId")))`.
Verify capability unfold works via `unfold-macro.ts` (audit flags it may only
offer registry macros — fix if so).

**1a.3 — validation.** AST: `src/language/validators/tenancy.ts` (duplicate
decl, claim-field-exists — mirror `validators/auth.ts`). IR:
`src/ir/validate/checks/tenancy-checks.ts` leaf (registry exists/singular,
stance lint, without-tenancy errors, conflicting stance) + a derived
`classifyTenantStance(agg, system)` in `src/ir/util/` (the `classifyPage`
pattern — **no stamped scope enum on AggregateIR**). Stable `loom.*` codes per
the table in §1 (diagnostic-codes gate).

**1a.4 — tests, fixtures, docs.** Parsing + negative validator tests; prelude
expansion test; migration-column assertion; a `tenancy-owned.ddd` corpus
fixture next to `tenancy-filter.ddd` (+ manifest row, conformance); the
cross-tenant isolation e2e (§2); `docs/tenancy.md` + `docs/capabilities.md` +
proposal status flip; fix the CLAUDE.md `src/macros/stdlib/audit/` drift.

**1b (follow-up, separate PR):**

- **1b.2 — SHIPPED: registry self-scope filter + claim-less bootstrap**
  (capstone decision 4). Enrichment (`applyRegistrySelfScope` in
  `src/ir/enrich/enrichments.ts`, the auto-`findAll` analog) derives
  `this.id == currentUser.<claim>` onto the registry's `contextFilters`
  (origin `tenancy` — `src/ir/util/tenant-stance.ts`), riding the shipped
  5-backend principal-filter pipeline. The id-vs-claim type link is option C:
  same-typed compares directly; a `string` claim against `ids guid` binds as
  a guid at each backend's accessor site (pg text-param cast on
  node/elixir/python; `new <Agg>Id(Guid.Parse(...))` in the .NET
  `HasQueryFilter`; `e.id.value = :#{… T(java.util.UUID).fromString(…) …}`
  null-guarded SpEL on java); anything else is
  `loom.tenancy-claim-type-mismatch` (error). No `ignoring`-bypass needed for
  bootstrap — filters never gate creates and the registry has no stamp, so
  the claim-less/foreign-claim `POST /<registries>` works by construction
  (proven per backend by the create-path pin tests + the extended
  `test/e2e/tenancy-isolation.test.ts` runtime gate, which also asserts the
  signup round-trip: create org → use its id as the claim → 200).
  Compile-verified on all five: dotnet (`dotnet build /warnaserror`, sdk:10.0
  container), java (`gradle testClasses`), python (`ruff` + `mypy --strict`),
  node (generated-project `tsc --noEmit` + the runtime e2e), elixir
  (`mix compile --warnings-as-errors` on the new
  `vanilla-tenancy-registry.ddd` fixture — which also exposed and fixed a
  pre-existing vanilla bug: an onCreate-only principal stamp left the update
  seam's threaded `current_user` unused, failing `--warnings-as-errors`; the
  param is now underscored when no `onUpdate` stamp reads it).
- **Shipped since (1b):** the **`registry`/`claim` cross-reference upgrade** —
  the bindings are now real Langium cross-references
  (`registry=[Aggregate:ID]`, `claim=[UserField:UserFieldName]` in
  `src/language/ddd.langium`), so an unknown claim/registry is a linking error
  with navigation/rename, not a bare `ID` (consistent with the §1 table's
  "real cross-reference since 1b.1" rows). Byte-identical surface. The
  `tenant_id` index also shipped — a derived non-unique `<table>_tenant_id_idx`
  is emitted for every `tenantOwned` table (`derive("tenant_id")` in
  `withTenantIndex`, `src/system/migrations-builder.ts`), riding the shared
  `MigrationsIR` directly (no `index:` surface needed). See the design-note
  **"Final recommendation"** section (decision 5) for the cross-ref rationale
  and why it stays compatible with R1 (registry remains a system-level fact,
  not a per-aggregate marker).

**Phase 2 (unblock plan drafted — see
[`multi-tenancy-phase2.md`](./multi-tenancy-phase2.md)):** `tenantRegistry`
capability (`parent: Self id?` + managed `dataKey`), hierarchy + `deep`/`global`
levels. The Phase 2 plan resolves the blocks below: the two hard ones (session
`orgPath`, stamp-time registry read) collapse to a single keystone — a
per-request-memoized computed principal value `currentUser.orgPath` — and the
capstone's "no placeholder `dataKey`" rule is preserved (it is stamped only once
the real `orgPath` exists). Original blocker analysis retained below.
Blocked on session enrichment (`orgPath` is derived, not an IdP claim —
`AuthIR.claims` is pure projection today) and on `authorization.md` (owns the
access-level ladder). Contra the note's R5 letter ("dataKey from day one"):
day-one `dataKey` is **unimplementable** on current substrate — no `orgPath`
source, and stamps cannot express the registry's `parent.dataKey ‖ "." ‖ id`
read. The trade: enabling hierarchy later costs a mechanical backfill migration
(derivable because `parent` is immutable). Do NOT stamp a placeholder
`dataKey := tenantId` — a column that silently goes wrong when the first
sub-org appears is worse than none.

## 4. File slice × analog (Phase 1a)

| Phase | Files | Analog |
|---|---|---|
| ① grammar | `ddd.langium` SystemMember + Aggregate flag; regenerate | `UserBlock`/`AuthBlock`; `isAbstract` |
| ② prelude | `src/macros/prelude.ts` | `buildSoftDeletable` (filter) + `buildAuditable` (principal stamp) |
| ④ AST validate | `validators/tenancy.ts` + `index.ts` + `ddd-validator.ts` | `validators/auth.ts` (`loom.auth-unknown-claim-field`) |
| print | `print/print-structural.ts` two arms | any SystemMember arm |
| ⑤ lower | `loom-ir.ts` (`TenancyIR`, `crossTenant`); `lower.ts` or small `lower-tenancy.ts` leaf | `AuthIR` in `lower-platform.ts` |
| ⑦ IR validate | `checks/tenancy-checks.ts` + `validate.ts` wire + `src/ir/util/tenant-stance.ts` | principal-filter gate loop (`system-checks.ts:1185`); `classifyPage` |
| ⑧ emit | **1a.0 only**: `typescript/emit/audit-stamp.ts`, `java/emit/entity.ts` | dotnet's interceptor (the correct shape) |
| tests | `test/language/{parsing,validation}/tenancy*`, `test/macro/`, `test/ir/`, `test/generator/{hono,java,…}/stamp-claim*`, corpus fixture | `tenancy-filter.ddd` |

Zero frontend work; zero migration-builder work (columns flow from the
capability field); no new `ExprIR` kinds (filter/stamp exprs are existing
shapes riding `renderExprWith`).

## 5. Open forks (recommendations applied unless overridden)

- **(a) `dataKey` now vs Phase 2** — **Phase 2** (see §3; R5's letter is
  unimplementable today; honoring its constraints, not its schedule).
- **(b) `crossTenant` vs `tenantless` naming** — **keep `crossTenant`**
  (keyword shared with `authorization.md`; renaming later breaks two features).
- **(c) Stance-lint severity** — **error, no knob.** No severity-config surface
  exists; the escape hatch is writing `crossTenant` (one keyword). A
  warning-downgrade knob is its own future feature.
- **(d) Cross-tenant e2e surface** — **no new `test e2e` grammar in 1a**;
  harness-level dev-claims test in the conformance leg. A DSL-level
  `as { tenantId: … }` actor clause is a separate proposal.
- **(e) `tenantId` in read responses** — today an `internal` field still
  appears in `wireShape`/read DTOs (so does `isDeleted`). Phase 1a keeps that
  (consistent with `softDeletable`); hiding internals from the wire is a
  cross-capability change, out of scope here.
