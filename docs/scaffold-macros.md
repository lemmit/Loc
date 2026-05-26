# Macros — `scaffold`, `crudish`, `audit`, `softDelete`

Macros are compile-time `with <name>(...)` clauses that splice
declarations into the host AST before lowering.  They expand to
ordinary DSL constructs you could have written by hand — every macro
documents its **source-equivalent**.

The stdlib ships three families:

- **Scaffolding** — `scaffold`, `scaffoldModule`, `scaffoldContext`,
  `scaffoldAggregate`, `scaffoldWorkflow`, `scaffoldView`.
  Synthesise UI pages from a domain.
- **CRUDish** — `crudish`.  Adds a generated `update(...)` operation
  to an aggregate.
- **Cross-cutting capabilities** — `audit` / `auditable` /
  `auditedByDefault`, `softDelete` / `softDeletable` /
  `softDeleteByDefault`.  Add audit and soft-delete behaviour via
  the [capability surface](capabilities.md).

Macros are applied with `with <macro>(<args>)` on the host
declaration:

```ddd
aggregate Order with crudish, auditable {
  subject: string
}

context Sales with softDeleteByDefault {
  aggregate Order { subject: string }
}

ui WebApp {
  with scaffold(modules: [Sales])
}
```

The full grammar of `with` is in [`language.md`](language.md).
The expansion happens in AST phase ② (see
[`technical.md`](technical.md)); the macros' implementations live
under `src/stdlib/`.

## `scaffold` family

The scaffold family synthesises pages for one or more domain elements.
It's composable end-to-end: the top-level `scaffold` fans out to
per-element composers, which fan out to leaf macros.

| Macro | Target | What it emits |
|---|---|---|
| `scaffold(modules:, contexts:, aggregates:, workflows:, views:)` | `ui` | Home / Workflows-index / Views-index singletons + invokes the composers below. |
| `scaffoldModule(of: M)` | `ui` | One `scaffoldContext` per context in module `M`. |
| `scaffoldContext(of: C)` | `ui` | One `scaffoldAggregate` / `scaffoldWorkflow` / `scaffoldView` per member of context `C`. |
| `scaffoldAggregate(of: Agg)` | `ui` | A List page, a New (create-form) page, and a Detail page for `Agg`. |
| `scaffoldWorkflow(of: W)` | `ui` | A Form page for workflow `W`. |
| `scaffoldView(of: V)` | `ui` | A List page for view `V`. |

`scaffoldAggregate`, `scaffoldWorkflow`, and `scaffoldView` are the
**leaves** — they don't invoke other macros.  Everything else is a
composer that delegates via `invokeMacro`.

### Composability

Unfolding one level on `with scaffold(modules: [Sales])` reveals one
`with scaffoldModule(of: Sales)` per supplied module.  Unfolding *that*
reveals per-context composers, then per-aggregate / workflow / view
leaves.  Users can drill into a single aggregate's scaffold without
flattening the whole UI.

The leaves all delegate page-shape decisions to `pagesForAggregate`
/ `pageForWorkflow` / `pageForView` in `src/stdlib/scaffold/_pages.ts`
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

## `audit` / `auditable` / `auditedByDefault`

Capability group: `"auditable"`.  Adds the four canonical audit
fields and the stamping rules.

| Macro | Target | What it emits |
|---|---|---|
| `auditable` | aggregate | Adds `createdAt`, `updatedAt`, `createdBy: User id`, `updatedBy: User id` properties + `implements "auditable"`.  Carries **no stamping rules**. |
| `audit` | context | Adds `stamp for "auditable" onCreate { … }` and `stamp for "auditable" onUpdate { … }` to the context.  Carries **no fields**. |
| `auditedByDefault` | context | Composes `audit` on the context AND `auditable` on every child aggregate. |

Why split fields and stamps?  Because the stamping rules are a
*context-level* concern — they assign the same fields the same way
for every audited aggregate — while the field declarations are
*per-aggregate* (the macro that declares them can be applied
selectively).  See [`capabilities.md`](capabilities.md) for the
underlying surface.

### Source-equivalents

```ddd
context Sales with audit {
  aggregate Order with auditable {
    subject: string
  }
}
```

↓

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

`auditedByDefault` is the shortest form for "apply this to every
aggregate":

```ddd
context Sales with auditedByDefault { aggregate Order { … }; aggregate Invoice { … } }
```

…is equivalent to the long form above for both aggregates.

## `softDelete` / `softDeletable` / `softDeleteByDefault`

Capability group: `"softDeletable"`.  Adds the soft-delete columns,
mutations, and filter.

| Macro | Target | What it emits |
|---|---|---|
| `softDeletable` | aggregate | Adds `isDeleted: bool`, `deletedAt: datetime?`, the `softDelete()` and `restore()` mutations, and `implements "softDeletable"`.  Carries **no filter**. |
| `softDelete` | context | Adds `filter for "softDeletable" !this.isDeleted` to the context.  Carries **no fields**. |
| `softDeleteByDefault` | context | Composes `softDelete` on the context AND `softDeletable` on every child aggregate. |

The split mirrors `audit` / `auditable` — the filter is a
*context-level* concern, the fields and mutations are *per-aggregate*.

### Source-equivalent

```ddd
context Sales with softDelete {
  aggregate Order with softDeletable { subject: string }
  aggregate Public { name: string }            // not soft-deletable
}
```

↓

```ddd
context Sales {
  filter for "softDeletable" !this.isDeleted

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

Macros are TS modules under `src/stdlib/<name>/` that default-export
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

The `macro-api` (`src/macro-api/`) exposes typed AST factory helpers
(`operation`, `param`, `primType`, `boolLit`, `callExpr`, …) and
inspection utilities (`writableUpdateFields`, `viewsIn`,
`workflowsIn`, `aggregatesIn`).  Anything you can write by hand in
`.ddd` source, a macro can produce.

## Cross-references

- [`capabilities.md`](capabilities.md) — the `filter` / `stamp` /
  `implements` surface the audit and softDelete macros target.
- [`page-metamodel.md`](page-metamodel.md) — the page DSL the
  scaffold macros emit.
- [`language.md`](language.md) — the `with <macro>(...)` clause and
  access modifiers consulted by `crudish`.
- [`technical.md`](technical.md) — phase ② macro expansion and how
  it sits relative to scope/link and lowering.
