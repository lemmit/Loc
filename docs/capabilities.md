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

- **Hono / Drizzle** — every generated `select` adds the predicate
  via `.where(...)` on top of the user's query filters.
- **.NET / EF Core** — one `HasQueryFilter(...)` per capability is
  emitted in `OnModelCreating`, applied to every entity whose
  `implements` matched.
- **Phoenix / Ash** — the predicate becomes a default scope on the
  Ash resource.

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

The stamps fire **before** validation in every backend.  Workflows
that call `aggregate.create(...)` / `aggregate.update(...)` get the
stamps too — the assignment happens inside the constructor / mutator,
so there's no path that skips them.

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

Backends translate the name by convention:

- **.NET** — adds an `I` prefix and emits a marker interface
  (`ISoftDeletable`).  One shared block per name in
  `OnModelCreating` (e.g. one `HasQueryFilter` loop for every
  `ISoftDeletable`).
- **Hono / TS** — may emit a type alias (advisory; the wire shape
  carries the field anyway).
- **Phoenix / Ash** — capability names map to Ash extensions or
  resource flags depending on the capability.

## Propagation rules

At lowering time (`lowerContext` in `src/ir/lower.ts`) the compiler
expands context-level capability members onto every aggregate in
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
