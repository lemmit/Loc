# Capabilities — `capability`, `filter`, `stamp`, `implements`

A **`capability`** is a first-class, pure-mixin declaration — a named
bundle of **fields + `filter` + `stamp`** that an aggregate opts into
with `with <Cap>` / `implements <Cap>`.  It is the typed successor to the
stringly-typed surface (`implements "X"` / `filter for "X"` /
`stamp for "X"`), which was **removed** — see
[`proposals/typed-capabilities.md`](old/proposals/typed-capabilities.md) and
[`plans/typed-capabilities-implementation.md`](old/plans/typed-capabilities-implementation.md).

```ddd
capability softDeletable {
  isDeleted: bool internal
  deletedAt: datetime? managed
  filter !this.isDeleted            // behaviour the capability provides
}

aggregate Order with softDeletable { subject: string }   // gains the field + filter
```

`softDeletable`, `auditable`, `tenantOwned`, and `versioned` ship **built in**
(the toolchain prelude, `src/macros/prelude.ts`) — available by name with nothing
declared. The `softDelete()`/`restore()` operations stay in the `softDelete`
macro (operations aren't part of a pure-mixin capability): `with softDeletable,
softDelete`. `tenantOwned` (tenant column + claim stamp + tenant read filter)
additionally requires a system-level `tenancy by` declaration — see
[`tenancy.md`](tenancy.md).

`versioned` (optimistic concurrency) adds a single `version: int token = 1`
field. Every backend's save path emits a guarded write
(`UPDATE … WHERE id = $1 AND version = $2`, bumping `version`) and returns HTTP
**409 Conflict** when zero rows match — a lost-update guard with no explicit
version handling in the domain body:

```ddd
aggregate Order with versioned { subject: string }
```

The predicate `aggregateIsVersioned()` (`src/ir/util/versioned-capability.ts`) is
the shared gate the five backend repositories and the migrations builder read.

## Surface

`filter` / `stamp` are also usable directly (the building blocks a
capability body is made of); `implements <Cap>` / `with <Cap>` apply a
capability:

| Where | What you write | Effect |
|---|---|---|
| Inside a `capability` | `<field>`, `filter <expr>`, `stamp <event> { … }` | Provided to every implementor. |
| Inside an `aggregate` | `filter <expr>`, `stamp <event> { … }`, `with <Cap>`, `implements <Cap>` | Applies to that aggregate. |
| Inside a `context` | `filter <expr>`, `stamp <event> { … }`, `with <Cap>`, `implements <Cap>` | `filter`/`stamp` propagate to **every** aggregate in the context; `with`/`implements <Cap>` apply the capability to every aggregate. |

The grammar rules are `Capability`, `FilterDecl`, `StampDecl`, and
`ImplementsDecl` in `src/language/ddd.langium`.

## `filter <expr>`

Declares a query-filter predicate the backend applies to every read
of the host aggregate.  The expression has `this` in scope and is
type-checked exactly like an invariant body.

```ddd
aggregate Order {
  isDeleted: bool
  subject: string

  filter !this.isDeleted          // every read excludes soft-deleted rows
}
```

To apply a filter to *some* aggregates in a context but not others,
bundle it in a `capability` and opt in per aggregate — the typed
replacement for the old `filter for "<name>"` string-group form:

```ddd
capability softDeletable {
  isDeleted: bool
  filter !this.isDeleted
}

context Sales {
  aggregate Order  with softDeletable { subject: string }  // gains the filter
  aggregate Public { name: string }                        // no filter
}
```

### Backend emission

All five backends — .NET, Hono, Java, Phoenix, and Python — reify
relational capability filters, both non-principal and principal-referencing
(tenancy).  Principal predicates and non-relational shapes have **since
landed** (DEBT-01 / DEBT-02): Python's relational principal case landed
(`supportsPrincipalFilter` now returns `true` for it, `system-checks.ts`) and
Python's `shape(embedded)` filters landed too (#1571 —
`supportsNonRelationalFilter`/`supportsPrincipalNonRelationalFilter` now
include `python` for `embedded`).  Principal filters on non-relational shapes
ship on node/Java (`document` + `embedded`), elixir + Python (`embedded`), and
.NET (all shapes).  What stays gated is narrow: **a capability filter on a
`shape(document)` aggregate hosted on Python** (Python wires relational +
`embedded` only; `document` is a single jsonb blob it doesn't filter in-app) —
and elixir has no `document` shape at all.  See *Deferred cases* below.

- **.NET / EF Core 10** — every aggregate that has any propagated
  `contextFilters` gets one **named** `b.HasQueryFilter("<Name>", x => …)`
  per filter inside its `EntityConfiguration.Configure(...)` method
  (EF Core 10 *named query filters*).  Names are derived from the
  reified `criterion` name (`activeOnly` → `"ActiveOnlyFilter"`) or, for
  anonymous predicates, from the single column they touch
  (`!this.isDeleted` → `"IsDeletedFilter"`), falling back to a positional
  `"Filter<n>"`.  Naming matters: pre-EF-10 a second `HasQueryFilter`
  call **silently overwrote** the first, so an aggregate carrying two
  capability filters (e.g. `softDelete` + a tenancy `filter`) lost one at
  runtime — named filters make all of them additive again, and let a
  query selectively bypass just one via `IgnoreQueryFilters(["<Name>"])`.
  Emission is per-entity-type; the filter applies to *every* query of that
  aggregate (capability application was resolved earlier, at expansion +
  lowering).  EF Core resolves the DI-scoped
  principal and queries jsonb transparently, so .NET is the one
  backend with no deferred cases.  See
  `src/generator/dotnet/emit/efcore.ts`.
- **Hono / Drizzle** — Drizzle has no global query filter, so the
  repository builder AND-s each predicate into every root-table read
  site (`src/generator/typescript/repository-find-predicate.ts`).  A
  **principal** predicate renders against the ambient
  `requireCurrentUser()` accessor (the analog of EF Core's
  DI-resolved principal); a **non-relational** aggregate filters in-app
  over the rehydrated `document`, or AND-s into the SQL read for an
  `embedded` root (whose scalars are real columns).
- **Java / Hibernate** — a static `@SQLRestriction("…")` on the
  entity for the non-principal predicate (`src/generator/java/emit/entity.ts`);
  a **principal** predicate instead AND-s a SpEL-principal JPQL clause
  (`:#{@currentUserAccessor.user()?.tenantId()}`) into the scoped
  `findAll`/`findById` overrides + finds/retrievals/views.  A
  **non-relational** aggregate filters in-app via `findAll().stream()`
  for `document`, or rides the same `@SQLRestriction` for an `embedded`
  root.
- **Phoenix / Ecto** — a `where` clause AND-ed into each generated read
  in the context module — the platform analog of `HasQueryFilter`
  (`src/generator/elixir/domain-emit.ts`).  A **principal** predicate
  renders as `where: r.<field> == ^current_user.<field>` with the current
  user threaded onto every read.  An **`embedded`** root rides the same
  `where` (its root attributes are real columns; `document` is not
  an elixir shape).

A filter that is *exactly* one named `criterion` (`filter NotDeleted`)
**reifies** rather than inlining: the IR carries the reference in
`contextFilterRefs` (index-aligned with `contextFilters`), and Hono
calls the module-level `<name>Criterion` predicate fn while Phoenix
references a shared Ecto query fragment (a `<name>_criterion/0` dynamic,
e.g. `dynamic([r], r.active)` / `dynamic([r], r.region == "EU")`) —
deduped with any find/retrieval consumers of the same criterion.  Behaviour-identical
to the inline form; only the generated code is organised around the
criterion as a first-class, reusable predicate.

### Deferred cases

One narrow case remains gated by the IR validator
(`validateContextFilterSupport`, code `loom.context-filter-unsupported`):

- **A capability filter on a `shape(document)` aggregate hosted on
  Python.**  Python wires relational + `shape(embedded)` filters
  (principal and non-principal, DEBT-01/DEBT-02, #1571) but does not
  filter a `document` blob in-app, so `supportsNonRelationalFilter` /
  `supportsPrincipalNonRelationalFilter` (`system-checks.ts`) include
  `python` for `embedded` only.  (Elixir has no `document` shape at all,
  so the case can't arise there.)

Everything else now ships (per the validator gate): a **principal**
predicate on a *relational* aggregate on all five backends (DEBT-01); a
**non-principal** predicate on a *non-relational* aggregate on node/Java
(`document` + `embedded`), elixir + Python (`embedded`), and .NET (all);
and **the principal × non-relational intersection** on node/Java
(`document` + `embedded`), elixir + Python (`embedded`), and .NET —
`supportsPrincipalNonRelationalFilter` accepts it, and the `embedded` case
is gate-verified by `embedded-tenancy.ddd` in the Java build corpus.  Host
a `document` aggregate that needs a
filter on any non-Python backend, or hand-write the predicate inside
individual `repository find` bodies, in the meantime.

## `stamp <event> { … }`

Declares lifecycle assignments to run on every create or update of
the host aggregate.  `<event>` is `onCreate` or `onUpdate`; the body
is the same `AssignOrCallStmt*` shape as an `operation` body, with
`this` in scope.

```ddd
aggregate Order {
  createdAt: datetime
  updatedAt: datetime
  createdBy: User id
  updatedBy: User id

  stamp onCreate {
    createdAt := now()
    createdBy := currentUser
  }
  stamp onUpdate {
    updatedAt := now()
    updatedBy := currentUser
  }
}
```

To apply stamps to some aggregates and not others, bundle them in a
`capability` (the built-in `auditable` is exactly this) and opt in per
aggregate with `with auditable`.

### Stamp targets are server-owned wire fields

A field assigned by any `stamp` block is server-populated at persist
time, so it is **never client input** — on create *or* update — while
staying readable everywhere:

- Enrichment promotes a stamp target that is still create-writable to
  `access: managed` (`promoteStampTargets`), which drops it from the
  create-input contract (`forCreateInput`) every backend's Create
  request DTO, the frontend api-module schema, the scaffolded
  create-form inputs, and the Playwright page-object fill derive from.
- The `crudish` `update` operation excludes stamp targets from its
  params (`writableUpdateFields`), so the Update request DTO — which is
  shaped from those params on every backend — cannot mass-assign a
  stamped column (often the very one a row-security `filter` reads).

Read surfaces (responses, views, detail/list pages) keep the field —
`managed` is readable.  Pinned cross-backend by
`test/conformance/stamp-request-no-leak-parity.test.ts`.

### Backend emission

- **.NET / EF Core** — context stamps are emitted as a
  `SaveChangesInterceptor` (`AuditableInterceptor`) registered on
  the `DbContext`.  The interceptor fires during `SaveChangesAsync`
  with a per-entity-type switch — one arm per aggregate that has
  any stamping rules — and applies the `onCreate` / `onUpdate`
  assignments based on `entry.State`.  The interceptor body
  renders through the same expression machinery operation bodies
  use, so `currentUser` / `now()` / etc. resolve normally.  See
  `src/generator/dotnet/emit/auditable-interceptor.tpl.ts`.  Note
  that this means stamps fire at *save time*, after the operation
  body has already run.
- **Java / JPA** — context stamps are emitted as entity
  `_stampOnCreate` / `_stampOnUpdate` hooks (one arm per stamping
  rule) with the service calling them on create / update; support
  is gated by `validateJavaStampSupport`.
- **Hono** (`node`) — context stamps are emitted as `_stampOnCreate` /
  `_stampOnUpdate` methods on the aggregate (`this._<field> = <value>`)
  that the route handler calls right before save.  A `now()` value renders
  to `new Date()`; a `currentUser` value resolves to the principal id
  (`currentUser.<idField>`), threaded from the request scope (the
  `auth/middleware.ts` principal).  Support is gated by
  `validateNodeStampSupport` (a principal stamp without auth, or any stamp on
  an event-sourced aggregate, stays a fail-fast `loom.node-stamp-unsupported`).
- **Python / FastAPI** — context stamps are applied right before the
  repository persist: the domain class gets `_stamp_on_create` /
  `_stamp_on_update` methods (`now()` → `datetime.now(UTC)`; a `currentUser`
  value → `current_user.id`, threaded from `request.state.current_user`) that
  the route handler calls before save.  Support is gated by
  `validatePythonStampSupport` (a principal stamp without auth, or any stamp on
  an event-sourced aggregate, stays a fail-fast `loom.python-stamp-unsupported`).
- **Phoenix** (`elixir`, plain-Ecto foundation) — context stamps
  are applied as `Ecto.Changeset.put_change` pipe lines on the changeset right
  before `Repo.insert` / `Repo.update` (threaded through the context
  `create_<agg>` / `update_<agg>` delegate into the repository).  `now()`
  renders to `DateTime.utc_now()`, and a `currentUser` value resolves to the
  principal id read off the threaded `current_user` map (`current_user.<idKey>`,
  nil-safe) — the controller pulls it from `conn.assigns.current_user` (the Auth
  plug populates it) and threads it on the write call.  `onCreate`
  stamps apply on insert only and `onUpdate` stamps apply on BOTH insert and
  update, so a NOT-NULL `updated_*` audit column is filled on the initial insert.
  The audit `createdAt`/`updatedAt` become real Ecto schema fields (replacing the
  bundled `timestamps()`), and the managed `createdBy`/`updatedBy` are excluded
  from the changeset cast.  See `src/generator/elixir/vanilla/stamp-emit.ts`.
- The elixir backend keeps the same two fail-fast cases
  (`loom.elixir-stamp-unsupported`, `validateElixirStampSupport`): a
  `currentUser` stamp on a deployable WITHOUT auth (no actor to thread), and
  stamps on an event-sourced aggregate.

## `implements <Cap>` / `with <Cap>`

Apply a capability to the host: the expander deep-clones the
capability's members (fields + `filter` + `stamp`) into the aggregate
(or, at context scope, into every aggregate in the context).  `with` and
`implements` are synonyms for this; `with` additionally drives macros.

```ddd
aggregate Order with softDeletable, auditable { subject: string }
// or, equivalently for capabilities:
aggregate Order { subject: string  implements softDeletable  implements auditable }
```

A `with`/`implements` naming neither a macro nor a declared capability
is an **error** — the existence check the old free-string form lacked.
References resolve against the expander's document-wide capability
inventory (built-ins + user `capability` declarations), not a Langium
cross-reference.

## Propagation rules

At expansion time the typed `with`/`implements <Cap>` is spliced into
the host (`src/macros/expander.ts`); at lowering time
(`src/ir/lower/lower-capabilities.ts`) context-level `filter`/`stamp`
members propagate to every aggregate in the context:

| Declaration | Applies to |
|---|---|
| `filter <expr>` at context scope | every aggregate in the context |
| `stamp <event> { … }` at context scope | every aggregate in the context |
| `with <Cap>` / `implements <Cap>` at context scope | the capability is applied to every aggregate in the context |
| `with <Cap>` / `implements <Cap>` at aggregate scope | the capability is applied to that aggregate |

## Relationship to macros

A `capability` subsumes the field/filter/stamp macros: `auditable` and
`softDeletable` are built-in capabilities, not macros.  Macros remain for
**operations and structure** — `softDelete` (operations), `crudish`,
`scaffold*`.  See [`scaffold-macros.md`](scaffold-macros.md).

## Validation rules

- A `with`/`implements` naming no macro and no declared capability is an
  error.
- A capability with no implementors is allowed (declared but unused).
- Field references inside a capability's `filter` / `stamp` body
  type-check against each implementing aggregate, so a capability whose
  `stamp onCreate { createdBy := currentUser }` assigns `createdBy`
  requires every implementor to have a `createdBy: User id` field — a
  missing field is an IR-validation error.
