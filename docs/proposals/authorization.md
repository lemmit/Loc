# Loom Authorization Model — DataKey, dataPolicy & Operation Policies

> **Status:** Partially shipped. On `main`: the `policy {}` **read ladder**
> (P2.4 — `allow local|deep|global on X`), the **write ladder** (P3.1 —
> `allow write local|deep on X`), and **named policy functions** (P3.2 —
> `requires`-gated predicates). Still proposed: field-level masking, `deny`,
> and operation/view/workflow policy gates. See §11 for the phasing.
> **Build order:** the `DataKey` + directional-ladder half is sequenced in
> [`docs/plans/multi-tenancy-phase2.md`](../plans/multi-tenancy-phase2.md) (P2.4),
> which resolves §0 option A and corrects the shared assumption that `dataKey`
> arrives as an IdP claim — it is *derived* per-request from the registry (P2.1).
> **Supersedes & consolidates:** `docs/proposals/policies-supplementary-note.md`
> and the earlier `policies.txt` working notes (not checked in).
> **Scope:** all domain-logic backends (.NET/EF Core, TypeScript/Hono,
> Phoenix on plain Ecto); React consumes the resulting wire shape only.
> **⚠ Needs reconciliation with [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md).** See [§0](#0-reconciliation-needed-with-multi-tenancy-design-note) below.
> **Companion:** [`offerability-can-query.md`](./offerability-can-query.md) — projecting the param-free slice of these gates into the pre-flight `can_<op>` query (the write-side analogue of this doc's field-capabilities projection).

---

## 0. Reconciliation needed with `multi-tenancy-design-note.md`

This proposal was drafted before
[`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) landed on
`main`. The two documents independently introduce **the same keyword
(`crossTenant`)** and **overlapping mechanisms** for tenant scoping. They are
not in conflict on intent — both want default-on isolation with an explicit
opt-out for shared reference data — but they need to be merged before either
ships to grammar. Capturing the overlap honestly so neither proposal gets
implemented in isolation:

### What overlaps

| Concern | `multi-tenancy-design-note.md` (canonical for tenancy) | This doc (§2 *DataKey & tenancy*) |
|---|---|---|
| Where the tenant claim is declared | `tenancy by user.tenantId` at `system` level | Same intent, implicit via `dataKey` claim |
| Default scoping | Tenant-scoped by default (fail closed) | Tenant floor on every reachability filter (fail closed) |
| `crossTenant` aggregate modifier | **Defined here.** Marks aggregates that aren't tenant-owned (shared reference data) | **Also defined here** with the same name and intent |
| `Tenant` registry mode | New `platform` mode (role-gated, not tenant-scoped) | Not addressed |
| Persisted column | `TenantId` (auto-stamped, indexed) | `dataKey` (materialized path, off-`wireShape`) |
| Enforcement seam (.NET) | EF `HasQueryFilter` global filter | Same seam |

The keyword collision on `crossTenant` is the urgent part — two proposals on
`main` cannot both *introduce* the same grammar token.

### What's genuinely new in this doc beyond multi-tenancy

The multi-tenancy note gives us a **flat** tenant id per row. This doc's value
on top of that is:

- **Hierarchical sub-tenant scoping** (`Self` / `Children` / `Descendants` /
  `Parent` / `Ancestors`) — a flat `TenantId` column doesn't express
  parent/child orgs, but the policies grammar leans on those directions
  heavily. `DataKey` as a materialized path (`{rootTenantId}.{parentId}.…`)
  is what makes ancestor/descendant checks pure prefix arithmetic.
- **The `policy {}` block itself** — `data {}` reachability, parameterized
  operation/view/workflow gates, field masking. None of this is in scope for
  the multi-tenancy note.

So the substantive contribution is the policy machinery; the tenancy half of
this doc was reinventing what multi-tenancy already nailed down.

### Coping options

**A. Layered (recommended).** Multi-tenancy owns the **flat** tenancy
primitive (`tenancy by`, `crossTenant`, the `tenantRegistry` registry capability,
`TenantId` column + filter, claim plumbing — note `platform` was dropped as a
scope; see the §2 reconciliation banner). This doc *consumes* those primitives and adds
`DataKey` as a **hierarchical extension**: the leftmost segment of a
`DataKey` is exactly the `TenantId` multi-tenancy already auto-stamps; the
extra segments encode org hierarchy and are only needed when a `policy {}`
references `Children`/`Descendants`/`Parent`. Single tenant feature, single
`crossTenant` keyword (defined by multi-tenancy), and `DataKey` becomes
opt-in for hierarchical scoping rather than a parallel mechanism. **§2 of
this doc is rewritten to reference multi-tenancy instead of redefining
it.** Cleanest separation of concerns and matches the existing layering
philosophy ("authorization is infrastructure").

**B. Merge into one doc.** Fold both proposals into a single
`tenancy-and-authorization.md`. Pros: no cross-doc coupling, easier to read
end-to-end. Cons: the multi-tenancy note is already on `main`; merging
means rewriting both; and the docs *do* describe separate-stage concerns
(claim plumbing vs. predicate evaluation) that benefit from staying
factored.

**C. Pick one model, drop the other.**
- *Drop `DataKey`, keep flat `TenantId`*: simpler, but the policies
  grammar's `Self`/`Children`/`Descendants` directions lose their meaning —
  org hierarchy would have to be expressed as ordinary aggregate
  relationships, with `exists` predicates instead of prefix arithmetic.
  Performance pattern changes (subquery vs. index scan on a `LIKE
  'root.parent.%'`).
- *Drop the flat `TenantId`, keep `DataKey`*: forces multi-tenancy
  consumers (who only want flat B2B isolation) to carry a path column they
  don't need, and complicates the EF global filter (path prefix check vs.
  equality check). Worse default for the common case.

**D. Coexist explicitly.** Both columns persisted (`TenantId` + `DataKey`),
both filters applied. Redundant data but trivially backward-compatible.
Likely temporary if it happens at all.

### Recommendation — RESOLVED (option A), 2026-07-04

**Adopted: option A (layered).** Build order in
[`../plans/multi-tenancy-phase2.md`](../plans/multi-tenancy-phase2.md). The
settled calls:
1. **`crossTenant` and the tenant floor belong to
   [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md)** (shipped in
   Phase 1). This doc does not define them — it cites them.
2. **`DataKey` rides the `tenantOwned` capability, not a new header.** A
   `tenantOwned` aggregate gets a `dataKey` column (like `tenantId`); flat-tenancy
   models that never declare `tenantOwned` pay nothing, and `crossTenant` /
   unscoped aggregates get no `dataKey`. This keeps the per-aggregate axis at the
   two values Phase 1 settled (`tenantOwned` / `crossTenant`) — **no third
   `hierarchical` header, no new axis.** `Descendants`/`deep` is available on any
   `tenantOwned` aggregate a `policy {}` asks it of.
3. **`DataKey`'s leftmost segment is the tenant id** — one source of truth, no
   double-stamping. `dataKey` is off the wire (a persistence column only).
4. **`currentUser`'s path is a *derived* value, not an IdP claim** — resolved
   per-request from the registry and exposed as `currentUser.orgPath` (Phase 2
   plan P2.1). It is **not** a `user {}` claim; the `claims:` map is a static
   token→field projection with no derived-value carrier (verified 2026-07-04).
5. `Self`/`Descendants`/`All` direction vocabulary compiles for `tenantOwned`
   aggregates; on an aggregate without a `dataKey` column, `Self` (≈ the flat
   `tenantId == claim` floor) is the only meaningful direction.

The sections below describe the policy block; where §2 still reads as if `DataKey`
is ambient-on-every-aggregate or an IdP claim, the calls above supersede it.

---

## Context

Loom (`loc-ddd-dsl`, CLI `ddd`) already ships *partial* authorization:

- a system-level `user {}` claim record and the `currentUser` magic identifier
  (with `permissions: string[]`),
- per-module `permissions {}` catalogues that lower to `<module>.<name>` strings,
- a `requires <expr>` gate (HTTP 403, vs. `precondition` → 400) usable as an
  operation/workflow body statement and a page prop,
- `auth: required` deployables that emit JWT-decode middleware + a verifier hook.

What it *originally* lacked was record-level access control, tenancy, and
field-level masking. Since then, **record-level access control and tenancy have
shipped** — the `tenantOwned` capability's row filter plus the `policy {}` read
(P2.4) and write (P3.1) ladders rewrite per-row query predicates on all five
backends, and named policy functions (P3.2) gate operations via `requires`. The
one piece still missing is **field-level masking**. This proposal added the
shipped layers (and describes the remaining masking work) as a coherent
extension of the existing primitives rather than duplicating them. The earlier research (the
supplementary note and the prior `policies.txt` working draft) explored a
Salesforce/Dataverse-style `dataPolicy`/`operationPolicy` split and a
function-style policy DSL; this document reconciles both into one model shaped
to Loom's actual architecture.

The design was settled collaboratively. Key reframings from the raw research:
- **DataKey is ambient infrastructure**, not opt-in; built from tenant ids.
- **Tenancy is first-class** with a hard isolation floor; `crossTenant` opts out.
- There is **no parallel `operationPolicy` block** — operation gating reuses the
  existing `requires`/`permissions` machinery, relocated into a declarative
  policy block so it stays out of domain bodies.
- Fine-grained predicates reuse **Loom's existing `where`/`exists` expression
  language** and `function`/`let` helpers — **no new `rule` keyword**.

---

## 1. Principles

1. **Authorization is infrastructure.** It lives in dedicated `policy {}` blocks;
   it is never woven into a domain operation body. The generated handler enforces
   gates *before* the pure domain body runs.
2. **Two kinds, one shared expression language.** Row **reachability** (paramless
   set-filter) and operation/view/workflow/field **gates** (parameterized
   point-checks) are distinct constructs. They share only Loom's filter
   expression language — not their semantics or evaluation.
3. **Tenancy is the floor (owned by multi-tenancy); `DataKey` is its opt-in
   hierarchical extension.** Flat tenant isolation (`tenantId == claim`) is
   Phase 1's non-negotiable floor; `crossTenant` opts out of it. `DataKey` is
   carried by the `tenantOwned` capability — present exactly where tenant data
   is — never injected on every aggregate (§0 recommendation, resolved).
4. **Reuse, don't reinvent.** `user {}`, `currentUser`, `permissions {}`,
   `function`/`let`, and the per-backend filter lowering already exist.

### Layer map

| Layer | Construct | Question | Evaluation |
|---|---|---|---|
| Identity | `DataKey` (infra) | where is this row in the tenant tree | a column, not on the wire |
| Reachability | `policy { data { … } }` | which rows may I see/edit at all | **set filter** (paramless) |
| Operation | `policy { allow … on Agg.Op }` | may I run this action on this target | **point gate** (params from the operation) |
| Field | nested `field` rules | may I see/write this column here | projection mask / write reject |

---

## 2. DataKey & tenancy

> **Reconciliation — RESOLVED 2026-07-04 (option A).** Build order in
> [`../plans/multi-tenancy-phase2.md`](../plans/multi-tenancy-phase2.md).
> [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) is **canonical**
> for the flat tenancy primitive: `tenancy by … of Organization`, the **two-value**
> scope axis `tenantOwned` / `crossTenant` (admin-only cross-tenant data is
> `crossTenant` + an authz policy), and the immutable-`parent` registry
> (`implements "tenantRegistry"`). **This section contributes only the
> hierarchical extension**: the `DataKey` materialized path + the directional
> access levels (`Self` / `Descendants` / `All`; Dynamics' `local`/`deep`/`global`
> is the same ladder) — *who may read*, an authorization concern. Do **not**
> re-introduce `crossTenant` / the flat floor here; cite the multi-tenancy note.
> **Two corrections to the older prose below** (per the Phase 2 audit): `dataKey`
> is **not** stamped "from the token" and is **not** on every aggregate — it is
> **derived per-request** from the registry and carried by the **`tenantOwned`
> capability** only.

- **Construction:** `{rootTenantId}.{parentId}.…{tenantId}` — a materialized
  path of **tenant (org) ids**. A record carries the path of its owning tenant.
  `id` identifies the record; `dataKey` scopes it. Ancestor/descendant checks are
  pure prefix arithmetic — no tree queries at runtime.
- **Carried by `tenantOwned`, off the wire.** A `dataKey` *persistence column* is
  provided by the `tenantOwned` capability (beside `tenantId`) — so it exists
  exactly where tenant data is, and `crossTenant` / unscoped aggregates get none.
  It is **kept out of `wireShape`** (never serialized) — clients deal in domain
  `id`. (Implementation note: `dataKey` is a separate `AggregateIR` flag the
  entity emitters materialize, **not** an entry in `AggregateIR.fields`.)
- **Tenant isolation floor is multi-tenancy's, not `DataKey`'s.** The flat
  `row.tenantId == currentUser.tenantId` floor (Phase 1) is the non-widenable
  base; `All`/`global` means "all in my tenant," never the whole table. `DataKey`
  only refines *within* that floor (`Self` ⊆ `Descendants` ⊆ my tenant).
- **`currentUser.orgPath` is derived, not a claim.** It is resolved per-request
  from the registry (Phase 2 plan P2.1) and memoized on the principal — **not** a
  `user {}` field. The `claims:` map is a static token→field projection with no
  derived-value carrier (verified 2026-07-04), so `dataKey`/`orgPath` cannot ride
  it.
- **Built-in `DataKey` type** with operations: `isAncestorOf`, `isDescendantOf`,
  `sameParent`, `isRoot`, `rootTenant`, `depth`. Every direction below compiles
  to these primitives, so backends emit, never re-derive.

```loom
user { id: string, permissions: string[], tenantId: guid }   // tenantId claim; orgPath is DERIVED, not declared

tenancy by user.tenantId of Organization
aggregate Invoice with tenantOwned { amount: Money }          // tenantId + dataKey via the capability
aggregate Country crossTenant { code: string, name: string }  // tenant-exempt; no dataKey
```

---

## 3. The `policy {}` block

A new `ContextMember`, one (or more, merged) per bounded context. It holds a
`data {}` section for paramless reachability and bare top-level gates for
operations/views/workflows. Reusable helpers are `function`s; locals are `let`.

```loom
policy Orders {
  // ── reusable helpers (reuse `function`; policy-scope: currentUser + resource + params)
  function isOwner(): bool = currentUser.id == resource.ownerId
  function isManager(): bool = currentUser.permissions.contains(permissions.manage)
  function canFulfill(order: Id<Order>): bool =
    exists FulfillmentTask where orderId == order
                            and operatorId == currentUser.id
                            and validUntil > now()

  // ── reachability: paramless, target = implicit row → set filter
  data {
    entities Order, Invoice
    allow read on Descendants
    allow edit on Self
    allow read on Order { status == Open }      // row-attribute clause
    allow read on Order { isOwner() }
  }

  // ── gates: parameterized point-checks; the named target brings its scope in
  allow execute on Order.FulfillLine {          // currentUser + FulfillLine params + Order resource
    isManager()
    all { qty > 0; canFulfill(order) }
  }
  allow execute on OnboardCustomer {            // workflow: currentUser + params, NO resource
    currentUser.permissions.contains(permissions.onboard)
  }
  allow read on RevenueReport {                 // view: + rows inherit data{} filtering
    currentUser.permissions.contains(permissions.finance)
    field margin { mask unless permissions.finance.full }
  }
}
```

### Rule-row grammar
`(allow | deny) <access> on <target> [ { <clause>* <field-rule>* } ]`

- **Braces delimit scope.** Bare directional grants (`allow read on Self`) have
  no scope, so no braces; any conditions or an operation target → braced.
- **Sibling clauses OR by default** — each is a *sufficient* grant condition.
  Explicit grouping with `all { … }` (AND) / `any { … }` (OR); inline `and`/`or`
  within a clause. **The validator requires an explicit `all`/`any` wrapper when
  a block mixes** conjunction and disjunction (no silent precedence).
- **`deny` wins** over `allow` (field masking, carve-outs).

### Target decides scope
| Target | In-scope identifiers | Mode |
|---|---|---|
| `Aggregate` (in `data {}`) | implicit row + `currentUser` — **paramless** | set filter |
| `Aggregate.Operation` | that operation's params + `currentUser` + **resource** | point gate |
| `View` (context-level name) | params + `currentUser`; rows still filtered by `data {}`; field masking on output | point gate + inherited filter |
| `Workflow` (context-level name) | params + `currentUser`, **no resource** | point gate |

A block's clauses may reference only the params of the operation named on its
own target line; referencing another operation's param is a validation error.

---

## 4. Helpers — reuse `function` / `let` (no new keyword)

A named policy helper *is* a `function` returning `bool`; `let` is the
local/inline binding. We reuse both rather than adding a `rule` keyword.

- A `function` **declared inside `policy {}`** is a policy predicate: its ambient
  scope is `currentUser` + `resource` + params (vs. a domain `function`'s
  `this`). Loom already does location-sensitive scoping (`currentUser` is only
  bound in certain bodies), so this is the same mechanism, not a new construct.
- Helpers **inline at lowering** into the clause `ExprIR`. This is **mandatory
  for `data {}` helpers**: a reachability clause must be SQL-translatable (EF
  query filter / RLS / Ecto query filter), and you cannot call a host method inside
  those — so `isOwner()` expands to `currentUser.id == Order.ownerId` *in the
  WHERE*.
- Collection lambdas (`.any`/`.all`/`.count`) are already in the expression
  language and usable directly in clauses. Anonymous predicates are just the
  bare expression; you reach for a `function` only to name/reuse it.
- Validator: cycle detection (`canEdit → isOwner`), structural field-compat per
  attachment site, and a `function`/`let` referencing `resource` is attachable
  only where a resource is in scope (e.g. not on create-style operations or
  workflows).

The one relaxation needed: today the validator forbids `currentUser` in
`function` bodies — policy-block functions must permit it (driven by the
policy Env).

---

## 5. Field rules

Nested in read/edit blocks:
`field <name> { mask unless <expr> | deny read | write(<expr>) | readonly when <expr> }`

- **`mask unless <expr>` / `deny read`** → the field is **redacted** in the read
  DTO (not a 403), applied at DTO projection time. This is the only
  `wireShape`-adjacent effect; React must tolerate a redacted value.
- **`write(<expr>)` / `readonly when <expr>`** → 403 on that field, checked
  **only when the field was supplied** in a partial update (`if cmd.field.isSet`).
- Optional **aggregate-field baseline** (`salary: Money mask unless
  permissions.salary.unmask`) for "sensitive everywhere," refined per-operation.

---

## 6. permissions {} — vocabulary (+ `implies`)

Unchanged catalogue (`permissions { read, edit, … }` → `<module>.<name>`),
checked against `currentUser.permissions`. Add optional **`implies`**:

```loom
permissions { read, edit implies read, approve implies edit, finance.read }
```

`implies` = a precomputed transitive closure at lowering; the runtime check
stays a flat membership test. Referenced anywhere as `permissions.<name>`.

---

## 7. Relations

Three cases, by **where the relationship lives** — no generic relation
subsystem:

1. **On the record** (FK/collection) → a plain clause:
   `customerId == currentUser.id` / `currentUser.id in careTeam`.
2. **A domain aggregate** (assignment, fulfillment, membership) →
   `exists <Aggregate> where …`. Temporal access ("for a while") is just a
   field: `validUntil > now()`. The domain aggregate *is* the relation store.
3. **Ad-hoc shares** → model an ordinary `Share` aggregate and query it the same
   way (typed, CRUD, UI, audit for free).

The earlier draft's generic `PolicyRelation` table is **dropped** — it added a
parallel subsystem without the benefits of a real aggregate. (Optional later
sugar: `principal is X of resource` over a named relation, lowering to the same
`exists`.)

---

## 8. Runtime composition

```
read:  tenant floor ∩ data{} reachability ∩ query filter(call params)  → field mask
write: operation gate(currentUser, params, resource) ∩ tenant/edit scope ∩ field write rules → domain body
```

`deny` overrides. `data {}` **never sees call params** — params drive the query
and the gate, which compose *with* the reachability floor (intersection). This
keeps `data {}` implementable as an EF global query filter / Postgres RLS / an
Ecto query-scope predicate: a stable per-entity predicate parameterized only by session/user, so
"can this user see this row?" has one stable answer.

---

## 9. Settled defaults (open to revision in review)

- **Baseline reachability (no policy declared): the shipped flat floor** —
  `tenantId == claim`. This is `All`-within-tenant (every row in the caller's
  tenant), matching Phase 1's shipped behavior. A **Strict Self** default (caller
  sees only their own org node) is the safer hierarchical posture, but flipping
  the baseline is a *behavior change from shipped flat tenancy* — so it is a
  reviewed decision at P2.4, not a silent default. For a flat model the two
  coincide (every org is root ⇒ `Self` == the whole tenant).
- **`dataKey` exists only on `tenantOwned` aggregates** — `crossTenant` / unscoped
  get no `dataKey` column (supersedes the earlier "`crossTenant` = keep-key",
  which assumed a column on every aggregate).
- **Tenant root = fixed segment 0** (`rootTenant`).
- **`implies`** lands as an independent later phase.
- **Explicit `all`/`any`** required only on mixed (AND+OR) blocks.

---

## 10. Codebase grounding (reuse vs. net-new)

Verified by exploration; cited so the proposal is concrete, not aspirational.

### Reusable as-is
- **`function`/`let` lowering** is scope-agnostic (Env-threaded): `lowerFunction`
  `src/ir/lower.ts:1309`. Pass a policy-Env (currentUser + resource + params)
  instead of aggregate `this`.
- **`currentUser`**: resolution `src/ir/lower-expr.ts:496`; `UserIR`
  `src/ir/loom-ir.ts:429`; detection `exprUsesCurrentUser`
  `src/ir/loom-ir.ts:1007`; per-backend threading as a trailing param
  (`findUsesCurrentUser`, `src/platform/hono/v4/routes-builder.ts:401`,
  `src/generator/dotnet/templates/repository.tpl.ts`).
- **Aggregate header modifier** (`ids guid`): grammar `ddd.langium:427`, IR
  `AggregateIR.idValueType`, lowering `lower.ts:958` — `crossTenant` mirrors this.
- **Cross-aggregate type resolution** for `exists`: reuse `stepInto`
  (`lower-expr.ts:879`), `idFollowPath`/`collectIdFollows`/`findEntityByName`
  (`lower.ts:1138-1237`) — full-form views already follow `Id<X>` into other
  aggregates.
- **`requires` → 403** semantics (`lower-expr.ts:200`, `docs/auth.md`) — informs
  gate failure (relocated out of the domain body into `policy {}`).

### Net-new (well-scoped)
- **`policy` context member**: extend `ContextMember` (`ddd.langium:407`),
  `BoundedContextIR`, a `lowerPolicy`, and `checkPolicy` in
  `src/language/ddd-validator.ts` (sibling to `checkContext`/`checkDeployable`).
- **`function` inside `policy {}`** + **`currentUser` allowed in those bodies**
  (a policy-context relaxation of the current validator rule).
- **`DataKey` built-in type** + member ops in `src/language/type-system.ts`
  (registered like string/collection ops at `type-system.ts:307/348`).
- **Ambient `dataKey` column off `wireShape`**: a separate `AggregateIR` flag;
  each entity emitter adds the column. `wireShape` build `enrichments.ts:176`;
  contract artifact `src/system/wire-spec.ts`.
- **`exists <Aggregate> where …` quantifier**: reuses view *resolution* but is
  otherwise net-new (views *project* via bulk-load + map lookup; a policy
  *tests existence* in a filter). Requires: a new `ExprIR` kind
  (`{ kind: "exists"; aggregate; predicate }`), a third validator context
  (queryable + aggregate-jump allowed, unlike `find` filters which reject it —
  `src/ir/validate.ts:606`), and per-backend EXISTS rendering:
  - .NET: `.Any(x => …)` subquery — `dotnet/render-expr.ts`, `find-emit.ts:36`.
  - Hono: Drizzle `exists(...)` subquery — `repository-builder.ts:847`.
  - Phoenix/Ecto: an `Ecto.Query` `where exists(subquery)` clause —
    `elixir/repository-emit.ts`.

### Enforcement seams per backend
- **.NET/EF Core:** global query filter in `renderConfiguration`
  (`templates/efcore.tpl.ts`, add `HasQueryFilter`); write guard in repository
  `SaveAsync` or a `SaveChangesInterceptor` (`templates/repository.tpl.ts`);
  handler pre-check in `cqrs.tpl.ts` (inject `ICurrentUserAccessor`, already
  emitted by `auth-emit.ts`); field mask in `dto-mapping.ts:projectToResponse`.
- **TS/Hono:** row filter in `repository-builder.ts` (`lowerToDrizzle` →
  `.where()`); gate in route handlers (`templates/routes.tpl.ts`); mask in
  `toWireMethod`.
- **Phoenix/Ecto:** apply the reachability predicate as an `Ecto.Query` scope
  on every read in `repository-emit.ts`, and a guard in the context/command
  modules (not emitted today); `current_user` already threaded.
- **React:** consumes redacted wire shape + optional view `fieldCapabilities`.
- **Platform contract:** `src/platform/surface.ts` (`emitProject`), registry
  `src/platform/registry.ts`.

---

## 11. Implementation phasing (items 1–2 shipped; 3–7 still proposed)

> Sequenced against [`../plans/multi-tenancy-phase2.md`](../plans/multi-tenancy-phase2.md):
> that plan's P2.1–P2.3 deliver the `DataKey` infra (item 1 below); this doc's
> `policy {}` machinery is P2.4 onward. **Shipped through P3.2** — see
> [`docs/plans/authorization-phase3.md`](../plans/authorization-phase3.md) (P3.1
> write ladder) and [`authorization-phase3-2.md`](../plans/authorization-phase3-2.md)
> (P3.2 named policy functions).

1. **DataKey infra (= Phase 2 plan P2.1–P2.3) — SHIPPED.** The `DataKey` derived
   `currentUser.orgPath` keystone (per-request, not a claim) and the `dataKey`
   column carried by the `tenantOwned` capability (off `wireShape`). `crossTenant`
   + the flat floor are Phase 1 (also shipped).
2. **`policy {}` reachability — SHIPPED (read + write ladders + named fns).** The
   `allow local|deep|global on X` read ladder (P2.4), the `allow write local|deep`
   write ladder (P3.1), and named policy functions (P3.2) landed on all five
   backends — the ladders ride the existing `contextFilters`/`writeScopeFilter`
   seams, the named fns inline into the `requires` gate. (Field masking — item 6 —
   is the deferred remainder.)
3. **Operation/view/workflow gates** → handler pre-checks (403); relocate
   gating out of domain bodies. *(Still proposed.)*
4. **TS/Hono + Phoenix/Ecto parity** for phases 2–3.
5. **`exists <Aggregate>` quantifier** (reuse view resolution + new EXISTS
   rendering) for domain-relationship and `Share`-aggregate access.
6. **Field rules** (mask/write) + partial-update gating + wire-spec/capabilities.
7. **`implies`** (independent); audit decision-id + sensitivity-lint seams.

---

## 12. Verification

This is design-only; no build/test run applies. Quality bars for the document:
- Every "reuse" claim cross-checked against the cited `file:line` — the proposal
  must not assert reuse the code doesn't support (the `exists` delta is honestly
  labelled net-new).
- The four worked DSL examples (DataKey, `data {}`, operation gate with `exists`,
  field mask) are shaped against the current grammar vocabulary (`currentUser`,
  `permissions.<name>`, `Id<X>`).
- Each backend has a named enforcement seam for each layer (row filter / gate /
  mask), per §10.

When implementation begins (phase 1+), gates are:
`npm run langium:generate && npm run build`, `npm test`, and at least one
`LOOM_TS_BUILD=1` run for generator drift.
