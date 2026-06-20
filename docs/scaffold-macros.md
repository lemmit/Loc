# Macros — `scaffold`, `crudish`, `softDelete`

Macros are compile-time `with <name>(...)` clauses that splice
declarations into the host AST before lowering.  They expand to
ordinary DSL constructs you could have written by hand — every macro
documents its **source-equivalent**.

The stdlib ships three families:

- **Scaffolding** — `scaffold`, `scaffoldSubdomain`, `scaffoldContext`,
  `scaffoldAggregate`, `scaffoldWorkflow`, `scaffoldView`.
  Synthesise UI pages from a domain.
- **CRUDish** — `crudish`.  Adds a generated `update(...)` operation
  to an aggregate.
- **Cross-cutting capabilities** — `softDelete` /
  `softDeleteByDefault`.  Add soft-delete behaviour via
  the [capability surface](capabilities.md).  (Audit is no longer a
  macro — it ships as the builtin `capability auditable`; see below.)

Macros are applied with `with <macro>(<args>)` on the host
declaration:

```ddd
aggregate Order with crudish {
  subject: string
  implements "auditable"               // builtin capability, not a macro
}

context Sales with softDeleteByDefault {
  aggregate Order { subject: string }
}

ui WebApp {
  with scaffold(subdomains: [Sales])
}
```

The full grammar of `with` is in [`language.md`](language.md).
The expansion happens in AST phase ② (see
[`technical.md`](technical.md)); the macros' implementations live
under `src/macros/stdlib/`.

## `scaffold` family

The scaffold family synthesises pages for one or more domain elements.
It's composable end-to-end: the top-level `scaffold` fans out to
per-element composers, which fan out to leaf macros.

| Macro | Target | What it emits |
|---|---|---|
| `scaffold(subdomains:, contexts:, aggregates:, workflows:, views:)` | `ui` | Home / Workflows-index / Views-index singletons + invokes the composers below. |
| `scaffoldSubdomain(of: S)` | `ui` | One `scaffoldContext` per context in subdomain `S`. |
| `scaffoldContext(of: C)` | `ui` | One `scaffoldAggregate` / `scaffoldWorkflow` / `scaffoldView` per member of context `C`. |
| `scaffoldAggregate(of: Agg)` | `ui` | A List page, a New (create-form) page, and a Detail page for `Agg`. |
| `scaffoldWorkflow(of: W)` | `ui` | A Form page for workflow `W`. |
| `scaffoldView(of: V)` | `ui` | A List page for view `V`. |

`scaffoldAggregate`, `scaffoldWorkflow`, and `scaffoldView` are the
**leaves** — they don't invoke other macros.  Everything else is a
composer that delegates via `invokeMacro`.

### Composability

Unfolding one level on `with scaffold(subdomains: [Sales])` reveals one
`with scaffoldSubdomain(of: Sales)` per supplied subdomain.  Unfolding *that*
reveals per-context composers, then per-aggregate / workflow / view
leaves.  Users can drill into a single aggregate's scaffold without
flattening the whole UI.

The leaves all delegate page-shape decisions to `pagesForAggregate`
/ `pageForWorkflow` / `pageForView` in `src/macros/stdlib/scaffold/_pages.ts`
— so all six macros agree on what a "list page" looks like.

## `crudish`

`with crudish` on an aggregate adds a generated `update(...)`
operation whose parameters are one per writable user field, and whose
body assigns each parameter to the matching field.

```ddd
aggregate Order with crudish {
  subject: string
  total: decimal
}
```

Source-equivalent:

```ddd
aggregate Order {
  subject: string
  total: decimal

  operation update(subject: string, total: decimal) {
    this.subject := subject
    this.total := total
  }
}
```

"Writable user field" means a property whose access modifier admits
external writes (see [`language.md`](language.md) for the access
modifier matrix).  `managed` / `token` / `internal` / `secret`
fields are skipped; `editable` and `immutable` (on aggregates only)
fields participate.

`create` and `delete` are **deferred** until input-type synthesis
lands.  Today, `crudish` only emits `update`.

## Audit — now the builtin `capability auditable`

