# Capabilities — `filter`, `stamp`, `implements`

The three capability declarations let you express *cross-aggregate
behaviours* — soft-delete, audit, tenant-scoping — once at the
context level and have them apply to every aggregate that opts in.
They are the hand-written equivalent of what the audit / softDelete
macros produce; the source surface is identical because the macros
just emit these nodes.

## Surface

Capability members live at three positions in the AST:

| Where | What you write | Effect |
|---|---|---|
| Inside an `aggregate` | `filter <expr>`, `stamp <event> { … }`, `implements "<name>"` | Applies to that aggregate only. |
| Inside a `context` (without `for`) | `filter <expr>`, `stamp <event> { … }`, `implements "<name>"` | Propagates to **every** aggregate in the context at lowering time. |
| Inside a `context` (with `for "<name>"`) | `filter for "<name>" <expr>`, `stamp for "<name>" <event> { … }` | Propagates only to aggregates whose `implements "<name>"` matches. |

The grammar rules are `FilterDecl`, `StampDecl`, and `ImplementsDecl`
in `src/language/ddd.langium`.

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

At context scope with `for "<capability>"`, the filter is *capability-
scoped*: it only applies to aggregates that opted into the capability
group.  This is the canonical soft-delete pattern:

```ddd
context Sales {
  filter for "softDeletable" !this.isDeleted

  aggregate Order {
    isDeleted: bool
    implements "softDeletable"    // opts in — receives the filter
  }

  aggregate Public {
    name: string                  // does NOT implement "softDeletable" — no filter
  }
}
```

### Backend emission

- **.NET / EF Core** — every aggregate that has any propagated
  `contextFilters` gets one `b.HasQueryFilter(x => …)` per filter
  inside its `EntityConfiguration.Configure(...)` method.  Emission
  is per-entity-type (EF Core's `HasQueryFilter` is per-entity by
  design); the filter applies to *every* query of that aggregate
  regardless of whether the aggregate names a capability via
  `implements` — the capability-grouping step happened earlier, in
  the lowerer's propagation pass.  See
  `src/generator/dotnet/emit/efcore.ts`.
- **Hono / Drizzle** and **Phoenix / Ash** — context filters are
  **not yet wired through the query layer**.  The IR carries
  `contextFilters` on every aggregate, but the Drizzle repository
  builder and the Phoenix Ecto schemas don't currently consume
  them, so soft-delete is enforced only on `dotnet` deployables.
  Hand-writing the predicate inside individual `repository find`
  bodies (or as a per-aggregate `filter` in the source) covers the
  same ground in the meantime.

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

`stamp for "auditable" onCreate { … }` at context scope propagates
only to aggregates that `implements "auditable"`.  See the
[`audit`](scaffold-macros.md#audit--auditable--auditedbydefault)
macro for the macro-generated equivalent.

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
- **Hono** and **Phoenix** — context stamps are **not yet wired
  through to runtime**.  The IR carries `contextStamps` on every
  aggregate but the Drizzle and Ecto codegens don't consume them.
  Hand-writing the stamps inside operation bodies (or using the
  `audit` macro under .NET-only deployment) is the workaround.

## `implements "<name>"`

Opts the host aggregate into a capability group.  The name is a free
string; the only contract is that **the same name used in
`filter for "<name>"` / `stamp for "<name>"` declarations selects
this aggregate**.

```ddd
aggregate Order {
  subject: string
  implements "softDeletable"
  implements "auditable"
}
```

The IR records `implements` names on the aggregate (the
`implementsCapabilities` field) and uses them at lowering time to
decide which context-scope `filter for "<name>"` / `stamp for
"<name>"` declarations propagate onto this aggregate.  After
propagation the `implements` list is informational — none of the
current backends compile it to marker interfaces, type aliases, or
runtime tags.  It survives in the IR for tooling (validators, diff
tools) and for future capability-aware backend logic.

## Propagation rules

At lowering time (`lowerContext` in `src/ir/lower/lower.ts`, with the
filter/stamp/implements collection in `src/ir/lower/lower-capabilities.ts`)
the compiler expands context-level capability members onto every aggregate in
that context, subject to the `for` filter:

| Declaration | Applies to |
|---|---|
| `filter <expr>` at context scope | every aggregate in the context |
| `filter for "X" <expr>` at context scope | every aggregate in the context that `implements "X"` |
| `stamp <event> { … }` at context scope | every aggregate in the context |
| `stamp for "X" <event> { … }` at context scope | every aggregate in the context that `implements "X"` |
| `implements "X"` at context scope | every aggregate in the context (rare; the macros use it) |

A capability-scoped declaration with no matching `implements` is
silently a no-op — that's the design.  Soft-delete on a context with
mixed aggregates (`Order` opts in; `PublicCatalog` doesn't) is the
canonical case.

## Relationship to macros

The capability nodes are not a separate machinery — they are the
**target shape** the audit / softDelete macros expand into.  See
[`scaffold-macros.md`](scaffold-macros.md) for the macros and the
exact source-equivalents.  Hand-writing `filter for …` /
`stamp for …` / `implements` covers every case the macros do plus
arbitrary user-defined capability groups the macros don't know
about.

## Validation rules

- An `implements "<name>"` whose name doesn't match any
  `filter for "<name>"` / `stamp for "<name>"` is allowed (it's a
  marker the user can extend later).
- A `filter for "<name>"` / `stamp for "<name>"` with no aggregate
  implementing the name is allowed (capability is "armed" but
  inactive).
- Field references inside `filter` / `stamp` bodies type-check
  against the propagation target, not the declaring scope — so a
  context-scope `stamp for "auditable" onCreate { createdBy :=
  currentUser }` requires every `implements "auditable"` aggregate
  to declare a `createdBy: User id` field.  A missing field is an
  IR-validation error.