> **Removed as macros.** `audit` / `auditable` / `auditedByDefault`
> no longer exist as macros.  Audit ships as the **builtin
> `capability auditable`** declared in `src/macros/prelude.ts` — apply
> it directly via the capability surface (`implements "auditable"` +
> the prelude's `filter` / `stamp` rules) rather than a `with`
> clause.  See [`capabilities.md`](capabilities.md).

The capability adds the four canonical audit fields (`createdAt`,
`updatedAt`, `createdBy: User id`, `updatedBy: User id`) and the
context-level stamping rules:

```ddd
context Sales {
  stamp for "auditable" onCreate {
    createdAt := now()
    createdBy := currentUser
  }
  stamp for "auditable" onUpdate {
    updatedAt := now()
    updatedBy := currentUser
  }

  aggregate Order {
    subject: string
    createdAt: datetime
    updatedAt: datetime
    createdBy: User id
    updatedBy: User id
    implements "auditable"
  }
}
```

Why keep fields and stamps separate?  The stamping rules are a
*context-level* concern — they assign the same fields the same way
for every audited aggregate — while the field declarations and the
`implements "auditable"` opt-in are *per-aggregate*.  See
[`capabilities.md`](capabilities.md) for the underlying surface.

## `softDelete` / `softDeleteByDefault`

Capability group: `"softDeletable"`.  The **state + filter** ship as
the builtin `capability softDeletable` (`isDeleted` + `deletedAt?` +
`filter !this.isDeleted`, co-located in `src/macros/prelude.ts`); the
`softDelete` **macro** adds only the two **operations**.  A capability
is a pure mixin, so compose them: `with softDeletable, softDelete`.

| Macro / capability | Target | What it adds |
|---|---|---|
| `softDeletable` (builtin **capability**) | aggregate | `isDeleted: bool`, `deletedAt: datetime?`, and the `!this.isDeleted` read filter. **No operations.** |
| `softDelete` (**macro**) | aggregate | The `softDelete()` and `restore()` mutations. **No state/filter** — pair it with the capability. |
| `softDeleteByDefault` (**macro**) | context | Invokes `softDelete` on every child aggregate. |

The filter is a *context-level* concern carried by the builtin
capability; the operations are *per-aggregate* (added by `softDelete`).

### Source-equivalent

```ddd
context Sales {
  aggregate Order with softDeletable, softDelete { subject: string }
  aggregate Public { name: string }            // not soft-deletable
}
```

↓

```ddd
context Sales {
  // filter for "softDeletable" !this.isDeleted  — carried by the builtin capability

  aggregate Order {
    subject: string
    isDeleted: bool
    deletedAt: datetime?

    operation softDelete() {
      this.isDeleted := true
      this.deletedAt := now()
    }
    operation restore() {
      this.isDeleted := false
      this.deletedAt := null
    }

    implements "softDeletable"
  }

  aggregate Public { name: string }
}
```

`Public` does not `implements "softDeletable"` and therefore the
capability-scoped filter doesn't apply — reads of `Public` are
unfiltered.

## Authoring a macro

Macros are TS modules under `src/macros/stdlib/<name>/` that default-export
a `defineMacro({...})` call.  Each macro declares:

```ts
defineMacro({
  name: "<macro-name>",
  target: "ui" | "context" | "aggregate" | …,
  apiVersion: 1,
  description: "<one-line>",
  expand({ target, args, invokeMacro, /* helpers */ }) {
    // Inspect `target` (the host AST node) and return AST fragments
    // to splice in.  Use `invokeMacro` to delegate to other macros.
  },
});
```

The `macro-api` (`src/macros/api/`) exposes typed AST factory helpers
(`operation`, `param`, `primType`, `boolLit`, `callExpr`, …) and
inspection utilities (`writableUpdateFields`, `viewsIn`,
`workflowsIn`, `aggregatesIn`).  Anything you can write by hand in
`.ddd` source, a macro can produce.

## Cross-references

- [`capabilities.md`](capabilities.md) — the `filter` / `stamp` /
  `implements` surface the builtin `auditable` capability and the
  `softDelete` macro target.
- [`page-metamodel.md`](page-metamodel.md) — the page DSL the
  scaffold macros emit.
- [`language.md`](language.md) — the `with <macro>(...)` clause and
  access modifiers consulted by `crudish`.
- [`technical.md`](technical.md) — phase ② macro expansion and how
  it sits relative to scope/link and lowering.
